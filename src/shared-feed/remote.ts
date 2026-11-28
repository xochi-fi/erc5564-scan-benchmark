// run.ts's dual-feed scan against the static feeds over the network, one process per sample.
import { mkdir, readFile, rename } from 'node:fs/promises';
import { hostname, release } from 'node:os';
import { getAnnouncementsForUser } from '@scopelift/stealth-address-sdk';
import { generateFixture } from '../shared/fixtures.ts';
import { decodeAnnouncements, type RawLog } from '../shared/raw-logs.ts';
import { scope } from '../shared/base-windows.ts';
import { waitForCooldown } from '../shared/host.ts';
import { compact, digest, expand, loadReference, warmPage, type Feed } from './feed.ts';
import { writeSamples, type Request } from './remote-format.ts';

type PageSummary = { index: number; count: number; digest: string; syntheticMatches: number; canonicalMatches: number };
type Checkpoint = { id: string; next: number; block: number; pages: PageSummary[] };

const [command, ...args] = Bun.argv.slice(2);

async function child(output: string, name: string, limit: number, fetchMode: string, urls: string[]) {
  const feed = await loadReference();
  const fixtureDir = `${output}/synthetic/${name}-${limit}`;
  // kept: recorded evidence depends on it
  const synthetic = await generateFixture(fixtureDir, { seed: 'phase6:base:v1', count: 4, matchEvery: 2 });
  const fixtures = (await Bun.file(`${fixtureDir}/announcements.jsonl`).text()).trim().split('\n')
    .map(line => JSON.parse(line) as RawLog);
  const fixturePages = [2, 2, warmPage + 1, warmPage + 1];
  const requests: Request[] = [];
  async function read<T>(source: number, path: string, operation: string): Promise<T> {
    const start = performance.now();
    const response = await fetch(new URL(path, urls[source]), {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const bytes = await response.arrayBuffer();
    const length = response.headers.get('content-length');
    requests.push({
      source: `feed-${source + 1}`, operation, status: response.status, responseBytes: bytes.byteLength,
      wireBytes: length === null ? null : Number(length),
      cache: response.headers.get('x-cache') ?? response.headers.get('cf-cache-status'),
      servedBy: response.headers.get('x-served-by') ?? response.headers.get('cf-ray'),
      fetchMs: performance.now() - start,
    });
    if (!response.ok) throw new Error(`feed-${source + 1} ${operation} HTTP ${response.status}`);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  const checkpointPath = `${output}/${name}.checkpoint.json`;
  const file = Bun.file(checkpointPath);
  const state: Checkpoint = await file.exists() ? await file.json() : { id: feed.id, next: 0, block: scope.start - 1, pages: [] };
  const initialNext = state.next;
  const initialBlock = state.block;
  let verificationMs = 0;
  let scanMs = 0;
  let firstSyntheticMatchMs: number | null = null;
  let stop: string | null = null;
  const attemptPages: number[] = [];
  const retries: number[] = [];
  const start = performance.now();
  try {
    await Promise.all([0, 1].map(async source => {
      if (digest(await read<unknown>(source, 'manifest.json', 'manifest')) !== feed.id) throw new Error('Wrong feed manifest');
    }));
    const fetchPair = (index: number) => Promise.all([0, 1].map(source => read<Feed['primary'][number]>(source, `${feed.id}/${index}.json`, 'page')));
    // Concurrent mode requests every remaining page of both feeds at once, then verifies and scans in order.
    const ahead = new Map<number, ReturnType<typeof fetchPair>>();
    if (fetchMode === 'concurrent') {
      for (let index = state.next; index < limit; index++) {
        const pair = fetchPair(index);
        pair.catch(() => undefined);
        ahead.set(index, pair);
      }
    }
    for (let index = state.next; index < limit; index++) {
      const windows = feed.manifest.pages[index]!;
      const getPage = async () => {
        attemptPages.push(index);
        const pages = await (ahead.get(index) ?? fetchPair(index));
        ahead.delete(index);
        const verify = performance.now();
        try {
          const [first, second] = pages.map(page => {
            if (page.id !== feed.id || page.index !== index) throw new Error('Wrong page');
            return compact(expand(page.rows), windows);
          });
          if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Feed disagreement');
          return first!;
        } finally {
          verificationMs += performance.now() - verify;
        }
      };
      let rows;
      try {
        rows = await getPage();
      } catch {
        retries.push(index);
        rows = await getPage();
      }
      const beganScan = performance.now();
      const discover = (logs: RawLog[]) => getAnnouncementsForUser({ ...synthetic.recipient, announcements: decodeAnnouncements(logs) });
      const canonicalMatches = (await discover(expand(rows))).length;
      const matches = await discover(fixtures.filter((_, i) => fixturePages[i] === index));
      if (matches.length && firstSyntheticMatchMs === null) firstSyntheticMatchMs = performance.now() - start;
      scanMs += performance.now() - beganScan;
      const expected = synthetic.expectedIndices.filter(i => fixturePages[i] === index).map(i => fixtures[i]!.transactionHash);
      if (JSON.stringify(matches.map(match => match.transactionHash)) !== JSON.stringify(expected)) throw new Error('Incorrect synthetic matches');
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
    ? JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint : { next: 0, block: scope.start - 1, pages: [] };
  return { name, limit, initialNext, initialBlock, ...committed, retries, attemptPages, stop, elapsedMs,
    catchUpMs: committed.next === feed.primary.length && stop === null ? elapsedMs : null,
    scanMs, verificationMs, firstSyntheticMatchMs, requests };
}

if (command === 'child') {
  const [output, name, limit, fetchMode, ...urls] = args;
  console.log(JSON.stringify(await child(output!, name!, Number(limit), fetchMode!, urls)));
} else {
  const [output, ...urls] = [command, ...args];
  if (!output || urls.length !== 2 || !/^(bazzite|turing-node-[123])$/.test(hostname()) || !urls.every(url => url.startsWith('https://') && url.endsWith('/'))) {
    throw new Error('Usage on Bazzite or a Turing node: bun run shared-feed:remote NEW_OUTPUT_DIR HTTPS_FEED_1/ HTTPS_FEED_2/');
  }
  await mkdir(output, { recursive: false });
  const feed = await loadReference();
  const cooldownC = Number(process.env.COOLDOWN_C ?? 70);
  const allowed = (await Bun.file('/proc/self/status').text()).match(/^Cpus_allowed_list:\s*(\S+)$/m)?.[1] ?? null;
  const evidence = { startedAt: new Date().toISOString(), host: hostname(), kernel: release(), bun: Bun.version,
    cpusAllowed: allowed, cooldownC, feedId: feed.id, urls, rounds: Number(process.env.ROUNDS ?? 9),
    sharedHost: process.env.SHARED_HOST ?? null, samples: {} as Record<string, unknown> };
  async function sample(label: string, name: string, limit: number, fetchMode: string) {
    const thermal = await waitForCooldown(cooldownC);
    const proc = Bun.spawn([process.execPath, import.meta.path, 'child', output!, name, String(limit), fetchMode, ...urls], { stdout: 'pipe', stderr: 'inherit' });
    const text = await new Response(proc.stdout).text();
    if (await proc.exited !== 0) throw new Error(`${label} failed`);
    const result = { ...JSON.parse(text), thermal };
    evidence.samples[label] = result;
    const { samples, ...header } = evidence;
    await Bun.write(`${output}/samples.jsonl`, writeSamples(header, samples as never));
    console.log(label, result.next, result.stop ?? result.elapsedMs.toFixed(1));
    if (result.stop) throw new Error(result.stop);
  }
  const end = feed.primary.length;
  const rounds = Number(process.env.ROUNDS ?? 9);
  // Interleave sequential and concurrent fetching so CDN and edge state affect both alike.
  for (let round = 1; round <= rounds; round++) {
    for (const mode of round % 2 ? ['sequential', 'concurrent'] : ['concurrent', 'sequential']) {
      const tag = mode === 'sequential' ? 'remote' : 'remote-concurrent';
      await sample(`${tag}-cold-${round}`, `${tag}-cold-${round}`, end, mode);
      await sample(`${tag}-warm-${round}-seed`, `${tag}-warm-${round}`, warmPage, mode);
      await sample(`${tag}-warm-${round}`, `${tag}-warm-${round}`, end, mode);
    }
  }
}
