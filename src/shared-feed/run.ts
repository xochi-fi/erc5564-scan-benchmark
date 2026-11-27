import { mkdir, readFile, rename } from 'node:fs/promises';
import { hostname, release } from 'node:os';
import { generateFixture } from '../shared/fixtures.ts';
import { decodeAnnouncements, type RawLog } from '../shared/raw-logs.ts';
import { getAnnouncementsForUser } from '@scopelift/stealth-address-sdk';
import { filter, hex } from '../shared/announcer.ts';
import { rpc, scope } from '../shared/base-windows.ts';
import { compact, digest, endpoint, expand, loadReference, warmPage, type Feed } from './feed.ts';
import { waitForCooldown } from '../shared/host.ts';

const [output] = Bun.argv.slice(2);
if (!output || !/^(bazzite|turing-node-[123])$/.test(hostname())) {
  throw new Error('Usage on Bazzite or a Turing node: bun run shared-feed NEW_OUTPUT_DIR');
}
await mkdir(output, { recursive: false });
const evidencePath = `${output}/evidence.json`;

type Request = { source: string; operation: string; requestBytes: number; responseBytes: number; fetchMs: number };
function transport() {
  const requests: Request[] = [];
  let nextStart = 0;
  async function read<T>(source: string, url: string, operation: string, body?: string): Promise<T> {
    if (body !== undefined) {
      await Bun.sleep(Math.max(0, nextStart - performance.now()));
      nextStart = performance.now() + 275;
    }
    const start = performance.now();
    const request = { source, operation, requestBytes: Buffer.byteLength(body ?? ''), responseBytes: 0, fetchMs: 0 };
    requests.push(request);
    try {
      const response = await fetch(url, {
        ...(body === undefined ? {} : { method: 'POST', body, headers: { 'content-type': 'application/json' } }),
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      const bytes = await response.arrayBuffer();
      request.responseBytes = bytes.byteLength;
      request.fetchMs = performance.now() - start;
      if (!response.ok) throw new Error(`${source} ${operation} HTTP ${response.status}`);
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } catch (error) {
        throw new Error(`${source} ${operation} invalid JSON`, { cause: error });
      }
    } finally {
      if (!request.fetchMs) request.fetchMs = performance.now() - start;
    }
  }
  async function call<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const id = requests.length + 1;
    const result = await read<{ id: number; jsonrpc: string; result: T; error?: unknown }>(
      new URL(url).hostname, url, method, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (result.id !== id || result.jsonrpc !== '2.0' || result.error || !Object.hasOwn(result, 'result')) {
      throw new Error(`${method} failed`);
    }
    return result.result;
  }
  return { read, call, requests };
}

async function assertFinalized(url: string, io: ReturnType<typeof transport>, hash: string) {
  if (await io.call(url, 'eth_chainId', []) !== scope.chainId) throw new Error('Wrong chain');
  const finalized = await io.call<{ number: string }>(url, 'eth_getBlockByNumber', ['finalized', false]);
  const pinned = await io.call<{ number: string; hash: string }>(url, 'eth_getBlockByNumber', [hex(scope.head), false]);
  if (!Number.isSafeInteger(Number(finalized.number)) || Number(finalized.number) < scope.head ||
      Number(pinned.number) !== scope.head || pinned.hash.toLowerCase() !== hash) throw new Error('Wrong finalized scope');
  return Number(finalized.number);
}

const buildStart = performance.now();
const feed = await loadReference();
const validation = await Promise.all([rpc.tenderly, rpc.sentio].map(async url => {
  const io = transport();
  const finalized = await assertFinalized(url, io, feed.manifest.headHash);
  return { source: new URL(url).hostname, finalized, requests: io.requests };
}));

function host(pages: Feed['primary'], change?: 'omit' | 'payload') {
  const manifest = JSON.stringify(feed.manifest);
  const pagePath = new RegExp(`^/${feed.id}/(0|[1-9][0-9]*)$`);
  const bodies = pages.map(page => {
    const rows = page.rows;
    if (change === 'omit') return JSON.stringify({ ...page, rows: [] });
    if (change === 'payload' && rows.length) {
      const [first, ...rest] = rows;
      const row = structuredClone(first!);
      row[6] = row[6].slice(0, -2) + (row[6].endsWith('00') ? '01' : '00');
      return JSON.stringify({ ...page, rows: [row, ...rest] });
    }
    return JSON.stringify(page);
  });
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.search) return new Response(null, { status: 404 });
      const index = pagePath.exec(url.pathname)?.[1];
      const body = url.pathname === '/manifest' ? manifest : index === undefined ? undefined : bodies[Number(index)];
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body, {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable' },
      });
    },
  });
}

const primary = host(feed.primary);
const secondary = host(feed.secondary);
const buildMs = performance.now() - buildStart;
const omit = host(feed.primary, 'omit');
const altered = host(feed.primary, 'payload');

const fixtureDir = `${output}/synthetic`;
// kept: recorded evidence depends on it
const synthetic = await generateFixture(fixtureDir, { seed: 'phase6:base:v1', count: 4, matchEvery: 2 });
const fixtures = (await Bun.file(`${fixtureDir}/announcements.jsonl`).text()).trim().split('\n')
  .map(line => JSON.parse(line) as RawLog);
const fixturePages = [2, 2, warmPage + 1, warmPage + 1];

type PageSummary = { index: number; count: number; digest: string; syntheticMatches: number; canonicalMatches: number };
type Checkpoint = { id: string; next: number; block: number; pages: PageSummary[] };
type Mode = 'rpc' | 'dual' | 'single';
async function scan(name: string, mode: Mode, urls: URL[], limit = feed.primary.length) {
  const checkpointPath = `${output}/${name}.checkpoint.json`;
  const file = Bun.file(checkpointPath);
  const io = transport();
  const start = performance.now();
  const state: Checkpoint = await file.exists() ? await file.json() : {
    id: feed.id, next: 0, block: scope.start - 1, pages: [],
  };
  const initialNext = state.next;
  const initialBlock = state.block;
  if (state.id !== feed.id || !Number.isSafeInteger(state.next) || state.next < 0 || state.next > limit ||
      state.pages.length !== state.next || state.block !== (feed.manifest.pages[state.next - 1]?.at(-1)?.to ?? scope.start - 1)) {
    throw new Error('Wrong checkpoint');
  }
  let verificationMs = 0;
  let scanMs = 0;
  let firstSyntheticMatchMs: number | null = null;
  let firstCanonicalMatchMs: number | null = null;
  let stop: string | null = null;
  const retries: number[] = [];
  const attemptPages: number[] = [];
  try {
    if (mode === 'rpc') await assertFinalized(endpoint, io, feed.manifest.headHash);
    else await Promise.all(urls.map(async (url, i) => {
      const manifest = await io.read<unknown>(`feed-${i + 1}`, new URL('/manifest', url).href, 'manifest');
      if (digest(manifest) !== feed.id) throw new Error('Wrong feed manifest');
    }));

    for (let index = state.next; index < limit; index++) {
      const windows = feed.manifest.pages[index]!;
      async function getPage() {
        attemptPages.push(index);
        if (mode === 'rpc') {
          const logs: RawLog[] = [];
          for (const { from, to } of windows) {
            const rows = await io.call<RawLog[]>(endpoint, 'eth_getLogs', [filter(from, to)]);
            const verify = performance.now();
            logs.push(...expand(compact(rows, [{ from, to }])));
            verificationMs += performance.now() - verify;
          }
          const verify = performance.now();
          const rows = compact(logs, windows);
          verificationMs += performance.now() - verify;
          return rows;
        }
        const reads = await Promise.allSettled(urls.map((url, i) => io.read<Feed['primary'][number]>(
          `feed-${i + 1}`, new URL(`/${feed.id}/${index}`, url).href, 'page')));
        const verify = performance.now();
        try {
          const results = reads.map(result => {
            if (result.status === 'rejected') throw result.reason;
            const page = result.value;
            if (page.id !== feed.id || page.index !== index) throw new Error('Wrong page');
            return compact(expand(page.rows), windows);
          });
          const [first, second] = results;
          if (!first || (mode === 'dual' && JSON.stringify(first) !== JSON.stringify(second))) {
            throw new Error('Feed disagreement');
          }
          return first;
        } finally {
          verificationMs += performance.now() - verify;
        }
      }
      let rows;
      try {
        rows = await getPage();
      } catch (error) {
        if (mode !== 'dual') throw error;
        retries.push(index);
        rows = await getPage();
      }
      const beganScan = performance.now();
      const discover = (logs: RawLog[]) => getAnnouncementsForUser({
        ...synthetic.recipient, announcements: decodeAnnouncements(logs),
      });
      const canonicalMatches = (await discover(expand(rows))).length;
      if (canonicalMatches && firstCanonicalMatchMs === null) firstCanonicalMatchMs = performance.now() - start;
      const matches = await discover(fixtures.filter((_, i) => fixturePages[i] === index));
      if (matches.length && firstSyntheticMatchMs === null) firstSyntheticMatchMs = performance.now() - start;
      scanMs += performance.now() - beganScan;
      const expected = synthetic.expectedIndices.filter(i => fixturePages[i] === index)
        .map(i => fixtures[i]!.transactionHash);
      if (JSON.stringify(matches.map(match => match.transactionHash)) !== JSON.stringify(expected)) {
        throw new Error('Incorrect synthetic matches');
      }
      state.pages.push({ index, count: rows.length, digest: digest(rows), syntheticMatches: matches.length, canonicalMatches });
      state.next = index + 1;
      state.block = windows.at(-1)!.to;
      await Bun.write(`${checkpointPath}.tmp`, JSON.stringify(state));
      await rename(`${checkpointPath}.tmp`, checkpointPath);
    }
  } catch (error) {
    stop = String(error);
  }
  const elapsedMs = performance.now() - start;
  const committed = await Bun.file(checkpointPath).exists()
    ? JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint
    : { next: 0, block: scope.start - 1, pages: [] };
  return { name, mode, limit, initialNext, initialBlock, ...committed, retries, attemptPages, stop, elapsedMs,
    catchUpMs: committed.next === feed.primary.length && stop === null ? elapsedMs : null,
    scanMs, verificationMs, firstSyntheticMatchMs, firstCanonicalMatchMs, requests: io.requests };
}

const cooldownC = Number(process.env.COOLDOWN_C ?? 70);
const thermalGate = () => waitForCooldown(cooldownC);
async function cpus() {
  const allowed = (await Bun.file('/proc/self/status').text()).match(/^Cpus_allowed_list:\s*(\S+)$/m)?.[1] ?? null;
  const parts: Record<string, string> = { '0xd05': 'Cortex-A55', '0xd0b': 'Cortex-A76' };
  const models = (await Bun.file('/proc/cpuinfo').text()).split('\n\n').flatMap(block => {
    const field = (key: string) => block.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim();
    const cpu = field('processor');
    const model = field('model name') ?? parts[field('CPU part') ?? ''];
    return cpu === undefined || !model ? [] : [[cpu, model] as const];
  });
  return { allowed, models: Object.fromEntries(models) };
}

type Sample = Awaited<ReturnType<typeof scan>> & { thermal: Awaited<ReturnType<typeof thermalGate>> };
const evidence = {
  startedAt: new Date().toISOString(), host: hostname(), kernel: release(), bun: Bun.version, cpus: await cpus(),
  cooldownC, manifest: feed.manifest, feedId: feed.id, buildMs, validation, samples: {} as Record<string, Sample>,
};
async function sample(label: string, ...args: Parameters<typeof scan>) {
  const thermal = await thermalGate();
  const result = { ...await scan(...args), thermal };
  evidence.samples[label] = result;
  await Bun.write(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(label, result.next, result.stop ?? result.elapsedMs.toFixed(1));
  return result;
}
const pair = [primary.url, secondary.url];
for (let round = 1; round <= 3; round++) {
  for (const mode of round % 2 ? ['rpc', 'dual'] as const : ['dual', 'rpc'] as const) {
    const urls = mode === 'dual' ? pair : [];
    const cold = await sample(`${mode}-cold-${round}`, `${mode}-cold-${round}`, mode, urls);
    if (cold.stop) throw new Error(cold.stop);
    const name = `${mode}-warm-${round}`;
    const seed = await sample(`${name}-seed`, name, mode, urls, warmPage);
    if (seed.stop) throw new Error(seed.stop);
    const warm = await sample(name, name, mode, urls);
    if (warm.stop) throw new Error(warm.stop);
  }
}
await sample('omission-single', 'omission-single', 'single', [omit.url]);
await sample('omission-hold', 'recovery', 'dual', [omit.url, secondary.url]);
await sample('omission-resume', 'recovery', 'dual', pair);
await sample('payload-hold', 'payload-hold', 'dual', [altered.url, secondary.url]);
for (const server of [primary, secondary, omit, altered]) server.stop(true);
