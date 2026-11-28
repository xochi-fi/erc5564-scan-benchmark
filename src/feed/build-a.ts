// Feed A: full-history pages from two keyless sources per chain, retrieved with the chain-volume
// pager. A page is published only when both sources return identical rows for it.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Transport } from '../chain-volume/http.ts';
import { retrieveHistory, type RetrieveOptions, type RetrieveResult } from '../chain-volume/retrieve.ts';
import { rpc, rpcLogSchema, type RpcLog } from '../chain-volume/rpc.ts';
import {
  buildPages, checkManifest, FORMAT, manifestSchema, PAGE_BLOCKS, pagePath, pageRanges, rowFromLog, sha256,
  type Manifest, type PageEntry, type Row,
} from './format.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';
import type { Source } from './sources.ts';

export interface ChainTarget { key: string; chainId: number; deployBlock: number; pageBlocks?: number; maxBlock?: number }
export interface BuildOptions {
  feed: string; transport: Transport; chains: ChainTarget[]; sources: Record<string, [Source, Source]>;
  outDir: string; seedDir?: string; workDir?: string; maxRequests?: number; maxMs?: number;
  log?: (line: string) => void; now?: () => string; pause?: (ms: number) => Promise<void>;
}

const blockSchema = z.object({ number: z.string(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).passthrough();
const chainIdSchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const chainDir = (root: string, chainId: number) => join(root, 'v1', String(chainId));

async function writeAtomic(path: string, body: string) {
  await writeFile(`${path}.tmp`, body);
  await rename(`${path}.tmp`, path);
}

/** Loads a seed manifest and its pages; returns null when absent or when any page fails its digest. */
export async function loadSeed(root: string | undefined, chain: ChainTarget) {
  if (root === undefined) return null;
  const dir = chainDir(root, chain.chainId);
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
  checkManifest(manifest, chain.chainId, chain.deployBlock);
  const bodies = new Map<string, string>();
  for (const page of manifest.pages) {
    const body = await readFile(join(dir, pagePath(page)), 'utf8');
    if (sha256(body) !== page.sha256) throw new Error(`${chain.key}: seed page ${page.from} digest mismatch`);
    bodies.set(page.sha256, body);
  }
  return { manifest, bodies };
}

async function finalizedOf(transport: Transport, source: Source, chainId: number) {
  const id = await rpc(transport, source.url, 'eth_chainId', [], chainIdSchema);
  if (id.error || Number(BigInt(id.result!)) !== chainId) throw new Error(`${source.name}: wrong chain or ${id.error?.message}`);
  const block = await rpc(transport, source.url, 'eth_getBlockByNumber', ['finalized', false], blockSchema);
  if (block.error || !block.result) throw new Error(`${source.name}: finalized block ${block.error?.message}`);
  return Number(BigInt(block.result.number));
}
async function hashAt(transport: Transport, source: Source, number: number) {
  const block = await rpc(transport, source.url, 'eth_getBlockByNumber', [`0x${number.toString(16)}`, false], blockSchema);
  if (block.error || !block.result || Number(BigInt(block.result.number)) !== number) {
    throw new Error(`${source.name}: block ${number} ${block.error?.message}`);
  }
  return block.result.hash.toLowerCase();
}

const checkpointSchema = z.object({
  fromBlock: z.number(), toBlock: z.number(), checkpoint: z.number(), logs: z.array(rpcLogSchema),
  requests: z.number(), okRequests: z.number(), responseBytes: z.number(), requestBytes: z.number(),
  fetchMs: z.number(), elapsedMs: z.number(),
});

async function retrieve(options: BuildOptions, chain: ChainTarget, source: Source, fromBlock: number, toBlock: number) {
  const path = options.workDir === undefined ? undefined
    : join(options.workDir, `${options.feed}-${chain.key}-${source.name}-${fromBlock}.json`);
  let resume: RetrieveOptions['resume'];
  if (path !== undefined && existsSync(path)) {
    const saved = checkpointSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (saved.fromBlock === fromBlock && saved.toBlock <= toBlock) resume = saved;
  }
  let lastSave = 0;
  const save = async (result: RetrieveResult, force = false) => {
    if (path === undefined || (!force && performance.now() - lastSave < 30_000)) return;
    lastSave = performance.now();
    await writeAtomic(path, JSON.stringify({
      fromBlock, toBlock: result.toBlock, checkpoint: result.checkpoint, logs: result.logs.map(log => ({
        ...log, blockNumber: `0x${log.blockNumber.toString(16)}`, logIndex: `0x${log.logIndex.toString(16)}`,
        transactionIndex: `0x${log.transactionIndex.toString(16)}`, blockTimestamp: undefined,
      })),
      requests: result.requests, okRequests: result.okRequests, responseBytes: result.responseBytes,
      requestBytes: result.requestBytes, fetchMs: result.fetchMs, elapsedMs: result.totalMs,
    }));
  };
  const span = Math.min(source.span, 100_000);
  const run = (from: typeof resume) => retrieveHistory(options.transport, {
    endpoints: [source.url], fromBlock, toBlock, initialSpan: span, maxSpan: source.span, minSpan: 1,
    maxRequests: options.maxRequests ?? 80_000, maxMs: options.maxMs ?? 8 * 3600_000,
    ...(from === undefined ? {} : { resume: from }),
    onCheckpoint: (_next, _logs, progress) => { void save(progress); },
    log: line => options.log?.(`[${options.feed}:${chain.key}:${source.name}]${line}`),
  });
  let result = await run(resume);
  // The pager gives up on an endpoint after a few transient errors; one source is all this
  // retrieval has, so resume from its checkpoint after a pause.
  for (let attempt = 1; !result.success && attempt <= 6 && !/budget/.test(result.failure ?? ''); attempt++) {
    options.log?.(`[${options.feed}:${chain.key}:${source.name}] retry ${attempt} at ${result.checkpoint}: ${result.failure}`);
    await (options.pause ?? Bun.sleep)(30_000 * attempt);
    result = await run({ checkpoint: result.checkpoint, logs: result.logs, requests: result.requests, okRequests: result.okRequests,
      responseBytes: result.responseBytes, requestBytes: result.requestBytes, fetchMs: result.fetchMs, elapsedMs: result.totalMs });
  }
  await save(result, true);
  return result;
}

const toRows = (logs: RpcLog[]) => logs.map(rowFromLog);
const same = (a: Row[], b: Row[]) => JSON.stringify(a) === JSON.stringify(b);
const within = (rows: Row[], from: number, to: number) => rows.filter(row => row.block >= from && row.block <= to);

export interface ChainReport {
  chain: string; chainId: number; sources: string[]; target: number | null; seedFinalized: number | null;
  published: number | null; newPages: number; refetched: { from: number; to: number; agreed: boolean }[];
  stop: string | null; retrievals: { source: string; fromBlock: number; toBlock: number; checkpoint: number;
    success: boolean; failure: string | null; requests: number; okRequests: number; responseBytes: number; fetchMs: number; totalMs: number }[];
}

async function buildChain(options: BuildOptions, chain: ChainTarget): Promise<ChainReport> {
  const pageBlocks = chain.pageBlocks ?? PAGE_BLOCKS;
  const pair = options.sources[chain.key];
  if (!pair) throw new Error(`No sources for ${chain.key}`);
  const report: ChainReport = {
    chain: chain.key, chainId: chain.chainId, sources: pair.map(source => source.url), target: null,
    seedFinalized: null, published: null, newPages: 0, refetched: [], stop: null, retrievals: [],
  };
  const seed = await loadSeed(options.seedDir, chain);
  report.seedFinalized = seed?.manifest.finalized.number ?? null;
  const out = chainDir(options.outDir, chain.chainId);
  await mkdir(join(out, 'p'), { recursive: true });
  const publish = async (manifest: Manifest, bodies: Map<string, string>) => {
    for (const page of manifest.pages) {
      const path = join(out, pagePath(page));
      if (!existsSync(path)) await writeAtomic(path, bodies.get(page.sha256)!);
    }
    await writeAtomic(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
    report.published = manifest.finalized.number;
  };
  try {
    const finals = await Promise.all(pair.map(source => finalizedOf(options.transport, source, chain.chainId)));
    const target = Math.min(...finals, chain.maxBlock ?? Number.MAX_SAFE_INTEGER);
    report.target = target;
    const ranges = pageRanges(chain.deployBlock, target, pageBlocks);
    const kept: PageEntry[] = [];
    for (const page of seed?.manifest.pages ?? []) {
      const range = ranges[kept.length];
      if (!range || page.from !== range.from || page.to !== range.to) break;
      kept.push(page);
    }
    const fresh = ranges.slice(kept.length);
    if (!fresh.length) { if (seed) await publish(seed.manifest, seed.bodies); return report; }
    const start = fresh[0]!.from;
    const results = await Promise.all(pair.map(source => retrieve(options, chain, source, start, target)));
    for (const [i, result] of results.entries()) {
      report.retrievals.push({ source: pair[i]!.url, fromBlock: start, toBlock: target, checkpoint: result.checkpoint,
        success: result.success, failure: result.failure, requests: result.requests, okRequests: result.okRequests,
        responseBytes: result.responseBytes, fetchMs: result.fetchMs, totalMs: result.totalMs });
    }
    const covered = Math.min(...results.map(result => result.checkpoint - 1));
    const [rowsA, rowsB] = results.map(result => toRows(result.logs)) as [Row[], Row[]];
    const agreedRows: Row[] = [];
    let agreedTo = start - 1;
    for (const range of fresh) {
      // A partial final page is allowed only at the target; elsewhere stop at the last whole page.
      if (range.to > covered) { report.stop ??= `sources covered to ${covered}`; break; }
      let a = within(rowsA, range.from, range.to);
      let b = within(rowsB, range.from, range.to);
      if (!same(a, b)) {
        const { workDir: _, ...uncached } = options;
        const again = await Promise.all(pair.map(source => retrieve(uncached, chain, source, range.from, range.to)));
        if (again.every(result => result.success)) [a, b] = again.map(result => toRows(result.logs)) as [Row[], Row[]];
        const agreed = again.every(result => result.success) && same(a, b);
        report.refetched.push({ from: range.from, to: range.to, agreed });
        if (!agreed) { report.stop = `sources disagree on ${range.from}-${range.to}`; break; }
      }
      agreedRows.push(...a);
      agreedTo = range.to;
    }
    if (agreedTo < start) throw new Error(report.stop ?? 'no new agreed page');
    const hashes = await Promise.all(pair.map(source => hashAt(options.transport, source, agreedTo)));
    if (hashes[0] !== hashes[1]) throw new Error(`block ${agreedTo} hash differs between sources`);
    // `start` is a grid boundary, so ranges from it stay on the grid.
    const built = buildPages(agreedRows, pageRanges(start, agreedTo, pageBlocks));
    const bodies = new Map(seed?.bodies ?? []);
    for (const page of built) bodies.set(page.entry.sha256, page.body);
    report.newPages = built.length;
    const manifest: Manifest = {
      format: FORMAT, chainId: chain.chainId, contract: ANNOUNCER, topic0: ANNOUNCEMENT_TOPIC,
      deployBlock: chain.deployBlock, pageBlocks, finalized: { number: agreedTo, hash: hashes[0]! },
      pages: [...kept, ...built.map(page => page.entry)],
      producer: { feed: options.feed, sources: pair.map(source => source.url), builtAt: options.now?.() ?? new Date().toISOString(), code: 'src/feed/build-a.ts' },
    };
    checkManifest(manifest, chain.chainId, chain.deployBlock);
    await publish(manifest, bodies);
  } catch (error) {
    report.stop = report.stop ?? String(error);
    if (seed) await publish(seed.manifest, seed.bodies);
  }
  return report;
}

export async function buildFeedA(options: BuildOptions) {
  await mkdir(options.outDir, { recursive: true });
  return Promise.all(options.chains.map(async chain => {
    const report = await buildChain(options, chain);
    options.log?.(`[${options.feed}:${report.chain}] published ${report.published} stop ${report.stop}`);
    return report;
  }));
}

if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const { PoliteHttp } = await import('../chain-volume/http.ts');
  const { FEED_CHAINS } = await import('./format.ts');
  const { SOURCES } = await import('./sources.ts');
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, seed: { type: 'string' }, work: { type: 'string' }, chains: { type: 'string' },
    report: { type: 'string' }, 'max-minutes': { type: 'string' },
  } });
  if (!values.out) throw new Error('Usage: bun run feed:build-a --out DIR [--seed DIR] [--work DIR] [--chains a,b] [--report FILE] [--max-minutes N]');
  const keys = values.chains?.split(',') ?? FEED_CHAINS.map(chain => chain.key);
  const chains = FEED_CHAINS.filter(chain => keys.includes(chain.key));
  if (values.work) await mkdir(values.work, { recursive: true });
  const startedAt = new Date().toISOString();
  const reports = await buildFeedA({
    feed: 'a', transport: new PoliteHttp({ minIntervalMs: 250 }), chains: [...chains], sources: SOURCES.a,
    outDir: values.out, ...(values.seed ? { seedDir: values.seed } : {}), ...(values.work ? { workDir: values.work } : {}),
    log: line => console.log(line), ...(values['max-minutes'] ? { maxMs: Number(values['max-minutes']) * 60_000 } : {}),
  });
  if (values.report) await writeFile(values.report, JSON.stringify({ feed: 'a', startedAt, finishedAt: new Date().toISOString(), chains: reports }, null, 1) + '\n');
  if (reports.some(report => report.published === null)) process.exitCode = 1;
}
