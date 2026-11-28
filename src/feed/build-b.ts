// Feed B: an independent producer of the same format. It shares no code with feed A or
// src/feed/format.ts: its own JSON-RPC client, pager, pacing, codec and checks. It imports only
// the source list, the chain list and node built-ins, so a bug in one producer's pipeline does
// not reach the other's output. Both producers are still run by one operator (docs/feed-format.md).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Source } from './sources.ts';

const CONTRACT = '0x55649e01b5df198d18d95b5cc5051630cfd45564';
const TOPIC0 = '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7';

export type Post = (url: string, body: string) => Promise<{ status: number; text: string }>;
export interface TargetB { key: string; chainId: number; deployBlock: number; pageBlocks?: number; maxBlock?: number }
export interface OptionsB {
  post: Post; chains: TargetB[]; sources: Record<string, [Source, Source]>; outDir: string; seedDir?: string;
  log?: (line: string) => void; now?: () => string; pause?: (ms: number) => Promise<void>;
}

type Log = { block: number; blockHash: string; txHash: string; logIndex: number; txIndex: number; topics: string[]; data: string };
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const isHex = (value: unknown, bytes?: number): value is string => typeof value === 'string' &&
  (bytes === undefined ? /^0x([0-9a-fA-F]{2})*$/ : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)).test(value);
const qty = (value: unknown) => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`bad quantity ${String(value)}`);
  const n = parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(n)) throw new Error('quantity too large');
  return n;
};

/** One JSON-RPC client per run: per-host start-to-start pacing, retries on 429/5xx/timeouts. */
function client(post: Post, pause: (ms: number) => Promise<void>) {
  const next = new Map<string, number>();
  let id = 0;
  const requests = new Map<string, number>();
  async function call(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: string }> {
    for (let attempt = 0; ; attempt++) {
      const host = new URL(url).host;
      const wait = (next.get(host) ?? 0) - Date.now();
      next.set(host, Math.max(Date.now(), next.get(host) ?? 0) + 260);
      if (wait > 0) await pause(wait);
      requests.set(url, (requests.get(url) ?? 0) + 1);
      let status = 0;
      let text = '';
      try {
        ({ status, text } = await post(url, JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })));
      } catch (error) {
        text = String(error);
      }
      let parsed: { result?: unknown; error?: { message?: string } } | undefined;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      if (status === 200 && parsed && 'result' in parsed) return { result: parsed.result };
      const message = parsed?.error?.message ?? `HTTP ${status} ${text.slice(0, 120)}`;
      const transient = status === 0 || status === 429 || status >= 500 || /rate|too many|timeout|busy|try again/i.test(message);
      if (!transient || attempt >= 4) return { error: message };
      await pause(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
  return { call, count: (url: string) => requests.get(url) ?? 0 };
}

function parseLog(raw: unknown): Log {
  const log = raw as Record<string, unknown>;
  const topics = log.topics as unknown[];
  if (String(log.address).toLowerCase() !== CONTRACT || !Array.isArray(topics) || topics.length !== 4 ||
      String(topics[0]).toLowerCase() !== TOPIC0 || log.removed === true || !topics.every(topic => isHex(topic, 32)) ||
      !isHex(log.blockHash, 32) || !isHex(log.transactionHash, 32) || !isHex(log.data)) throw new Error('unexpected log');
  return {
    block: qty(log.blockNumber), blockHash: (log.blockHash as string).toLowerCase(),
    txHash: (log.transactionHash as string).toLowerCase(), logIndex: qty(log.logIndex), txIndex: qty(log.transactionIndex),
    topics: (topics.slice(1) as string[]).map(topic => topic.toLowerCase()), data: (log.data as string).toLowerCase(),
  };
}

/** Fetches [from, to] from one source, halving the span on errors and growing it back after successes. */
async function fetchRange(rpc: ReturnType<typeof client>, source: Source, from: number, to: number,
  state = { span: Math.min(source.span, 100_000), cap: source.span }) {
  const logs: Log[] = [];
  let span = state.span;
  let cursor = from;
  let good = 0;
  let failures = 0;
  while (cursor <= to) {
    const end = Math.min(to, cursor + span - 1);
    const reply = await rpc.call(source.url, 'eth_getLogs', [{ address: CONTRACT, topics: [TOPIC0],
      fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${end.toString(16)}` }]);
    if (reply.error !== undefined || !Array.isArray(reply.result)) {
      // A span that failed is not tried again in this run.
      if (span > 1) { state.cap = Math.min(state.cap, span - 1); span = Math.max(1, Math.floor(span / 2)); good = 0; continue; }
      if (++failures > 3) return { logs, reached: cursor - 1, error: reply.error ?? 'non-array result' };
      continue;
    }
    for (const raw of reply.result) {
      const parsed = parseLog(raw);
      if (parsed.block < cursor || parsed.block > end) throw new Error(`${source.name}: log outside requested range`);
      logs.push(parsed);
    }
    cursor = end + 1;
    failures = 0;
    if (++good >= 4 && span < state.cap) { span = Math.min(state.cap, span * 2); good = 0; }
    state.span = span;
  }
  logs.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  for (let i = 1; i < logs.length; i++) {
    if (logs[i - 1]!.block === logs[i]!.block && logs[i - 1]!.logIndex === logs[i]!.logIndex) throw new Error(`${source.name}: duplicate log`);
  }
  return { logs, reached: to, error: null };
}

// Codec, written separately from src/feed/format.ts against the spec.
const toB64 = (hex: string) => Buffer.from(hex.slice(2), 'hex').toString('base64');
const topicB64 = (hex: string) => toB64('0x' + hex.slice(2).replace(/^(00)+/, ''));
function zeroRuns(hex: string) {
  const pairs = hex.slice(2).match(/../g) ?? [];
  let out = '';
  for (let i = 0; i < pairs.length;) {
    let j = i;
    while (j < pairs.length && pairs[j] === '00') j++;
    if (j - i >= 3) { out += 'g' + (j - i).toString(36) + '.'; i = j; } else { out += pairs[i]; i++; }
  }
  return out;
}
function page(logs: Log[], from: number) {
  if (!logs.length) return '{"r":[]}';
  const deltas: number[] = [];
  let prev = from;
  for (const log of logs) { deltas.push(log.block - prev); prev = log.block; }
  return JSON.stringify({ r: [deltas, logs.map(l => toB64(l.blockHash)), logs.map(l => toB64(l.txHash)),
    logs.map(l => l.logIndex), logs.map(l => l.txIndex), logs.map(l => l.topics.map(topicB64)), logs.map(l => zeroRuns(l.data))] });
}

async function put(path: string, text: string) {
  await writeFile(path + '.part', text);
  await rename(path + '.part', path);
}

type Entry = { from: number; to: number; count: number; sha256: string };
async function seedOf(root: string | undefined, chain: TargetB) {
  const dir = root && join(root, 'v1', String(chain.chainId));
  if (!dir || !existsSync(join(dir, 'manifest.json'))) return null;
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'erc5564-feed/1' || manifest.chainId !== chain.chainId || manifest.deployBlock !== chain.deployBlock) return null;
  const bodies = new Map<string, string>();
  for (const entry of manifest.pages as Entry[]) {
    const body = await readFile(join(dir, 'p', `${entry.sha256}.json`), 'utf8');
    if (digest(body) !== entry.sha256) throw new Error(`${chain.key}: seed page ${entry.from} corrupt`);
    bodies.set(entry.sha256, body);
  }
  return { manifest, bodies };
}

export async function buildFeedB(options: OptionsB) {
  const pause = options.pause ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const rpc = client(options.post, pause);
  return Promise.all(options.chains.map(async chain => {
    const began = performance.now();
    // Requests and time carried over from an interrupted run of this chain (progress.json).
    let before = { requests: [0, 0], elapsedMs: 0 };
    const totals = () => ({ requests: pair.map((source, i) => before.requests[i]! + rpc.count(source.url)),
      elapsedMs: before.elapsedMs + performance.now() - began });
    const step = chain.pageBlocks ?? 1_000_000;
    const pair = options.sources[chain.key]!;
    const dir = join(options.outDir, 'v1', String(chain.chainId));
    await mkdir(join(dir, 'p'), { recursive: true });
    const seed = await seedOf(options.seedDir, chain);
    const report = { chain: chain.key, sources: pair.map(s => s.url), published: null as number | null,
      newPages: 0, stop: null as string | null };
    const write = async (manifest: { finalized: { number: number }; pages: Entry[] }, bodies: Map<string, string>) => {
      for (const entry of manifest.pages) {
        const file = join(dir, 'p', `${entry.sha256}.json`);
        if (!existsSync(file)) await put(file, bodies.get(entry.sha256)!);
      }
      await put(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
      report.published = manifest.finalized.number;
    };
    try {
      const heads: number[] = [];
      for (const source of pair) {
        const id = await rpc.call(source.url, 'eth_chainId', []);
        if (qty(id.result) !== chain.chainId) throw new Error(`${source.name}: chain id ${String(id.result ?? id.error)}`);
        const block = await rpc.call(source.url, 'eth_getBlockByNumber', ['finalized', false]);
        heads.push(qty((block.result as { number?: unknown } | null)?.number));
      }
      const target = Math.min(...heads, chain.maxBlock ?? Infinity);
      const grid: { from: number; to: number }[] = [];
      for (let from = chain.deployBlock; from <= target; from += step) grid.push({ from, to: Math.min(target, from + step - 1) });
      let keep = 0;
      const seeded = (seed?.manifest.pages ?? []) as Entry[];
      while (keep < seeded.length && keep < grid.length && seeded[keep]!.to === grid[keep]!.to && seeded[keep]!.to - seeded[keep]!.from + 1 === step) keep++;
      if (keep === grid.length) { if (seed) await write(seed.manifest, seed.bodies); return report; }
      // Cell by cell, so a long backfill can resume from progress.json after an interruption.
      const progressPath = join(dir, 'progress.json');
      const bodies = new Map(seed?.bodies ?? []);
      const entries: Entry[] = seeded.slice(0, keep);
      if (existsSync(progressPath)) {
        const saved = JSON.parse(await readFile(progressPath, 'utf8')) as { pages: Entry[]; requests?: number[]; elapsedMs?: number };
        before = { requests: saved.requests ?? [0, 0], elapsedMs: saved.elapsedMs ?? 0 };
        for (const entry of saved.pages.slice(keep)) {
          const cell = grid[entries.length];
          const file = join(dir, 'p', `${entry.sha256}.json`);
          if (!cell || cell.from !== entry.from || cell.to !== entry.to || entry.to - entry.from + 1 !== step || !existsSync(file)) break;
          const body = await readFile(file, 'utf8');
          if (digest(body) !== entry.sha256) break;
          bodies.set(entry.sha256, body);
          entries.push(entry);
        }
      }
      const resumed = entries.length;
      const spans = pair.map(source => ({ span: Math.min(source.span, 100_000), cap: source.span }));
      for (const cell of grid.slice(resumed)) {
        let [x, y] = await Promise.all(pair.map((source, i) => fetchRange(rpc, source, cell.from, cell.to, spans[i])));
        if (x!.error !== null || y!.error !== null) { report.stop = `fetch failed in ${cell.from}-${cell.to}: ${x!.error ?? y!.error}`; break; }
        let [p, q] = [page(x!.logs, cell.from), page(y!.logs, cell.from)];
        if (p !== q) {
          [x, y] = await Promise.all(pair.map(source => fetchRange(rpc, source, cell.from, cell.to)));
          if (x!.error !== null || y!.error !== null) { report.stop = `refetch failed at ${cell.from}`; break; }
          [p, q] = [page(x!.logs, cell.from), page(y!.logs, cell.from)];
          if (p !== q) { report.stop = `sources disagree on ${cell.from}-${cell.to}`; break; }
        }
        const sha = digest(p);
        bodies.set(sha, p);
        const file = join(dir, 'p', `${sha}.json`);
        if (!existsSync(file)) await put(file, p);
        entries.push({ from: cell.from, to: cell.to, count: x!.logs.length, sha256: sha });
        report.newPages++;
        if (cell.to - cell.from + 1 === step) await put(progressPath, JSON.stringify({ pages: entries, ...totals() }));
        if (report.newPages % 10 === 0) options.log?.(`[b:${chain.key}] through ${cell.to}, ${totals().requests} requests`);
      }
      if (entries.length === keep) throw new Error(report.stop ?? 'nothing new agreed');
      const last = entries.at(-1)!.to;
      const hashes: string[] = [];
      for (const source of pair) {
        const block = await rpc.call(source.url, 'eth_getBlockByNumber', [`0x${last.toString(16)}`, false]);
        const hash = (block.result as { hash?: unknown } | null)?.hash;
        if (!isHex(hash, 32)) throw new Error(`${source.name}: no hash for ${last}`);
        hashes.push(hash.toLowerCase());
      }
      if (hashes[0] !== hashes[1]) throw new Error(`hash of ${last} differs`);
      await write({
        format: 'erc5564-feed/1', chainId: chain.chainId, contract: CONTRACT, topic0: TOPIC0, deployBlock: chain.deployBlock,
        pageBlocks: step, finalized: { number: last, hash: hashes[0]! }, pages: entries,
        producer: { feed: 'b', sources: pair.map(s => s.url), builtAt: options.now?.() ?? new Date().toISOString(), code: 'src/feed/build-b.ts' },
      } as never, bodies);
      await rm(progressPath, { force: true });
    } catch (error) {
      report.stop ??= String(error);
      if (seed) await write(seed.manifest, seed.bodies);
    }
    return { ...report, ...totals() };
  }));
}

if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const { FEED_CHAINS } = await import('./format.ts');
  const { SOURCES } = await import('./sources.ts');
  const { values } = parseArgs({ options: { out: { type: 'string' }, seed: { type: 'string' }, chains: { type: 'string' }, report: { type: 'string' } } });
  if (!values.out) throw new Error('Usage: bun run feed:build-b --out DIR [--seed DIR] [--chains a,b] [--report FILE]');
  const keys = values.chains?.split(',') ?? FEED_CHAINS.map(chain => chain.key);
  const post: Post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'user-agent': 'erc5564-scan-benchmark/feed-b (public keyless announcement feed)' } });
    return { status: response.status, text: await response.text() };
  };
  const startedAt = new Date().toISOString();
  const reports = await buildFeedB({ post, chains: FEED_CHAINS.filter(chain => keys.includes(chain.key)), sources: SOURCES.b,
    outDir: values.out, ...(values.seed ? { seedDir: values.seed } : {}), log: line => console.log(line) });
  for (const report of reports) console.log(`[b:${report.chain}] published ${report.published} stop ${report.stop}`);
  if (values.report) await writeFile(values.report, JSON.stringify({ feed: 'b', startedAt, finishedAt: new Date().toISOString(), chains: reports }, null, 1) + '\n');
  if (reports.some(report => report.published === null)) process.exitCode = 1;
}
