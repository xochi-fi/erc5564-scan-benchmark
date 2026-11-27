import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { getAnnouncementsForUser } from '@scopelift/stealth-address-sdk';
import { z } from 'zod';
import { generateFixture } from '../shared/fixtures.ts';
import { decodeAnnouncements, type RawLog } from '../paged-discovery/wallet.ts';
import { identity, rpc, scope, type Window } from '../rpc-recovery/config.ts';
import { compact, digest, expand, referencePath } from './feed.ts';

const paramsSchema = z.strictObject({
  pageWindows: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]),
  layout: z.enum(['rows', 'columns']),
  pageHeader: z.boolean(),
  shortKeys: z.boolean(),
  hashEncoding: z.enum(['hex', 'base64']),
  hexPrefix: z.boolean(),
  blockDelta: z.boolean(),
  blockHashTable: z.boolean(),
  topicTrim: z.boolean(),
  dataEncoding: z.enum(['hex', 'base64', 'zrle']),
  prefetch: z.number().int().min(0).max(16),
});
type Params = z.infer<typeof paramsSchema>;
type Row = ReturnType<typeof compact>[number];

const [paramsPath, samplesArg] = Bun.argv.slice(2);
if (!paramsPath || !/^(bazzite|turing-node-[123])$/.test(hostname())) {
  throw new Error('Usage on Bazzite or a Turing node: bun src/shared-feed/tune.ts PARAMS_JSON [WARM_SAMPLES]');
}
const params = paramsSchema.parse(await Bun.file(paramsPath).json());
const warmSamples = Number(samplesArg ?? 1);
if (!Number.isSafeInteger(warmSamples) || warmSamples < 1) throw new Error('Invalid sample count');

const warmWindows = 32;
const fixtureWindows = [8, 8, 36, 36];
const bytesOf = (value: string) => Buffer.from(value.replace(/^0x/, ''), 'hex');
const padded = (bytes: Buffer, size: number) => Buffer.concat([Buffer.alloc(size - bytes.length), bytes]);
const trimmed = (bytes: Buffer) => {
  const first = bytes.findIndex(byte => byte !== 0);
  return bytes.subarray(first < 0 ? bytes.length : first);
};
const key = params.shortKeys ? { index: 'i', rows: 'r', hashes: 'h' } as const : { index: 'index', rows: 'rows', hashes: 'hashes' } as const;
const hexOut = (bytes: Buffer) => (params.hexPrefix ? '0x' : '') + bytes.toString('hex');
const hexIn = (value: string) => Buffer.from(value.replace(/^0x/, ''), 'hex');

function encodeBytes(bytes: Buffer, encoding: 'hex' | 'base64') {
  return encoding === 'hex' ? hexOut(bytes) : bytes.toString('base64');
}
function decodeBytes(value: string, encoding: 'hex' | 'base64') {
  return encoding === 'hex' ? hexIn(value) : Buffer.from(value, 'base64');
}
function encodeData(data: string) {
  const bytes = bytesOf(data);
  if (params.dataEncoding !== 'zrle') return encodeBytes(bytes, params.dataEncoding);
  return (params.hexPrefix ? '0x' : '') + bytes.toString('hex').replace(/(?:00){3,}/g, run => `g${(run.length / 2).toString(36)}.`);
}
function decodeData(value: string) {
  if (params.dataEncoding !== 'zrle') return '0x' + decodeBytes(value, params.dataEncoding).toString('hex');
  return '0x' + value.replace(/^0x/, '').replace(/g([\da-z]+)\./g, (_, run: string) => '00'.repeat(parseInt(run, 36)));
}
const encodeHash = (value: string) => encodeBytes(bytesOf(value), params.hashEncoding);
const decodeHash = (value: string) => '0x' + padded(decodeBytes(value, params.hashEncoding), 32).toString('hex');
const encodeTopic = (value: string) => encodeBytes(params.topicTrim ? trimmed(bytesOf(value)) : bytesOf(value), params.hashEncoding);

type Encoded = (string | number | (string | number)[])[];
function encodeRows(rows: Row[], from: number) {
  const blocks: [number, string][] = [];
  let previous = from;
  const fields = rows.map(([block, blockHash, txHash, index, txIndex, topics, data]): Encoded => {
    let hashField: string | number = encodeHash(blockHash);
    if (params.blockHashTable) {
      let position = blocks.findIndex(([number]) => number === block);
      if (position < 0) position = blocks.push([block, blockHash]) - 1;
      hashField = position;
    }
    const blockField = params.blockDelta ? block - previous : block;
    previous = block;
    return [blockField, hashField, encodeHash(txHash), index, txIndex, topics.map(encodeTopic), encodeData(data)];
  });
  const table = params.blockHashTable ? blocks.map(([, hash]) => encodeHash(hash)) : undefined;
  const body = params.layout === 'rows' ? fields : fields[0]?.map((_, column) => fields.map(row => row[column]!)) ?? [];
  return table === undefined ? { [key.rows]: body } : { [key.rows]: body, [key.hashes]: table };
}
type Page = Record<string, unknown>;
function decodeRows(page: Page, from: number): Row[] {
  const body = page[key.rows] as Encoded[];
  if (!Array.isArray(body)) throw new Error('Invalid rows');
  const fields = params.layout === 'rows' ? body
    : (body[0] as unknown[] | undefined)?.map((_, row) => body.map(column => (column as unknown[])[row])) as Encoded[] ?? [];
  const table = page[key.hashes] as string[] | undefined;
  let previous = from;
  return fields.map(([blockField, hashField, txHash, index, txIndex, topics, data]): Row => {
    const block = params.blockDelta ? previous + (blockField as number) : blockField as number;
    previous = block;
    const blockHash = params.blockHashTable ? table?.[hashField as number] : hashField as string;
    if (typeof blockHash !== 'string') throw new Error('Invalid block hash');
    return [block, decodeHash(blockHash), decodeHash(txHash as string), index as number, txIndex as number,
      (topics as string[]).map(decodeHash), decodeData(data as string)];
  });
}

type Reference = { windows: Window[]; identities: string[]; headHash: string; captures: { url: string; logs: RawLog[] }[] };
const reference = await Bun.file(referencePath).json() as Reference;
const { windows, identities, headHash } = reference;
const [a, b] = reference.captures;
if (windows.length !== 68 || identities.length !== 48 || a?.url !== rpc.tenderly || b?.url !== rpc.sentio) {
  throw new Error('Unexpected RPC-recovery reference');
}
const pages = Array.from({ length: Math.ceil(windows.length / params.pageWindows) }, (_, index) =>
  windows.slice(index * params.pageWindows, (index + 1) * params.pageWindows));
const manifest = { version: 2, chainId: scope.chainId, head: scope.head, headHash, pages, format: params };
const id = digest(manifest);
const warmPage = warmWindows / params.pageWindows;
const fixturePages = fixtureWindows.map(window => Math.floor(window / params.pageWindows));
const pageFrom = (index: number) => pages[index]![0]!.from;

function build(logs: RawLog[]) {
  const checked = compact(logs, windows);
  const split = pages.map(group => checked.filter(([block]) => group.some(({ from, to }) => from <= block && block <= to)));
  const bodies = split.map((rows, index) => JSON.stringify({
    ...(params.pageHeader ? { id, [key.index]: index } : {}), ...encodeRows(rows, pageFrom(index)),
  }));
  bodies.forEach((body, index) => {
    if (digest(decodeRows(JSON.parse(body), pageFrom(index))) !== digest(split[index])) throw new Error('Lossy encoding');
  });
  return { split, bodies };
}
const primary = build(a.logs);
const secondary = build(b.logs);
if (digest(primary.split) !== digest(secondary.split)) throw new Error('Capture payloads disagree');

function serve(bodies: string[]) {
  const body = JSON.stringify(manifest);
  const pagePath = new RegExp(`^/${id}/(0|[1-9][0-9]*)$`);
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.search) return new Response(null, { status: 404 });
      const index = pagePath.exec(url.pathname)?.[1];
      const found = url.pathname === '/manifest' ? body : index === undefined ? undefined : bodies[Number(index)];
      return found === undefined ? new Response(null, { status: 404 }) : new Response(found, {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable' },
      });
    },
  });
}
const servers = [serve(primary.bodies), serve(secondary.bodies)];
const urls = servers.map(server => server.url);

const work = await mkdtemp(`${tmpdir()}/shared-feed-tune-`);
const synthetic = await generateFixture(`${work}/synthetic`, { seed: 'phase6:base:v1', count: 4, matchEvery: 2 });
const fixtures = (await Bun.file(`${work}/synthetic/announcements.jsonl`).text()).trim().split('\n')
  .map(line => JSON.parse(line) as RawLog);
const discover = (logs: RawLog[]) => getAnnouncementsForUser({ ...synthetic.recipient, announcements: decodeAnnouncements(logs) });

type Checkpoint = { id: string; next: number; block: number; pages: { index: number; count: number; digest: string }[] };
async function scan(name: string, limit = pages.length) {
  const checkpointPath = `${work}/${name}.checkpoint.json`;
  const file = Bun.file(checkpointPath);
  const state: Checkpoint = await file.exists() ? await file.json() : { id, next: 0, block: scope.start - 1, pages: [] };
  const initialNext = state.next;
  const bytes = [0, 0];
  const logs: string[] = [];
  const start = performance.now();
  async function read(source: number, path: string) {
    const response = await fetch(new URL(path, urls[source]), { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error(`feed-${source + 1} HTTP ${response.status}`);
    return { size: body.byteLength, json: JSON.parse(new TextDecoder().decode(body)) as Page };
  }
  const manifests = await Promise.all([0, 1].map(source => read(source, '/manifest')));
  if (manifests.some(({ json }) => digest(json) !== id)) throw new Error('Wrong feed manifest');
  const pending = new Map<number, Promise<Awaited<ReturnType<typeof read>>[]>>();
  const request = (index: number) => {
    if (index < limit && !pending.has(index)) {
      const reads = Promise.all([0, 1].map(source => read(source, `/${id}/${index}`)));
      reads.catch(() => undefined);
      pending.set(index, reads);
    }
  };
  for (let index = state.next; index < limit; index++) {
    for (let ahead = 0; ahead <= params.prefetch; ahead++) request(index + ahead);
    const reads = await pending.get(index)!;
    pending.delete(index);
    const [first, second] = reads.map(({ size, json }, source) => {
      bytes[source]! += size;
      if (params.pageHeader && (json.id !== id || json[key.index] !== index)) throw new Error('Wrong page');
      return compact(expand(decodeRows(json, pageFrom(index))), pages[index]!);
    });
    if (!first || JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Feed disagreement');
    await discover(expand(first));
    const matches = await discover(fixtures.filter((_, i) => fixturePages[i] === index));
    const expected = synthetic.expectedIndices.filter(i => fixturePages[i] === index).map(i => fixtures[i]!.transactionHash);
    if (JSON.stringify(matches.map(match => match.transactionHash)) !== JSON.stringify(expected)) {
      throw new Error('Incorrect synthetic matches');
    }
    logs.push(...expand(first).map(identity));
    state.pages.push({ index, count: first.length, digest: digest(first) });
    state.next = index + 1;
    state.block = pages[index]!.at(-1)!.to;
    await Bun.write(`${checkpointPath}.tmp`, JSON.stringify(state));
    await rename(`${checkpointPath}.tmp`, checkpointPath);
  }
  return { ms: performance.now() - start, initialNext, bytes, logs };
}

const cooldownC = 70;
async function maxThermalC() {
  const zones = (await readdir('/sys/class/thermal').catch(() => [])).filter(zone => zone.startsWith('thermal_zone'));
  const temps = await Promise.all(zones.map(zone => Bun.file(`/sys/class/thermal/${zone}/temp`).text().then(Number, () => NaN)));
  const valid = temps.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) / 1000 : null;
}
let peakC: number | null = null;
async function thermalGate() {
  let maxC = await maxThermalC();
  while (maxC !== null && maxC > cooldownC) {
    await Bun.sleep(5_000);
    maxC = await maxThermalC();
  }
  if (maxC !== null) peakC = Math.max(peakC ?? maxC, maxC);
}

const expectedCold = [...identities].sort();
const warmFrom = windows[warmWindows - 1]!.to;
const expectedWarm = expectedCold.filter(log => Number(log.split(':')[0]) > warmFrom);
const same = (logs: string[], expected: string[]) => digest([...logs].sort()) === digest(expected);
const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  return (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2;
};

try {
  await thermalGate();
  const cold = await scan('cold');
  if (!same(cold.logs, expectedCold) || cold.bytes[0] !== cold.bytes[1]) throw new Error(`Cold logs ${cold.logs.length}/48`);
  const warmMs: number[] = [];
  let warmLogs = 0;
  let warmBytes = 0;
  for (let sample = 1; sample <= warmSamples; sample++) {
    await scan(`warm-${sample}`, warmPage);
    await thermalGate();
    const warm = await scan(`warm-${sample}`);
    if (warm.initialNext !== warmPage || !same(warm.logs, expectedWarm)) throw new Error(`Warm logs ${warm.logs.length}/28`);
    warmMs.push(warm.ms);
    warmLogs = warm.logs.length;
    warmBytes = warm.bytes[0]!;
  }
  const gzipBytes = primary.bodies.reduce((sum, body) => sum + Bun.gzipSync(body).byteLength, 0);
  const metrics = {
    cold_bytes: cold.bytes[0], cold_gzip_bytes: gzipBytes, manifest_bytes: JSON.stringify(manifest).length, warm_bytes: warmBytes,
    warm_ms: median(warmMs).toFixed(2), warm_min_ms: Math.min(...warmMs).toFixed(2), warm_max_ms: Math.max(...warmMs).toFixed(2),
    cold_ms: cold.ms.toFixed(2), pages: pages.length, logs_cold: cold.logs.length, logs_warm: warmLogs, peak_c: peakC ?? 'na',
  };
  for (const [key, value] of Object.entries(metrics)) console.log(`METRIC ${key}=${value}`);
} finally {
  for (const server of servers) server.stop(true);
  await rm(work, { recursive: true, force: true });
}
