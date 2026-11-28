// Loads recorded results from data/ for `bun run figures` and `bun run tables`.
// Everything here reads committed files only; nothing touches the network.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { median } from '../shared/stats.ts';
import { chainState, loadBaseline, loadSnapshots, type ChainState, type RefreshSnapshot } from '../chain-volume/refresh-state.ts';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const path = (relative: string) => `${ROOT}${relative}`;

export type Row = Record<string, string>;

/** RFC 4180 CSV: quoted fields, doubled quotes, no embedded newlines in this repo's files. */
export function parseCsv(text: string): Row[] {
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cell); cell = ''; }
      else cell += c;
    }
    cells.push(cell);
    return cells;
  };
  const [header, ...lines] = text.split('\n').filter(line => line.length > 0).map(parseLine);
  if (!header) return [];
  return lines.map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ''])));
}

export const readCsv = (relative: string) => parseCsv(readFileSync(path(relative), 'utf8'));
export const readJson = <T = any>(relative: string): T => JSON.parse(readFileSync(path(relative), 'utf8')) as T;

export const num = (value: string | undefined): number | null =>
  value === undefined || value === '' ? null : Number(value);

/** Median, min and max of a non-empty sample list. */
export function spreadOf(values: readonly number[]) {
  if (values.length === 0) throw new Error('empty sample list');
  return { median: median(values)!, min: Math.min(...values), max: Math.max(...values) };
}

// ---- scan cost ----------------------------------------------------------------

export interface ScanHost { host: string; cpu: string; before: number; after: number; million: number }
export function scanCost(): ScanHost[] {
  const rows = readCsv('data/scan-cost/results.csv');
  const hosts = [...new Set(rows.map(r => r.host!))];
  return hosts.map(host => {
    const get = (observation: string) => {
      const row = rows.find(r => r.host === host && r.observation === observation);
      if (!row) throw new Error(`scan-cost: ${host} has no ${observation}`);
      return Number(row.scan_seconds);
    };
    return { host, cpu: rows.find(r => r.host === host)!.cpu!, before: get('control_before'), after: get('control_after'), million: get('million_run') };
  });
}

// ---- paged discovery ----------------------------------------------------------

export const pagedRepeat = () => readCsv('data/paged-discovery/repeat.csv');
export const pagedSingle = () => readCsv('data/paged-discovery/single-run.csv');
/** Crypto-engine 100k controls bracketing a paged-discovery run, in seconds. */
export const pagedControls = (dir: string) => readFileSync(path(`data/paged-discovery/${dir}/controls.jsonl`), 'utf8').trim().split('\n')
  .map(line => JSON.parse(line)).map(c => ({ label: c.label as string, seconds: (c.scanMs as number) / 1000 }));

// ---- chain volume -------------------------------------------------------------

export const STRATEGIES = ['list-order', 'probe-informed', 'parallel'] as const;
export type Strategy = typeof STRATEGIES[number];
export interface ChainRun { strategy: Strategy; success: boolean; requests: number; seconds: number; count: number }
export interface Chain { chain: string; canonical: number; umbra: number | null; runs: ChainRun[] }

export const CHAIN_LABELS: Record<string, string> = {
  ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum One', optimism: 'OP Mainnet',
  gnosis: 'Gnosis', polygon: 'Polygon PoS', sepolia: 'Sepolia',
};

export function chainVolume(): Chain[] {
  return readCsv('data/chain-volume/summary.csv').map(row => {
    const runs = STRATEGIES.flatMap((strategy): ChainRun[] => row[`${strategy}:requests`] ? [{
      strategy,
      success: row[`${strategy}:success`] === 'true',
      requests: Number(row[`${strategy}:requests`]),
      seconds: Number(row[`${strategy}:seconds`]),
      count: Number(row[`${strategy}:count`]),
    }] : []);
    // The canonical count is the full-history count of a run that reached head.
    const complete = runs.filter(run => run.success);
    if (complete.length === 0) throw new Error(`chain-volume: no complete run for ${row.chain}`);
    const counts = new Set(complete.map(run => run.count));
    if (counts.size !== 1) throw new Error(`chain-volume: complete runs disagree for ${row.chain}`);
    let umbra: number | null = null;
    for (const strategy of ['probe-informed', 'parallel']) {
      try {
        const result = readJson(`data/chain-volume/umbra/retrieve-${row.chain}-${strategy}.json`).result;
        if (result.success) umbra = result.count;
      } catch { /* not run for this strategy */ }
    }
    return { chain: row.chain!, canonical: [...counts][0]!, umbra, runs };
  });
}

/** A recorded full-history retrieval of the canonical Announcer, or null if that strategy was not run. */
export function chainRetrieval(chain: string, strategy: string): any | null {
  try { return readJson(`data/chain-volume/canonical/retrieve-${chain}-${strategy}.json`); } catch { return null; }
}
/** The complete retrieval a chain's count comes from: parallel where it reached head, else probe-informed. */
export function bestRetrieval(chain: string): any {
  const parallel = chainRetrieval(chain, 'parallel');
  return parallel?.result.success ? parallel : chainRetrieval(chain, 'probe-informed');
}
/** Announcements per 30.44-day month, first announcement to measurement, as in report.ts. */
export const perMonth = (retrieval: any) =>
  retrieval.result.count / ((Date.parse(retrieval.measuredAt) - Date.parse(retrieval.result.firstTime)) / (30.44 * 86400_000));

/** Weekly refresh: the 2026-11-26 baseline plus every agreed increment in data/chain-volume/refresh/. */
export const refreshSnapshots = (): RefreshSnapshot[] => loadSnapshots(path('data/chain-volume'));
export const chainLatest = (chain: string): ChainState => chainState(loadBaseline(path('data/chain-volume'), chain), refreshSnapshots());

/** Consistency recheck: per endpoint, the outcome of each attempt at each known announcement. */
export interface ConsistencyEndpoint { chain: string; host: string; checks: { target: string; outcome: string }[] }
export const consistency = (chain: string): ConsistencyEndpoint[] =>
  readJson(`data/chain-volume/consistency/${chain}.json`).endpoints.map((e: any) => ({ chain, host: e.host, checks: e.checks }));

// ---- browser discovery --------------------------------------------------------

export const browserSamples = () => readCsv('data/browser-discovery/samples.csv');

// ---- RPC recovery -------------------------------------------------------------

export interface RecoveryRun {
  name: string; mode: string; requests: number; fallbackWindows: number; finalNext: number;
  observed: number; missing: number; committedMissing: number | null; unprocessedExpected: number | null;
  stop: string | null; catchUpMs: number | null; elapsedMs: number;
}
export const recoveryRuns = () => readJson<RecoveryRun[]>('data/rpc-recovery/summary.json');
export const recoveryRun = (name: string, mode: string) => {
  const run = recoveryRuns().find(r => r.name === name && r.mode === mode);
  if (!run) throw new Error(`rpc-recovery: no ${name}/${mode}`);
  return run;
};
/** Live run timeline: per window, when its last log request ended (ms from the first request) and logs accepted so far. */
export function recoveryTimeline(name: string, mode: string) {
  const run = readJson(`data/rpc-recovery/${name}-${mode}.json`);
  const t0 = run.resourceTimings[0].startTime as number;
  const ends = new Map<number, number>();
  run.requests.forEach((req: any, i: number) => {
    if (req.request.method !== 'eth_getLogs') return;
    const timing = run.resourceTimings[i];
    if (`${req.endpoint}/` !== timing.name) throw new Error(`rpc-recovery: ${name} request ${i} does not match its resource timing`);
    const from = Number(req.request.params[0].fromBlock);
    ends.set(from, Math.max(ends.get(from) ?? 0, timing.startTime + timing.duration - t0));
  });
  let accepted = 0;
  const points = (run.windows as any[]).map(w => ({ ms: ends.get(w.from)!, accepted: (accepted += w.accepted.length) }));
  return { elapsedMs: run.elapsedMs as number, points };
}
export function recoveryReference() {
  const ref = readJson('data/rpc-recovery/reference.json');
  return { windows: ref.windows.length as number, expected: (ref.expected as unknown[]).length, pageBlocks: ref.scope.pageBlocks as number };
}

// ---- shared feed --------------------------------------------------------------

export type FeedKey = 'rpc-cold' | 'rpc-warm' | 'dual-cold' | 'dual-warm';
export interface FeedSummary {
  expected: number[]; observed: number[]; posts: number[]; gets: number[]; requestBytes: number[]; responseBytes: number[];
  fetchMs: number[]; scanMs: number[]; verificationMs: number[]; elapsedMs: number[]; firstSyntheticMatchMs: number[];
}
/** Omission and resume controls from the verified shared-feed summary. */
export const feedControls = () => readJson('data/shared-feed/summary.json').controls as Record<'omit' | 'hold' | 'resume' | 'altered',
  { expected: number; observed: number; gets: number; elapsedMs: number }>;
export const feedEvidence = (host = '') => readJson(`data/shared-feed/${host ? `${host}/` : ''}evidence.json`);
/** Feed format search log: one row per iteration. */
export const feedBytesLog = () => readFileSync(path('data/shared-feed/autoresearch/feed-bytes.jsonl'), 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as { run: number; description: string; status: string; metric: number; metrics: Record<string, string> });
export const feedSummary = (host = '') =>
  readJson<{ summaries: Record<FeedKey, FeedSummary> }>(`data/shared-feed/${host ? `${host}/` : ''}summary.json`).summaries;

/** Hosts with a remote-feed run, as directory names under data/shared-feed/remote/. */
export const REMOTE_HOSTS = ['bazzite', 'turing-node-3'];
export type RemoteSummary = FeedSummary & { wireBytes: number[]; cacheHits: number[]; feed1PageMs: number[]; feed2PageMs: number[] };
export const remoteSummary = (host: string) =>
  readJson<{ summaries: Record<`remote-${'' | 'concurrent-'}${'cold' | 'warm'}`, RemoteSummary> }>(`data/shared-feed/remote/${host}/summary.json`).summaries;

/**
 * Live RPC samples without the client's own pacing: the recorded request, scan and verification
 * time, which are sequential in rpc mode. What is left of the wall time is the ≥275 ms start-to-start
 * wait (plus checkpoint writes, under 1 ms per page).
 */
export function rpcUnpaced(host = '') {
  const samples = feedEvidence(host).samples as Record<string, { elapsedMs: number; scanMs: number; verificationMs: number; requests: { fetchMs: number }[] }>;
  const of = (mode: 'cold' | 'warm') => [1, 2, 3].map(round => {
    const s = samples[`rpc-${mode}-${round}`]!;
    const busyMs = s.requests.reduce((sum, r) => sum + r.fetchMs, 0) + s.scanMs + s.verificationMs;
    return { busyMs, waitMs: s.elapsedMs - busyMs, elapsedMs: s.elapsedMs };
  });
  return { cold: of('cold'), warm: of('warm') };
}

// ---- scan engines -------------------------------------------------------------

export const ENGINE_HOSTS = ['bazzite', 'turing-node-1'] as const;
export const ENGINE_RUNS = ['control-before', 'sdk-crypto-noble', 'fast-small', 'fast-large', 'control-after'] as const;
export interface EngineRow {
  host: string; run: string; count: number; case: 'zero' | 'sparse'; engine: string; threads: number;
  samples: number; medianMs: number; minMs: number; maxMs: number; cpuMsMedian: number;
}
/** Every recorded scan-engine scenario, from each run's samples.jsonl. */
export function scanEngines(): EngineRow[] {
  return ENGINE_HOSTS.flatMap(host => ENGINE_RUNS.flatMap(run => {
    const samples = readFileSync(path(`data/scan-cost/engines/${host}/${run}/samples.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const groups = new Map<string, any[]>();
    for (const s of samples) {
      if (s.verified !== true) throw new Error(`scan-engines: unverified sample in ${host}/${run}`);
      const key = JSON.stringify([s.count, s.matchEvery, s.engine, s.threads ?? 1]);
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    return [...groups.values()].map(group => {
      const first = group[0]!;
      const times = spreadOf(group.map(s => s.scanMs as number));
      return {
        host, run, count: first.count, case: first.matchEvery === 0 ? 'zero' : 'sparse', engine: first.engine, threads: first.threads ?? 1,
        samples: group.length, medianMs: times.median, minMs: times.min, maxMs: times.max,
        cpuMsMedian: median(group.map(s => (s.cpuUserMs as number) + (s.cpuSystemMs as number)))!,
      } as EngineRow;
    });
  }));
}

/** Seconds per announcement for one engine and thread count: the median over its 100k and 1M, zero and sparse scans. */
export function perAnnouncement(rows: readonly EngineRow[], host: string, engine: string, threads: number, cpu = false): number | null {
  const values = rows.filter(r => r.host === host && !r.run.startsWith('control') && r.engine === engine && r.threads === threads)
    .map(r => (cpu ? r.cpuMsMedian : r.medianMs) / 1000 / r.count);
  return values.length === 0 ? null : median(values)!;
}

export interface EngineHeadline { host: string; sdk: number; wasm: number; native: number; best: { engine: string; threads: number; seconds: number } }
/** Per host: SDK, single-thread WASM and native seconds per announcement, and the fastest wall-clock scenario. */
export function engineHeadlines(): EngineHeadline[] {
  const rows = scanEngines();
  return ENGINE_HOSTS.map(host => {
    const get = (engine: string, threads = 1) => {
      const value = perAnnouncement(rows, host, engine, threads);
      if (value === null) throw new Error(`scan-engines: ${host} has no ${engine}/${threads}t`);
      return value;
    };
    const candidates = rows.filter(r => r.host === host && r.engine !== 'crypto' && r.engine !== 'sdk')
      .map(r => ({ engine: r.engine, threads: r.threads, seconds: perAnnouncement(rows, host, r.engine, r.threads)! }));
    const best = candidates.sort((a, b) => a.seconds - b.seconds)[0]!;
    return { host, sdk: get('sdk'), wasm: get('wasm'), native: get('native'), best };
  });
}

// ---- spam cost ------------------------------------------------------------------

export const SPAM_CHAIN_ORDER = ['ethereum', 'base', 'arbitrum', 'optimism', 'gnosis', 'polygon', 'sepolia'] as const;
const SPAM_NATIVE: Record<string, string | null> = {
  ethereum: 'ethereum', base: 'ethereum', arbitrum: 'ethereum', optimism: 'ethereum', gnosis: 'xdai', polygon: 'polygon-ecosystem-token', sepolia: null,
};
const SPAM_NATIVE_LABEL: Record<string, string> = { ethereum: 'ETH', xdai: 'xDAI', 'polygon-ecosystem-token': 'POL' };
/** Announcements per batch transaction assumed for the batched cost; the fixed per-transaction gas is spread over it. */
export const SPAM_BATCH = 1000;
const BLOCK_SECONDS: Record<string, number> = { ethereum: 12, base: 2, arbitrum: 0.25, optimism: 2, gnosis: 5, polygon: 2, sepolia: 12 };

export interface SpamCost {
  chain: string; measuredAt: string; url: string;
  directGas: number; marginalGas: number; batchedGas: number; receiptGas: number[];
  baseFeeWei: number; tipWei: number; l1FeeWeiPerTx: number; native: string | null; nativeUsd: number | null;
  /** USD per announcement, batched; null on a testnet. */
  usdPerAnnouncement: number | null;
  /** Share of the chain's daily block gas limit used by 1M batched announcements; null when the limit is not a throughput cap. */
  blockShareAt1M: number | null;
}

/** Cost of one batched announcement per chain, from data/spam-cost/ (bun run spam-cost). */
export function spamCost(): { chains: SpamCost[]; pricesAt: string; priceSource: string } {
  const prices = readJson('data/spam-cost/prices.json');
  const chains = SPAM_CHAIN_ORDER.map(chain => {
    const d = readJson(`data/spam-cost/${chain}.json`);
    if (d.failed) throw new Error(`spam-cost: ${chain} has no successful probe`);
    const gas = (x: any) => Number(BigInt(x.result));
    const directGas = gas(d.direct);
    const one = gas(d.batch['1']), many = gas(d.batch['101']);
    const marginalGas = (many - one) / 100;
    const batchedGas = marginalGas + (one - marginalGas) / SPAM_BATCH;
    const baseFeeWei = median(d.fees.result.baseFeePerGas.slice(0, -1).map((h: string) => Number(BigInt(h))))!;
    const tipWei = median(d.fees.result.reward.map((r: string[]) => Number(BigInt(r[0]!))))!;
    const l1FeeWeiPerTx = d.l1 ? Number(BigInt(d.l1.getL1Fee.result)) : 0;
    const native = SPAM_NATIVE[chain]!;
    const nativeUsd = native ? prices.body[native].usd as number : null;
    const wei = batchedGas * (baseFeeWei + tipWei) + l1FeeWeiPerTx / SPAM_BATCH;
    const daily = (d.head.gasLimit as number) * 86400 / BLOCK_SECONDS[chain]!;
    return {
      chain, measuredAt: d.measuredAt, url: d.url, directGas, marginalGas, batchedGas,
      receiptGas: d.receipts.filter((r: any) => r.gasUsed && r.to === '0x55649e01b5df198d18d95b5cc5051630cfd45564' && r.announcerLogs === 1).map((r: any) => r.gasUsed),
      baseFeeWei, tipWei, l1FeeWeiPerTx, native: native ? SPAM_NATIVE_LABEL[native]! : null, nativeUsd,
      usdPerAnnouncement: nativeUsd === null ? null : wei / 1e18 * nativeUsd,
      blockShareAt1M: chain === 'arbitrum' ? null : 1e6 * batchedGas / daily,
    };
  });
  return { chains, pricesAt: prices.fetchedAt, priceSource: prices.source };
}

// ---- omission cause ---------------------------------------------------------------

export interface OmissionRow { chain: string; host: string; probes: number; omitted: number; noReceipt: number; canaryEmpty: number; caught: number; otherSizes: number }
/** Per suspect provider: how often it omitted a known announcement, and how often a Transfer canary in the same block was empty too. */
export function omissionCause(): OmissionRow[] {
  return ['base', 'optimism'].flatMap(chain => {
    const d = readJson(`data/omission-cause/${chain}.json`);
    const control = new Map<string, any>();
    for (const p of d.providers) if (p.control) for (const q of p.probes) control.set(`${p.pass}:${q.block}`, q);
    const empty = (x: any) => typeof x?.count !== 'number' || x.count === 0;
    const rows = new Map<string, OmissionRow>();
    for (const p of d.providers) {
      if (p.control) continue;
      const host = new URL(p.url).host;
      const row = rows.get(host) ?? { chain, host, probes: 0, omitted: 0, noReceipt: 0, canaryEmpty: 0, caught: 0, otherSizes: 0 };
      for (const q of p.probes) {
        const c = control.get(`${p.pass}:${q.block}`);
        if (!c?.announcerOneBlock?.hasTarget || empty(c.canaryTransfers)) throw new Error(`omission-cause: control failed at ${q.block}`);
        row.probes++;
        const omitted = !q.announcerOneBlock?.hasTarget;
        const canary = empty(q.canaryTransfers);
        if (omitted) row.omitted++;
        if (!q.receipt?.hasTarget) row.noReceipt++;
        if (canary) row.canaryEmpty++;
        if (omitted && canary) row.caught++;
        if (omitted && [q.announcer50, q.announcer1000, q.announcerByHash, q.topicOnlyOneBlock].some(x => x?.hasTarget)) row.otherSizes++;
      }
      rows.set(host, row);
    }
    return [...rows.values()];
  });
}

// ---- freshness ------------------------------------------------------------------

export interface Freshness {
  chain: string; samples: number; minutes: number;
  /** Seconds from a block's timestamp to the sample receiving it as `latest`: when an RPC-only or hybrid wallet can first see it. */
  headAgeS: number;
  /** Seconds from mined to finalized, per finality step: median of the step means, and the largest. */
  finalMedianS: number | null; finalMaxS: number | null; steps: number;
  tailBlocks: number; tailRequests: number; tailBytes: number; tailMs: number;
  /** Block numbers seen as `latest` with two different hashes. */
  reorgs: number; errors: number;
}
/** Header sampling and RPC tail polls from data/freshness/ (bun run freshness). */
export function freshness(): Freshness[] {
  return ['ethereum', 'base', 'arbitrum', 'optimism', 'gnosis', 'polygon', 'sepolia'].map(chain => {
    const d = readJson(`data/freshness/${chain}.json`);
    const ok = d.samples.filter((s: any) => s.latest.block && s.finalized.block && s.tail.every((t: any) => t.logs));
    const steps: { mean: number; max: number }[] = [];
    for (let i = 1; i < ok.length; i++) {
      const a = ok[i - 1].finalized.block, b = ok[i].finalized.block;
      if (b.number <= a.number) continue;
      const t = ok[i].finalized.receivedAt / 1000;
      steps.push({ mean: t - (a.timestamp + b.timestamp) / 2, max: t - a.timestamp });
    }
    const seen = new Map<number, string>();
    let reorgs = 0;
    for (const s of ok) {
      const prior = seen.get(s.latest.block.number);
      if (prior !== undefined && prior !== s.latest.block.hash) reorgs++;
      seen.set(s.latest.block.number, s.latest.block.hash);
    }
    const first = d.samples[0].latest.sentAt, last = d.samples.at(-1).latest.sentAt;
    return {
      chain, samples: ok.length, minutes: (last - first) / 60_000,
      headAgeS: median(ok.map((s: any) => s.latest.receivedAt / 1000 - s.latest.block.timestamp))!,
      finalMedianS: steps.length ? median(steps.map(s => s.mean))! : null,
      finalMaxS: steps.length ? Math.max(...steps.map(s => s.max)) : null, steps: steps.length,
      tailBlocks: median(ok.map((s: any) => s.latest.block.number - s.finalized.block.number))!,
      tailRequests: median(ok.map((s: any) => s.tail.length))!,
      tailBytes: median(ok.map((s: any) => s.tail.reduce((n: number, t: any) => n + t.bytes, 0)))!,
      tailMs: median(ok.map((s: any) => s.tail.reduce((n: number, t: any) => n + t.ms, 0)))!,
      reorgs, errors: d.samples.length - ok.length,
    };
  });
}

// ---- real announcements ---------------------------------------------------------

export const realScan = () => readJson<{ measuredAt: string; chains: {
  chain: string; announcements: number; parsed: number; clean: number; defects: Record<string, number>;
  scheme1KeyBytes: Record<string, number>; crypto: { matches: number; errors: number };
  sdkWholeBatch: { ok: boolean; matches: number | null; error: string | null }; sdkThrowsAlone: string[];
}[] }>('data/real-announcements/scan.json');
export const realTiming = (host: string) => readJson<{ host: string; timing: { clean: number; all: number; reps: number; cpu: string; cleanMs: number[]; syntheticMs: number[]; allMs: number[] } }>(`data/real-announcements/timing-${host}.json`);

// ---- phone bench ----------------------------------------------------------------

/** Accepted phone bench results in data/phone-bench/ (bun run phone-bench:record). */
export function phoneResults(): Record<string, any>[] {
  let files: string[] = [];
  try { files = readdirSync(path('data/phone-bench')).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
  return files.map(f => readJson(`data/phone-bench/${f}`));
}
/** JavaScriptCore runs of the page's scan code outside a browser (bun run phone-bench:cli). */
export const phoneProxies = (): Record<string, any>[] =>
  readdirSync(path('data/phone-bench/proxy')).filter(f => f.endsWith('.json')).sort().map(f => readJson(`data/phone-bench/proxy/${f}`));
