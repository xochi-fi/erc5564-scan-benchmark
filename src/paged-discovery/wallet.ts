import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { ERC5564AnnouncerAbi, type AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { decodeEventLog, type Hex } from 'viem';
import { z } from 'zod';
import { SDK_COMMIT, SDK_VERSION, type Engine, type MemorySnapshot, type Recipient } from '../shared/model.ts';
import { announcementIdentity, scanAnnouncements } from '../shared/worker.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER, readManifest } from './chain.ts';
import {
  SCHEMA_VERSION,
  expectedFileSchema,
  scanCacheSchema,
  walletOptionsSchema,
  type CacheMatch,
  type ChainStats,
  type PageRecord,
  type ScanCache,
  type WalletOptions,
  type WalletSample,
} from './model.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface RpcCallResult<T> {
  result: T;
  requestBodyBytes: number;
  responseBodyBytes: number;
  /** Request sent until the response body is fully received. */
  fetchMs: number;
  /** JSON.parse of the response body. */
  parseMs: number;
}

/** Minimal JSON-RPC client that reports body bytes and separates transfer from parsing. */
export class RpcClient {
  private nextId = 1;

  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown[], schema: z.ZodType<T>): Promise<RpcCallResult<T>> {
    const id = this.nextId;
    this.nextId += 1;
    const body = encoder.encode(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const start = performance.now();
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const fetched = performance.now();
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}: ${decoder.decode(bytes).slice(0, 200)}`);
    const envelope = z.object({
      jsonrpc: z.literal('2.0'),
      id: z.literal(id),
      result: z.unknown().optional(),
      error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
    }).passthrough().parse(JSON.parse(decoder.decode(bytes)));
    if (envelope.error !== undefined) throw new Error(`${method}: RPC error ${envelope.error.code}: ${envelope.error.message}`);
    const parsed = schema.safeParse(envelope.result);
    if (!parsed.success) throw new Error(`${method}: unexpected result shape`, { cause: parsed.error });
    const parseMs = performance.now() - fetched;
    return { result: parsed.data, requestBodyBytes: body.byteLength, responseBodyBytes: bytes.byteLength, fetchMs: fetched - start, parseMs };
  }
}

const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/);
export const rawLogSchema = z.object({
  address: hexString,
  blockHash: hexString,
  blockNumber: hexString,
  data: hexString,
  logIndex: hexString,
  removed: z.boolean().optional(),
  topics: z.array(hexString),
  transactionHash: hexString,
  transactionIndex: hexString,
}).passthrough();
export type RawLog = z.infer<typeof rawLogSchema>;
export const rawLogsSchema = z.array(rawLogSchema);
const quantitySchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const receiptSchema = z.object({
  status: z.string(),
  blockHash: hexString,
  blockNumber: hexString,
  transactionHash: hexString,
  logs: z.array(rawLogSchema),
}).passthrough().nullable();

/** Decodes raw RPC logs into the SDK's AnnouncementLog shape (as the SDK's own getAnnouncements does). */
export function decodeAnnouncements(logs: RawLog[]): AnnouncementLog[] {
  return logs.map((log) => {
    const decoded = decodeEventLog({
      abi: ERC5564AnnouncerAbi,
      eventName: 'Announcement',
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    return {
      address: log.address as Hex,
      blockHash: log.blockHash as Hex,
      blockNumber: BigInt(log.blockNumber),
      data: log.data as Hex,
      logIndex: Number(BigInt(log.logIndex)),
      removed: log.removed ?? false,
      topics: log.topics as [Hex, ...Hex[]],
      transactionHash: log.transactionHash as Hex,
      transactionIndex: Number(BigInt(log.transactionIndex)),
      caller: decoded.args.caller,
      ephemeralPubKey: decoded.args.ephemeralPubKey,
      metadata: decoded.args.metadata,
      schemeId: decoded.args.schemeId,
      stealthAddress: decoded.args.stealthAddress,
    };
  });
}

/** ETH metadata: viewTag(1) | 0xeeeeeeee(4) | 0xeeee...(20) | amount(32). */
export function ethAmountFromMetadata(metadata: Hex): bigint {
  const hex = metadata.slice(2);
  if (hex.length < 114) throw new Error('metadata too short for ETH');
  if (hex.slice(2, 10).toLowerCase() !== 'eeeeeeee' || hex.slice(10, 50).toLowerCase() !== 'ee'.repeat(20)) {
    throw new Error('metadata is not an ETH transfer');
  }
  return BigInt(`0x${hex.slice(50, 114)}`);
}

export interface VerificationResult {
  match: CacheMatch;
  networkMs: number;
  localMs: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
}

// Check successful receipt inclusion and enough ETH at the stealth address.
export async function verifyCandidate(client: RpcClient, announcement: AnnouncementLog): Promise<VerificationResult> {
  if (announcement.transactionHash === null || announcement.logIndex === null || announcement.blockHash === null || announcement.blockNumber === null) {
    throw new Error('candidate announcement lacks an on-chain identity');
  }
  const receipt = await client.call('eth_getTransactionReceipt', [announcement.transactionHash], receiptSchema);
  const balance = await client.call('eth_getBalance', [announcement.stealthAddress, 'latest'], quantitySchema);
  const localStart = performance.now();
  const value = receipt.result;
  if (value === null) throw new Error(`no receipt for ${announcement.transactionHash}`);
  if (value.status !== '0x1') throw new Error(`receipt status ${value.status} for ${announcement.transactionHash}`);
  if (value.blockHash.toLowerCase() !== announcement.blockHash.toLowerCase() || BigInt(value.blockNumber) !== announcement.blockNumber) {
    throw new Error(`receipt block differs from announcement for ${announcement.transactionHash} (reorg?)`);
  }
  const included = value.logs.some(log =>
    Number(BigInt(log.logIndex)) === announcement.logIndex &&
    log.address.toLowerCase() === announcement.address.toLowerCase() &&
    log.data.toLowerCase() === announcement.data.toLowerCase() &&
    log.topics.length === announcement.topics.length &&
    log.topics.every((topic, i) => topic.toLowerCase() === announcement.topics[i]?.toLowerCase()));
  if (!included) throw new Error(`announcement log not found in receipt ${announcement.transactionHash}`);
  const amount = ethAmountFromMetadata(announcement.metadata);
  const held = BigInt(balance.result);
  if (held < amount) throw new Error(`stealth address ${announcement.stealthAddress} holds ${held}, announced ${amount}`);
  const localMs = performance.now() - localStart + receipt.parseMs + balance.parseMs;
  return {
    match: {
      identity: announcementIdentity(announcement),
      blockNumber: Number(announcement.blockNumber),
      transactionHash: announcement.transactionHash,
      logIndex: announcement.logIndex,
      stealthAddress: announcement.stealthAddress,
      amountWei: amount.toString(),
    },
    networkMs: receipt.fetchMs + balance.fetchMs,
    localMs,
    requestBodyBytes: receipt.requestBodyBytes + balance.requestBodyBytes,
    responseBodyBytes: receipt.responseBodyBytes + balance.responseBodyBytes,
  };
}

async function writeCache(path: string, cache: ScanCache): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(cache));
  await rename(temporary, path);
}

export async function readCache(path: string): Promise<ScanCache | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  return scanCacheSchema.parse(JSON.parse(text));
}

export interface SyncParams {
  client: RpcClient;
  recipient: Recipient;
  engine: Engine;
  pageBlocks: number;
  startBlock: number;
  cachePath: string;
  cache: ScanCache | null;
}

export interface SyncResult {
  cache: ScanCache;
  fromBlock: number;
  headBlock: number;
  newMatches: CacheMatch[];
  pages: PageRecord[];
  timings: Omit<WalletSample['timings'], 'pageFetchMsP50' | 'pageFetchMsP95' | 'pageFetchMsMax'>;
  requests: WalletSample['requests'];
  bytes: Omit<WalletSample['bytes'], 'wireUplink' | 'wireDownlink' | 'wireConnections'>;
}

// Fetch, scan, verify and checkpoint one block page at a time.
export async function syncWallet(params: SyncParams): Promise<SyncResult> {
  const { client, recipient, engine, pageBlocks, cachePath } = params;
  const t0 = performance.now();
  const head = await client.call('eth_blockNumber', [], quantitySchema);
  const headBlock = Number(BigInt(head.result));
  const headMs = head.fetchMs;
  const cache: ScanCache = params.cache === null
    ? { schemaVersion: SCHEMA_VERSION, spendingPublicKey: recipient.spendingPublicKey, startBlock: params.startBlock, lastScannedBlock: params.startBlock - 1, matches: [] }
    : { ...params.cache, matches: [...params.cache.matches] };
  if (cache.spendingPublicKey !== recipient.spendingPublicKey) throw new Error('scan cache belongs to a different recipient');
  const fromBlock = cache.lastScannedBlock + 1;
  const pages: PageRecord[] = [];
  const newMatches: CacheMatch[] = [];
  let decodeMs = head.parseMs;
  let getLogsMs = 0;
  let scanMs = 0;
  let verifyNetworkMs = 0;
  let verifyLocalMs = 0;
  let checkpointMs = 0;
  let firstCandidateMs: number | null = null;
  let firstVerifiedMs: number | null = null;
  const bytes = { getLogsRequestBody: head.requestBodyBytes, getLogsResponseBody: head.responseBodyBytes, verifyRequestBody: 0, verifyResponseBody: 0, maxPageResponseBody: 0 };
  const requests = { getLogs: 0, blockNumber: 1, receipts: 0, balances: 0 };

  for (let pageStart = fromBlock; pageStart <= headBlock; pageStart += pageBlocks) {
    const pageEnd = Math.min(pageStart + pageBlocks - 1, headBlock);
    const fetched = await client.call('eth_getLogs', [{
      address: ANNOUNCER,
      topics: [ANNOUNCEMENT_TOPIC],
      fromBlock: `0x${pageStart.toString(16)}`,
      toBlock: `0x${pageEnd.toString(16)}`,
    }], rawLogsSchema);
    requests.getLogs += 1;
    const decodeStart = performance.now();
    const announcements = decodeAnnouncements(fetched.result);
    const pageDecodeMs = performance.now() - decodeStart + fetched.parseMs;
    const scanStart = performance.now();
    const candidates = await scanAnnouncements(announcements, recipient, engine, 0);
    const pageScanMs = performance.now() - scanStart;
    if (candidates.length > 0 && firstCandidateMs === null) firstCandidateMs = performance.now() - t0;
    let pageVerifyMs = 0;
    for (const candidate of candidates) {
      const verified = await verifyCandidate(client, candidate);
      requests.receipts += 1;
      requests.balances += 1;
      verifyNetworkMs += verified.networkMs;
      verifyLocalMs += verified.localMs;
      pageVerifyMs += verified.networkMs + verified.localMs;
      bytes.verifyRequestBody += verified.requestBodyBytes;
      bytes.verifyResponseBody += verified.responseBodyBytes;
      newMatches.push(verified.match);
      cache.matches.push(verified.match);
      if (firstVerifiedMs === null) firstVerifiedMs = performance.now() - t0;
    }
    const checkpointStart = performance.now();
    cache.lastScannedBlock = pageEnd;
    await writeCache(cachePath, cache);
    const pageCheckpointMs = performance.now() - checkpointStart;

    getLogsMs += fetched.fetchMs;
    decodeMs += pageDecodeMs;
    scanMs += pageScanMs;
    checkpointMs += pageCheckpointMs;
    bytes.getLogsRequestBody += fetched.requestBodyBytes;
    bytes.getLogsResponseBody += fetched.responseBodyBytes;
    bytes.maxPageResponseBody = Math.max(bytes.maxPageResponseBody, fetched.responseBodyBytes);
    pages.push({
      fromBlock: pageStart,
      toBlock: pageEnd,
      logs: announcements.length,
      requestBodyBytes: fetched.requestBodyBytes,
      responseBodyBytes: fetched.responseBodyBytes,
      fetchMs: fetched.fetchMs,
      decodeMs: pageDecodeMs,
      scanMs: pageScanMs,
      matches: candidates.length,
      verifyMs: pageVerifyMs,
      checkpointMs: pageCheckpointMs,
    });
  }
  const totalMs = performance.now() - t0;
  const networkMs = headMs + getLogsMs;
  const verifyMs = verifyNetworkMs + verifyLocalMs;
  return {
    cache,
    fromBlock,
    headBlock,
    newMatches,
    pages,
    requests,
    bytes,
    timings: {
      totalMs,
      networkMs,
      headMs,
      getLogsMs,
      decodeMs,
      scanMs,
      verifyMs,
      verifyNetworkMs,
      verifyLocalMs,
      checkpointMs,
      otherMs: totalMs - networkMs - decodeMs - scanMs - verifyMs - checkpointMs,
      firstCandidateMs,
      firstVerifiedMs,
    },
  };
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

export async function environmentProvenance(): Promise<Record<string, unknown>> {
  const names = ['@scopelift/stealth-address-sdk', '@noble/secp256k1', 'viem', 'zod'];
  const dependencies: Record<string, string> = {};
  for (const name of names) {
    const pkg = z.object({ name: z.string(), version: z.string() })
      .parse(JSON.parse(await readFile(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')));
    if (pkg.name !== name) throw new Error(`installed package name mismatch for ${name}`);
    dependencies[name] = pkg.version;
  }
  if (dependencies['@scopelift/stealth-address-sdk'] !== SDK_VERSION) {
    throw new Error(`Installed SDK version must be ${SDK_VERSION}, received ${dependencies['@scopelift/stealth-address-sdk']}`);
  }
  const processors = cpus();
  const sha = async (relative: string): Promise<string> =>
    createHash('sha256').update(await readFile(new URL(relative, import.meta.url))).digest('hex');
  return {
    bun: Bun.version,
    bunRevision: Bun.revision,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: processors[0]?.model ?? 'unknown',
    logicalCpus: processors.length,
    totalMemoryBytes: totalmem(),
    lockfileSha256: await sha('../../bun.lock'),
    sourceSha256: {
      'src/worker.ts': await sha('../shared/worker.ts'),
      'src/paged-discovery/wallet.ts': await sha('./wallet.ts'),
      'src/paged-discovery/chain.ts': await sha('./chain.ts'),
      'src/paged-discovery/link.ts': await sha('./link.ts'),
    },
    dependencies,
  };
}

async function chainStats(controlUrl: string): Promise<ChainStats> {
  const response = await fetch(new URL('stats', controlUrl));
  if (!response.ok) throw new Error(`control stats: HTTP ${response.status}`);
  return (await response.json()) as ChainStats;
}

/** One measured wallet sync in this (fresh) process, verified outside the timers. */
export async function runWallet(options: WalletOptions): Promise<WalletSample> {
  const environment = await environmentProvenance();
  const manifest = await readManifest(options.fixtureDir);
  const expected = expectedFileSchema.parse(JSON.parse(await readFile(options.expectedPath, 'utf8')));
  if (expected.fixtureSha256 !== manifest.fixtureSha256) throw new Error('expected-identity file is for a different fixture');
  const recipient: Recipient = {
    spendingPublicKey: manifest.recipient.spendingPublicKey as Hex,
    viewingPrivateKey: manifest.recipient.viewingPrivateKey as Hex,
  };
  if (options.scenario !== 'catchup') await rm(options.cachePath, { force: true });
  const cache = await readCache(options.cachePath);
  if (options.scenario === 'catchup' && cache === null) throw new Error('catchup requires an existing scan cache');
  const cachedMatchesAtStart = cache?.matches.length ?? 0;
  const client = new RpcClient(options.rpcUrl);

  const before = await chainStats(options.controlUrl);
  Bun.gc(true);
  const memoryBeforeSync = memorySnapshot();
  const cpuStart = process.cpuUsage();
  const result = await syncWallet({
    client,
    recipient,
    engine: options.engine,
    pageBlocks: options.pageBlocks,
    startBlock: options.startBlock,
    cachePath: options.cachePath,
    cache,
  });
  const cpu = process.cpuUsage(cpuStart);
  const processLifetimePeakRssBytes = process.resourceUsage().maxRSS * 1024;
  const memoryAfterSync = memorySnapshot();
  const after = await chainStats(options.controlUrl);

  // Exact ordered identity verification, outside every timer.
  const expectedToHead = expected.matches.filter(match => match.blockNumber <= result.headBlock);
  assertMatchIdentities(result.cache.matches, expectedToHead.map(match => match.identity));
  const expectedNew = expectedToHead.filter(match => match.blockNumber >= result.fromBlock);
  assertMatchIdentities(result.newMatches, expectedNew.map(match => match.identity));
  const persisted = await readCache(options.cachePath);
  if (persisted === null || persisted.lastScannedBlock !== result.headBlock) throw new Error('scan cache was not checkpointed to head');
  assertMatchIdentities(persisted.matches, expectedToHead.map(match => match.identity));

  const blocksScanned = Math.max(0, result.headBlock - result.fromBlock + 1);
  const fetchTimes = result.pages.map(page => page.fetchMs);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'phase2-wallet',
    scenario: options.scenario,
    engine: options.engine,
    pageBlocks: options.pageBlocks,
    pageAnnouncements: options.pageBlocks * 128,
    profile: options.profile,
    repetition: options.repetition,
    count: manifest.count,
    matchEvery: manifest.matchEvery,
    seed: manifest.seed,
    fixtureSha256: manifest.fixtureSha256,
    sdkVersion: SDK_VERSION,
    sdkCommit: SDK_COMMIT,
    fromBlock: result.fromBlock,
    headBlock: result.headBlock,
    blocksScanned,
    announcementsScanned: result.pages.reduce((sum, page) => sum + page.logs, 0),
    cachedMatchesAtStart,
    newMatches: result.newMatches.length,
    totalMatches: result.cache.matches.length,
    requests: result.requests,
    timings: {
      ...result.timings,
      pageFetchMsP50: percentile(fetchTimes, 0.5),
      pageFetchMsP95: percentile(fetchTimes, 0.95),
      pageFetchMsMax: fetchTimes.length === 0 ? null : Math.max(...fetchTimes),
    },
    bytes: {
      ...result.bytes,
      wireUplink: after.link.uplinkBytes - before.link.uplinkBytes,
      wireDownlink: after.link.downlinkBytes - before.link.downlinkBytes,
      wireConnections: after.link.connections - before.link.connections,
    },
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    memoryBeforeSync,
    memoryAfterSync,
    processLifetimePeakRssBytes,
    chainRssBytes: after.rssBytes,
    pages: result.pages,
    verified: true,
    environment,
  };
}

/** Same exact ordered comparison as the shared assertMatches, on cached identities. */
export function assertMatchIdentities(actual: CacheMatch[], expected: string[]): void {
  if (actual.length !== expected.length) {
    throw new Error(`Match count mismatch: expected ${expected.length}, received ${actual.length}`);
  }
  actual.forEach((match, index) => {
    if (match.identity !== expected[index]) {
      throw new Error(`Match identity mismatch at position ${index}: expected ${expected[index]}, received ${match.identity}`);
    }
  });
}

if (import.meta.main) {
  try {
    const argument = Bun.argv[2];
    if (argument === undefined || Bun.argv.length !== 3) throw new Error('Expected one JSON wallet-options argument');
    const sample = await runWallet(walletOptionsSchema.parse(JSON.parse(argument)));
    process.stdout.write(`${JSON.stringify(sample)}\n`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
