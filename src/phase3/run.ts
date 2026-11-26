/**
 * Phase 3: can a keyless wallet retrieve the full ERC-5564 Announcement history?
 *
 *   bun run phase3 --stage endpoints|reference|probe|retrieve|umbra|report|all [--chains ethereum,base] [--output data/phase3]
 *
 * Live network, read-only, no keys, polite (<= 4 req/s per host, backoff on 429).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CHAINS, chainByKey, endpointsFromChainlist, type ChainConfig, type EndpointCandidate } from './chains.ts';
import { PoliteHttp, USER_AGENT, type Transport } from './http.ts';
import { blockscoutDeploy, blockscoutHead, blockscoutV2Logs, etherscanHead, etherscanLogs, type IndexerRun } from './indexers.ts';
import { codeSchema, findDeployBlock, probeEndpoint, type EndpointProbe } from './probe.ts';
import { percentile } from './range-search.ts';
import { compareSets, formatKeyed, parseKeyed, retrieveHistory, type RetrieveOptions, type RetrieveResult } from './retrieve.ts';
import { CANONICAL, UMBRA, getLogsParams, quantity, rpcLogsSchema, rpc, toHex, type LogFilter } from './rpc.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
import { buildReport } from './report.ts';

const CHAINLIST_URL = 'https://chainlist.org/rpcs.json';

const log = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 1)}\n`);
}
async function readJson<T>(path: string, schema: z.ZodType<T> = z.any() as z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  }));
  return results;
}

// ---------- stage: endpoints ----------
interface EndpointsFile { source: string; fetchedAt: string; lastModified: string | null; sha256: string; chains: Record<string, EndpointCandidate[]> }

async function stageEndpoints(transport: Transport, out: string): Promise<void> {
  const http = await transport.request(CHAINLIST_URL, { method: 'GET' });
  if (!http.ok) throw new Error(`chainlist fetch failed: ${http.status} ${http.networkError ?? ''}`);
  const json: unknown = JSON.parse(http.text);
  const chains: Record<string, EndpointCandidate[]> = {};
  for (const chain of CHAINS) chains[chain.key] = endpointsFromChainlist(json, chain.chainId);
  const file: EndpointsFile = {
    source: CHAINLIST_URL,
    fetchedAt: new Date().toISOString(),
    lastModified: http.lastModified,
    sha256: createHash('sha256').update(http.text).digest('hex'),
    chains,
  };
  await writeJson(join(out, 'endpoints.json'), file);
  for (const chain of CHAINS) {
    const list = chains[chain.key] ?? [];
    log(`${chain.key}: ${list.length} listed, ${list.filter(e => e.excluded === null).length} keyless candidates`);
  }
}

// ---------- stage: reference (indexers + volume) ----------
export interface ReferenceFile {
  chain: string;
  measuredAt: string;
  filter: LogFilter;
  deploy: { block: number | null; creationTx: string | null; source: string | null; notes: string[] };
  indexers: Array<Omit<IndexerRun, 'logs'> & { identities: string[]; count: number; firstBlock: number | null; lastBlock: number | null; latencyMedianMs: number | null; latencyP95Ms: number | null; headLagBlocks: number | null }>;
  reference: { source: string; count: number; identities: string[]; firstBlock: number | null; lastBlock: number | null; firstTime: string | null; lastTime: string | null; perMonth: Record<string, number> } | null;
  rpcHead: number | null;
}

function monthly(logs: Array<{ timestamp: number | null }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of logs) {
    if (entry.timestamp === null) continue;
    const key = new Date(entry.timestamp * 1000).toISOString().slice(0, 7);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort());
}

async function quickHead(transport: Transport, chain: ChainConfig, out: string): Promise<number | null> {
  const endpoints = await loadCandidates(out, chain);
  for (const url of endpoints.slice(0, 12)) {
    const call = await rpc(transport, url, 'eth_blockNumber', [], quantity);
    if (call.result !== null) return call.result;
  }
  return null;
}

async function loadCandidates(out: string, chain: ChainConfig): Promise<string[]> {
  const file = await readJson<EndpointsFile>(join(out, 'endpoints.json'));
  return (file.chains[chain.key] ?? []).filter(entry => entry.excluded === null).map(entry => entry.url);
}

async function stageReference(transport: Transport, chain: ChainConfig, out: string, filter: LogFilter, tag: string): Promise<void> {
  log(`[${chain.key}] reference (${tag})`);
  const rpcHead = await quickHead(transport, chain, out);
  const file: ReferenceFile = { chain: chain.key, measuredAt: new Date().toISOString(), filter, deploy: { block: null, creationTx: null, source: null, notes: [] }, indexers: [], reference: null, rpcHead };
  const runs: IndexerRun[] = [];
  for (const base of chain.blockscout) {
    const deploy = await blockscoutDeploy(transport, base, filter.address);
    if (deploy.deployBlock !== null && file.deploy.block === null) {
      file.deploy = { block: deploy.deployBlock, creationTx: deploy.creationTx, source: `${base} creation transaction`, notes: [] };
    } else if (deploy.failure !== null) file.deploy.notes.push(`${base}: ${deploy.failure}`);
    const v2 = await blockscoutV2Logs(transport, base, filter);
    const head = await blockscoutHead(transport, base);
    v2.indexedHead = head.head;
    runs.push(v2);
    log(`  ${base} v2: ${v2.ok ? `${v2.logs.length} logs in ${v2.pages} pages` : v2.failure}`);
    if (v2.blocked) continue;
    const toBlock = rpcHead ?? head.head ?? 999_999_999;
    const compat = await etherscanLogs(transport, 'blockscout-etherscan-api', `${base}/api`, file.deploy.block ?? 0, toBlock, filter);
    compat.indexedHead = head.head;
    runs.push(compat);
    log(`  ${base} etherscan-api: ${compat.ok ? `${compat.logs.length} logs, max page ${compat.pageSizeObserved}` : compat.failure}`);
    if (v2.ok) break; // first working Blockscout instance is enough
  }
  if (chain.routescan !== null) {
    const toBlock = rpcHead ?? 999_999_999;
    const routescan = await etherscanLogs(transport, 'routescan-etherscan-api', chain.routescan, file.deploy.block ?? 0, toBlock, filter);
    routescan.indexedHead = (await etherscanHead(transport, chain.routescan)).head;
    runs.push(routescan);
    log(`  routescan: ${routescan.ok ? `${routescan.logs.length} logs` : routescan.failure}`);
  }
  // Blockscout v2 leaves many tx hashes empty; fill them from any complete source for the stored identities.
  const txFill = new Map<string, string>();
  for (const run of runs) for (const entry of run.logs) if (entry.transactionHash !== '') txFill.set(entry.identity, entry.transactionHash);
  file.indexers = runs.map(({ logs, ...rest }) => ({
    ...rest,
    identities: tag === 'canonical' && rest.ok ? logs.map(entry => formatKeyed({ ...entry, transactionHash: entry.transactionHash || (txFill.get(entry.identity) ?? '') })) : [],
    count: logs.length,
    firstBlock: logs[0]?.blockNumber ?? null,
    lastBlock: logs.at(-1)?.blockNumber ?? null,
    latencyMedianMs: percentile(rest.latencyMs, 0.5),
    latencyP95Ms: percentile(rest.latencyMs, 0.95),
    headLagBlocks: rest.indexedHead !== null && rpcHead !== null ? rpcHead - rest.indexedHead : null,
    latencyMs: rest.latencyMs.map(ms => Math.round(ms)),
  }));
  const best = runs.find(run => run.ok && run.source === 'blockscout-v2') ?? runs.find(run => run.ok);
  if (best !== undefined) {
    // Blockscout v2 leaves transaction_hash empty for many logs; fill it from another complete source.
    const txByKey = new Map<string, string>();
    for (const run of runs) if (run.ok) for (const entry of run.logs) if (entry.transactionHash !== '') txByKey.set(entry.identity, entry.transactionHash);
    for (const entry of best.logs) if (entry.transactionHash === '') entry.transactionHash = txByKey.get(entry.identity) ?? '';
    const first = best.logs[0];
    const last = best.logs.at(-1);
    file.reference = {
      source: `${best.source} ${best.base}`,
      count: best.logs.length,
      identities: tag === 'canonical' ? best.logs.map(formatKeyed) : [],
      firstBlock: first?.blockNumber ?? null,
      lastBlock: last?.blockNumber ?? null,
      firstTime: first?.timestamp ? new Date(first.timestamp * 1000).toISOString() : null,
      lastTime: last?.timestamp ? new Date(last.timestamp * 1000).toISOString() : null,
      perMonth: monthly(best.logs),
    };
  }
  await writeJson(join(out, tag, `reference-${chain.key}.json`), file);
}

// ---------- deploy block via eth_getCode bisection ----------
async function deployByBisection(transport: Transport, endpoints: string[], head: number, address: string): Promise<{ block: number | null; source: string | null; notes: string[] }> {
  const notes: string[] = [];
  for (const url of endpoints) {
    const codeAt = async (block: number) => {
      const call = await rpc(transport, url, 'eth_getCode', [address, toHex(block)], codeSchema);
      if (call.error !== null || call.result === null) return null;
      return call.result.length > 2;
    };
    // Cheap archive check before a ~30-request bisection.
    if ((await codeAt(1)) === null) { notes.push(`${new URL(url).host}: no archive state at block 1`); continue; }
    const found = await findDeployBlock(codeAt, head);
    if (found.deployBlock !== null) return { block: found.deployBlock, source: `eth_getCode bisection on ${new URL(url).host} (${found.requests} requests)`, notes };
    notes.push(`${new URL(url).host}: ${found.reason}`);
    if (notes.length >= 6) break;
  }
  return { block: null, source: null, notes };
}

async function resolveDeploy(transport: Transport, chain: ChainConfig, out: string, tag: string, filter: LogFilter, endpoints: string[], head: number): Promise<{ block: number | null; source: string | null; notes: string[] }> {
  const refPath = join(out, tag, `reference-${chain.key}.json`);
  const ref = existsSync(refPath) ? await readJson<ReferenceFile>(refPath) : null;
  const bisect = await deployByBisection(transport, endpoints, head, filter.address);
  if (ref?.deploy.block != null) {
    const agree = bisect.block === null ? 'bisection unavailable' : bisect.block === ref.deploy.block ? 'bisection agrees' : `bisection says ${bisect.block}`;
    return { block: ref.deploy.block, source: `${ref.deploy.source}; ${agree}${bisect.source ? ` (${bisect.source})` : ''}`, notes: [...ref.deploy.notes, ...bisect.notes] };
  }
  return { block: bisect.block, source: bisect.source, notes: [...(ref?.deploy.notes ?? []), ...bisect.notes] };
}

// ---------- stage: probe ----------
export interface ProbeFile { chain: string; measuredAt: string; deployBlock: number; deploySource: string | null; deployNotes: string[]; firstLog: { blockNumber: number; identity: string } | null; endpoints: EndpointProbe[] }

async function stageProbe(transport: Transport, chain: ChainConfig, out: string): Promise<void> {
  const candidates = await loadCandidates(out, chain);
  log(`[${chain.key}] probe ${candidates.length} endpoints`);
  const head = await quickHead(transport, chain, out);
  if (head === null) throw new Error(`${chain.key}: no endpoint returned a head`);
  const deploy = await resolveDeploy(transport, chain, out, 'canonical', CANONICAL, candidates, head);
  if (deploy.block === null) throw new Error(`${chain.key}: deploy block unknown: ${deploy.notes.join('; ')}`);
  log(`  deploy block ${deploy.block} (${deploy.source})`);
  const refPath = join(out, 'canonical', `reference-${chain.key}.json`);
  const ref = existsSync(refPath) ? await readJson<ReferenceFile>(refPath) : null;
  const firstRow = ref?.reference?.identities[0];
  const firstParsed = firstRow ? parseKeyed(firstRow) : null;
  const firstLog = firstParsed ? { blockNumber: firstParsed.blockNumber, identity: firstParsed.key } : null;
  const probes = await mapLimit(candidates, 6, async (url) => {
    const result = await probeEndpoint(url, { transport, chainId: chain.chainId, deployBlock: deploy.block as number, firstLog, log });
    log(`  ${result.host}: ${result.status}${result.unusableReason ? ` (${result.unusableReason.slice(0, 100)})` : ''}`);
    return result;
  });
  const file: ProbeFile = { chain: chain.key, measuredAt: new Date().toISOString(), deployBlock: deploy.block, deploySource: deploy.source, deployNotes: deploy.notes, firstLog, endpoints: probes };
  await writeJson(join(out, 'probe', `${chain.key}.json`), file);
}

// ---------- stage: verify-deploy ----------
/** Re-checks a deploy block on other endpoints: code at N, none at N-1 (guards against nodes that return 0x for pruned state). */
async function stageVerifyDeploy(transport: Transport, chain: ChainConfig, out: string, address: string, tag: string): Promise<void> {
  const probe = await readJson<ProbeFile>(join(out, 'probe', `${chain.key}.json`));
  const umbraFile = ['probe-informed', 'parallel'].map(strategy => join(out, tag, `retrieve-${chain.key}-${strategy}.json`)).find(path => existsSync(path));
  const deployBlock = tag === 'canonical' ? probe.deployBlock : umbraFile ? (await readJson<Json>(umbraFile)).deployBlock : null;
  if (deployBlock === null || deployBlock === undefined) { log(`[${chain.key}] ${tag}: no retrieval file with a deploy block`); return; }
  const checks: Array<{ host: string; codeAtDeploy: boolean | null; codeBefore: boolean | null }> = [];
  for (const url of orderEndpoints(probe, 'probe-informed')) {
    const at = async (block: number) => {
      const call = await rpc(transport, url, 'eth_getCode', [address, toHex(block)], codeSchema);
      return call.error !== null || call.result === null ? null : call.result.length > 2;
    };
    const codeAtDeploy = await at(deployBlock);
    const codeBefore = await at(deployBlock - 1);
    checks.push({ host: new URL(url).host, codeAtDeploy, codeBefore });
    if (checks.filter(c => c.codeAtDeploy === true && c.codeBefore === false).length >= 2) break;
    if (checks.length >= 6) break;
  }
  const confirmed = checks.filter(c => c.codeAtDeploy === true && c.codeBefore === false).length;
  log(`[${chain.key}] ${tag} deploy ${deployBlock}: confirmed on ${confirmed} endpoints`);
  await writeJson(join(out, tag, `deploy-check-${chain.key}.json`), { chain: chain.key, address, deployBlock, confirmed, checks });
}

// ---------- stage: consistency ----------
/**
 * For each endpoint that serves history, asks for windows around known announcements
 * (first, middle, last of the reference set) and records returned / empty / error.
 * "empty" is the dangerous case: no error, but a payment is missing.
 */
async function stageConsistency(transport: Transport, chain: ChainConfig, out: string): Promise<void> {
  const probe = await readJson<ProbeFile>(join(out, 'probe', `${chain.key}.json`));
  const refPath = join(out, 'canonical', `reference-${chain.key}.json`);
  const ref = existsSync(refPath) ? await readJson<ReferenceFile>(refPath) : null;
  let rows = ref?.reference?.identities ?? [];
  let source = ref?.reference?.source ?? null;
  if (rows.length === 0) {
    for (const strategy of ['probe-informed', 'parallel', 'list-order']) {
      const r = join(out, 'canonical', `retrieve-${chain.key}-${strategy}.json`);
      const file = existsSync(r) ? await readJson<Json>(r) : null;
      if (file?.result?.success) { rows = file.identities ?? []; source = `keyless RPC retrieval (${strategy})`; break; }
    }
    if (rows.length === 0) {
      // No complete set yet: any announcement observed by any run is still a valid target.
      const seen = new Map<string, string>();
      for (const strategy of ['list-order', 'probe-informed', 'parallel']) {
        const r = join(out, 'canonical', `retrieve-${chain.key}-${strategy}.json`);
        const file = existsSync(r) ? await readJson<Json>(r) : null;
        for (const row of file?.identities ?? []) seen.set(parseKeyed(row).key, row);
      }
      rows = [...seen.values()].sort((a, b) => parseKeyed(a).blockNumber - parseKeyed(b).blockNumber);
      source = 'announcements observed by partial keyless RPC runs';
    }
  }
  if (rows.length === 0) { log(`[${chain.key}] consistency: no known announcements`); return; }
  const parsed = rows.map(parseKeyed);
  const targets = [...new Map([parsed[0], parsed[Math.floor(parsed.length / 2)], parsed.at(-1)].filter(x => x !== undefined).map(t => [t.key, t])).values()];
  const results = await mapLimit(probe.endpoints.filter(e => e.status === 'usable' && e.archiveDepthServed !== null), 6, async (endpoint) => {
    const window = Math.min(endpoint.range?.maxOk ?? 10, 100);
    const checks = [];
    for (const target of targets) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const from = Math.max(probe.deployBlock, target.blockNumber - Math.floor(window / 2));
        const call = await rpc(transport, endpoint.url, 'eth_getLogs', getLogsParams(from, from + window - 1), rpcLogsSchema);
        const found = call.result?.some(entry => `${entry.blockNumber}:${entry.logIndex}` === target.key) ?? false;
        checks.push({ target: target.key, attempt, outcome: call.error ? `error: ${call.error.kind}` : found ? 'returned' : 'empty', message: call.error?.message.slice(0, 120) ?? null });
      }
    }
    const outcomes = checks.map(c => c.outcome);
    return { host: endpoint.host, url: endpoint.url, window, returned: outcomes.filter(o => o === 'returned').length, empty: outcomes.filter(o => o === 'empty').length, errors: outcomes.filter(o => o.startsWith('error')).length, checks };
  });
  const silent = results.filter(r => r.empty > 0);
  log(`[${chain.key}] consistency: ${results.length} endpoints, ${silent.length} returned an empty result for a known announcement (${silent.map(r => r.host).join(', ')})`);
  await writeJson(join(out, 'consistency', `${chain.key}.json`), { chain: chain.key, measuredAt: new Date().toISOString(), source, targets: targets.map(t => t.key), endpoints: results });
}

let maxMinutes = 90;

function retrieveStub(fromBlock: number, toBlock: number): RetrieveResult {
  return { success: false, failure: null, fromBlock, toBlock, checkpoint: fromBlock, logs: [], requests: 0, okRequests: 0, responseBytes: 0, requestBytes: 0, totalMs: 0, fetchMs: 0, endpointSwitches: 0, spanHistogram: {}, endpoints: [] };
}

/** Sums per-endpoint usage across chunks. */
function mergeUses(parts: RetrieveResult[]): RetrieveResult['endpoints'] {
  const byUrl = new Map<string, RetrieveResult['endpoints'][number]>();
  for (const use of parts.flatMap(part => part.endpoints)) {
    const prev = byUrl.get(use.url);
    if (prev === undefined) { byUrl.set(use.url, { ...use, errors: { ...use.errors }, errorSamples: { ...use.errorSamples } }); continue; }
    prev.requests += use.requests;
    prev.ok += use.ok;
    for (const [kind, n] of Object.entries(use.errors)) prev.errors[kind as keyof typeof prev.errors] = (prev.errors[kind as keyof typeof prev.errors] ?? 0) + (n ?? 0);
    Object.assign(prev.errorSamples, { ...use.errorSamples, ...prev.errorSamples });
    if (use.abandonReason) { prev.abandonedAt ??= use.abandonedAt; prev.abandonReason ??= use.abandonReason; }
    if (use.learnedMaxSpan !== null) prev.learnedMaxSpan = Math.min(prev.learnedMaxSpan ?? use.learnedMaxSpan, use.learnedMaxSpan);
  }
  return [...byUrl.values()];
}

// ---------- resumable state ----------
/**
 * Partial retrieval state, written at most every 15 s and at each segment end, under
 * <output>/partial/ so a crash or kill loses at most a few windows. A rerun with the same
 * chain/strategy/segment start resumes from the saved checkpoint. Delete the file to start over.
 */
const statePath = (out: string, tag: string, chain: string, strategy: string, segment: number) => join(out, 'partial', `${tag}-${chain}-${strategy}-${segment}.json`);

async function loadState(out: string, tag: string, chain: string, strategy: string, segment: number, fromBlock: number): Promise<RetrieveOptions['resume'] | null> {
  const path = statePath(out, tag, chain, strategy, segment);
  if (!existsSync(path)) return null;
  const state = await readJson<Json>(path);
  if (state.fromBlock !== fromBlock) { log(`  ${path}: different fromBlock, ignoring`); return null; }
  log(`  resuming ${chain} ${strategy} segment ${segment} at block ${state.checkpoint} (${state.logs.length} logs, ${state.requests} requests so far)`);
  return { checkpoint: state.checkpoint, logs: state.logs, requests: state.requests, okRequests: state.okRequests, responseBytes: state.responseBytes, requestBytes: state.requestBytes, fetchMs: state.fetchMs, elapsedMs: state.elapsedMs };
}

function saver(out: string, tag: string, chain: string, strategy: string, segment: number, fromBlock: number, inner: (next: number, count: number) => void) {
  let last = 0;
  let writing: Promise<void> = Promise.resolve();
  return (next: number, count: number, progress: RetrieveResult) => {
    inner(next, count);
    if (Date.now() - last < 15_000 && next <= progress.toBlock) return;
    last = Date.now();
    const snapshot = {
      chain, tag, strategy, segment, fromBlock, toBlock: progress.toBlock, checkpoint: next, savedAt: new Date().toISOString(),
      requests: progress.requests, okRequests: progress.okRequests, responseBytes: progress.responseBytes, requestBytes: progress.requestBytes,
      fetchMs: progress.fetchMs, elapsedMs: progress.totalMs, logs: progress.logs,
    };
    writing = writing.then(async () => {
      const path = statePath(out, tag, chain, strategy, segment);
      await writeJson(`${path}.tmp`, snapshot);
      await rename(`${path}.tmp`, path);
    });
  };
}

// ---------- stage: retrieve ----------
export interface RetrieveFile {
  chain: string; measuredAt: string; filter: LogFilter; strategy: string; endpointOrder: string[]; initialSpan: number;
  result: Omit<RetrieveResult, 'logs'> & { count: number; firstBlock: number | null; lastBlock: number | null; firstTime: string | null; lastTime: string | null };
  identities: string[];
  comparison: ReturnType<typeof compareSets> | null; referenceSource: string | null;
}

type Strategy = 'list-order' | 'probe-informed' | 'parallel';

/** Hosts that returned an empty result for a known announcement in the consistency check. */
let silentHosts = new Set<string>();
async function loadSilentHosts(out: string, chain: string): Promise<void> {
  const path = join(out, 'consistency', `${chain}.json`);
  silentHosts = new Set(existsSync(path) ? (await readJson<Json>(path)).endpoints.filter((e: Json) => e.empty > 0).map((e: Json) => e.host) : []);
}

function orderEndpoints(probe: ProbeFile, strategy: Strategy): string[] {
  const healthy = probe.endpoints.filter(entry => entry.status === 'usable' && (strategy === 'list-order' || !silentHosts.has(entry.host)));
  if (strategy === 'list-order') return healthy.map(entry => entry.url);
  const span = (entry: EndpointProbe) => (entry.range?.unbounded ? Number.MAX_SAFE_INTEGER : entry.range?.maxOk ?? 0);
  return healthy
    .filter(entry => entry.servesDeployBlock === true && entry.firstLogReturned !== false)
    .sort((a, b) => span(b) - span(a) || (a.latency.medianMs ?? 1e9) - (b.latency.medianMs ?? 1e9))
    .map(entry => entry.url);
}

async function stageRetrieve(transport: Transport, chain: ChainConfig, out: string, strategy: Strategy, filter: LogFilter, tag: string, maxRequests: number): Promise<void> {
  const probe = await readJson<ProbeFile>(join(out, 'probe', `${chain.key}.json`));
  await loadSilentHosts(out, chain.key);
  if (silentHosts.size > 0 && strategy !== 'list-order') log(`  excluding silent hosts: ${[...silentHosts].join(', ')}`);
  const order = orderEndpoints(probe, strategy).slice(0, 8);
  let deployBlock = probe.deployBlock;
  let deploySource: string | null = probe.deploySource;
  const head = await quickHead(transport, chain, out);
  if (head === null) throw new Error('no head');
  if (tag !== 'canonical') {
    const resolved = await resolveDeploy(transport, chain, out, tag, filter, orderEndpoints(probe, 'probe-informed'), head);
    if (resolved.block === null) { log(`[${chain.key}] ${tag}: no deploy block (${resolved.notes.join('; ')}); skipping`); await writeJson(join(out, tag, `retrieve-${chain.key}-${strategy}.json`), { chain: chain.key, skipped: resolved.notes }); return; }
    deployBlock = resolved.block;
    deploySource = resolved.source;
  }
  log(`[${chain.key}] retrieve ${tag} ${strategy} from ${deployBlock} to ${head} over ${order.length} endpoints`);
  if (order.length === 0) {
    await writeJson(join(out, tag, `retrieve-${chain.key}-${strategy}.json`), { chain: chain.key, skipped: ['no usable endpoint for this strategy'] });
    return;
  }
  const initialSpan = 10_000;
  let lastLog = 0;
  const onCheckpoint = (next: number, count: number) => { if (Date.now() - lastLog > 30_000) { lastLog = Date.now(); log(`  ${chain.key} checkpoint ${next} (${(((next - deployBlock) / (head - deployBlock + 1)) * 100).toFixed(1)}%), ${count} logs`); } };
  let result: RetrieveResult;
  if (strategy !== 'parallel') {
    const state = await loadState(out, tag, chain.key, strategy, 0, deployBlock);
    result = await retrieveHistory(transport, { endpoints: order, filter, fromBlock: deployBlock, toBlock: head, initialSpan, maxRequests, maxMs: maxMinutes * 60_000, log, ...(state ? { resume: state } : {}), onCheckpoint: saver(out, tag, chain.key, strategy, 0, deployBlock, onCheckpoint) });
  } else {
    // Work queue: the range is cut into CHUNKS contiguous chunks; one worker per distinct host
    // (up to 4), each with the full fallback list rotated, pulls the next unfinished chunk. Fast
    // endpoints therefore do most of the work. Each chunk's state is saved as it goes, so a rerun
    // skips finished chunks and resumes partial ones. The plan (head, chunk size) is saved too.
    const CHUNKS = 64;
    const hosts = [...new Map(order.map(url => [new URL(url).host, url])).values()];
    const planPath = join(out, 'partial', `${tag}-${chain.key}-parallel-plan.json`);
    const saved = existsSync(planPath) ? await readJson<Json>(planPath) : null;
    const plan = saved?.deployBlock === deployBlock && saved?.chunks === CHUNKS ? saved : { deployBlock, head, chunks: CHUNKS, workers: Math.min(4, hosts.length) };
    if (saved !== plan) await writeJson(planPath, plan);
    const size = Math.ceil((plan.head - deployBlock + 1) / plan.chunks);
    const bounds = Array.from({ length: plan.chunks }, (_, i) => ({ i, from: deployBlock + i * size, to: i === plan.chunks - 1 ? head : deployBlock + (i + 1) * size - 1 }));
    const started = performance.now();
    const parts: RetrieveResult[] = [];
    let next = 0;
    let spent = 0;
    await Promise.all(Array.from({ length: plan.workers as number }, async (_, w) => {
      const endpoints = [...hosts.slice(w), ...hosts.slice(0, w)];
      let span = initialSpan;
      while (next < bounds.length && spent < maxRequests && performance.now() - started < maxMinutes * 60_000) {
        const chunk = bounds[next++]!;
        const state = await loadState(out, tag, chain.key, strategy, chunk.i, chunk.from);
        const part = await retrieveHistory(transport, {
          endpoints, filter, fromBlock: chunk.from, toBlock: chunk.to, initialSpan: span, maxRequests: maxRequests - spent,
          maxMs: maxMinutes * 60_000 - (performance.now() - started), log, ...(state ? { resume: state } : {}),
          onCheckpoint: saver(out, tag, chain.key, strategy, chunk.i, chunk.from, onCheckpoint),
        });
        spent += part.requests - (state?.requests ?? 0);
        parts[chunk.i] = part;
        const learned = part.endpoints.find(use => use.abandonedAt === null)?.learnedMaxSpan;
        if (learned) span = Math.min(initialSpan, learned);
        if (!part.success) { log(`  worker ${w}: chunk ${chunk.i} failed (${part.failure}); worker stops`); break; }
      }
    }));
    const missing = bounds.filter(chunk => parts[chunk.i] === undefined).length;
    if (missing > 0) parts.push({ ...retrieveStub(deployBlock, head), failure: `${missing} chunks not fetched (budget or workers exhausted)` });
    const seen = new Set<string>();
    const merged = parts.filter(Boolean).flatMap(part => part.logs).filter(entry => { const key = `${entry.blockNumber}:${entry.logIndex}`; if (seen.has(key)) return false; seen.add(key); return true; });
    const histogram: Record<string, number> = {};
    for (const part of parts.filter(Boolean)) for (const [bucket, n] of Object.entries(part.spanHistogram)) histogram[bucket] = (histogram[bucket] ?? 0) + n;
    const sum = (f: (p: RetrieveResult) => number) => parts.filter(Boolean).reduce((total, part) => total + f(part), 0);
    result = {
      success: missing === 0 && parts.every(part => part.success), failure: [...new Set(parts.map(part => part.failure).filter(Boolean))].join(' | ') || null,
      fromBlock: deployBlock, toBlock: head, checkpoint: Math.min(...bounds.map(chunk => (parts[chunk.i]?.success ? head + 1 : parts[chunk.i]?.checkpoint ?? chunk.from))),
      logs: merged, requests: sum(p => p.requests), okRequests: sum(p => p.okRequests), responseBytes: sum(p => p.responseBytes), requestBytes: sum(p => p.requestBytes),
      totalMs: performance.now() - started, fetchMs: sum(p => p.fetchMs), endpointSwitches: sum(p => p.endpointSwitches), spanHistogram: histogram,
      endpoints: mergeUses(parts.filter(Boolean)),
    };
  }
  const refPath = join(out, tag, `reference-${chain.key}.json`);
  const ref = existsSync(refPath) ? await readJson<ReferenceFile>(refPath) : null;
  let comparison = null;
  if (ref?.reference && ref.reference.identities.length > 0) {
    const refHead = ref.rpcHead ?? head;
    const inWindow = result.logs.filter(entry => entry.blockNumber <= refHead).map(entry => parseKeyed(formatKeyed(entry)));
    comparison = compareSets(ref.reference.identities.map(parseKeyed), inWindow);
  }
  const { logs, ...rest } = result;
  const blockTime = async (block: number | undefined): Promise<string | null> => {
    if (block === undefined) return null;
    for (const url of order) {
      const call = await rpc(transport, url, 'eth_getBlockByNumber', [toHex(block), false], z.object({ timestamp: quantity }).passthrough());
      if (call.result) return new Date(call.result.timestamp * 1000).toISOString();
    }
    return null;
  };
  const times = { firstTime: await blockTime(logs[0]?.blockNumber), lastTime: await blockTime(logs.at(-1)?.blockNumber) };
  const file: RetrieveFile & { deployBlock: number; deploySource: string | null } = {
    chain: chain.key, measuredAt: new Date().toISOString(), filter, strategy, endpointOrder: order.map(url => new URL(url).host), initialSpan,
    result: { ...rest, count: logs.length, firstBlock: logs[0]?.blockNumber ?? null, lastBlock: logs.at(-1)?.blockNumber ?? null, ...times },
    identities: tag === 'canonical' ? logs.map(formatKeyed) : [],
    comparison, referenceSource: ref?.reference?.source ?? null, deployBlock, deploySource,
  };
  if (tag !== 'canonical') (file as unknown as Record<string, unknown>).perMonthBlocks = bucketByBlock(logs.map(entry => entry.blockNumber), deployBlock, head, chain.blockSeconds);
  await writeJson(join(out, tag, `retrieve-${chain.key}-${strategy}.json`), file);
  log(`[${chain.key}] ${tag} ${strategy}: ${result.success ? 'OK' : `FAILED (${result.failure})`} ${logs.length} logs, ${result.requests} requests, ${(result.totalMs / 1000).toFixed(0)} s${comparison ? `, exact=${comparison.exact}` : ''}`);
}

/** Rough per-30-day counts from block numbers (no timestamps needed). */
function bucketByBlock(blocks: number[], from: number, head: number, blockSeconds: number): { blocksPer30d: number; buckets: number[] } {
  const per = Math.round((30 * 86400) / blockSeconds);
  const buckets = new Array(Math.max(1, Math.ceil((head - from + 1) / per))).fill(0);
  for (const block of blocks) buckets[Math.floor((block - from) / per)]++;
  return { blocksPer30d: per, buckets };
}

// ---------- main ----------
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      stage: { type: 'string', default: 'all' },
      chains: { type: 'string', default: CHAINS.map(chain => chain.key).join(',') },
      output: { type: 'string', default: 'data/phase3' },
      strategy: { type: 'string', default: 'list-order,probe-informed' },
      'max-requests': { type: 'string', default: '8000' },
      'umbra-strategy': { type: 'string', default: 'probe-informed' },
      'max-minutes': { type: 'string', default: '90' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('bun run phase3 --stage endpoints|reference|probe|retrieve|umbra|report|all [--chains a,b] [--output data/phase3] [--strategy list-order,probe-informed] [--max-requests 8000]\n');
    return;
  }
  const out = resolve(values.output);
  const chains = values.chains.split(',').map(chainByKey);
  const transport = new PoliteHttp({ minIntervalMs: 250 });
  const slowTransport = new PoliteHttp({ minIntervalMs: 400, timeoutMs: 90_000 }); // indexers: fewer, heavier calls
  const stages = values.stage === 'all' ? ['endpoints', 'reference', 'probe', 'retrieve', 'umbra', 'report'] : values.stage.split(',');
  const strategies = values.strategy.split(',') as Strategy[];
  const maxRequests = Number(values['max-requests']);
  maxMinutes = Number(values['max-minutes']);
  log(`User-Agent: ${USER_AGENT}`);
  for (const stage of stages) {
    if (stage === 'endpoints') await stageEndpoints(transport, out);
    else if (stage === 'reference') await mapLimit(chains, 3, chain => stageReference(slowTransport, chain, out, CANONICAL, 'canonical'));
    else if (stage === 'probe') await mapLimit(chains, 2, chain => stageProbe(transport, chain, out));
    else if (stage === 'retrieve') {
      await mapLimit(chains, 4, async chain => { for (const strategy of strategies) await stageRetrieve(transport, chain, out, strategy, CANONICAL, 'canonical', maxRequests); });
    } else if (stage === 'umbra-reference') await mapLimit(chains, 3, chain => stageReference(slowTransport, chain, out, UMBRA, 'umbra'));
    else if (stage === 'umbra') {
      await mapLimit(chains, 3, chain => stageReference(slowTransport, chain, out, UMBRA, 'umbra'));
      await mapLimit(chains, 4, chain => stageRetrieve(transport, chain, out, 'probe-informed', UMBRA, 'umbra', maxRequests));
    } else if (stage === 'verify-deploy') await mapLimit(chains, 4, chain => stageVerifyDeploy(transport, chain, out, CANONICAL.address, 'canonical'));
    else if (stage === 'umbra-verify-deploy') await mapLimit(chains, 4, chain => stageVerifyDeploy(transport, chain, out, UMBRA.address, 'umbra'));
    else if (stage === 'umbra-retrieve') await mapLimit(chains, 4, chain => stageRetrieve(transport, chain, out, values['umbra-strategy'] as Strategy, UMBRA, 'umbra', maxRequests));
    else if (stage === 'consistency') await mapLimit(chains, 3, chain => stageConsistency(transport, chain, out));
    else if (stage === 'report') await buildReport(out);
    else throw new Error(`unknown stage ${stage}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
