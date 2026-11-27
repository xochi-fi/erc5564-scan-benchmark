import { strict as assert } from 'node:assert';
import { scope } from '../shared/base-windows.ts';
import { digest, loadReference, warmPage } from './feed.ts';

type Sample = {
  initialNext: number; initialBlock: number; next: number; block: number; stop: string | null;
  elapsedMs: number; catchUpMs: number | null; scanMs: number; verificationMs: number;
  firstSyntheticMatchMs: number | null; firstCanonicalMatchMs: number | null;
  retries: number[]; attemptPages: number[];
  pages: { index: number; count: number; digest: string; canonicalMatches: number; syntheticMatches: number }[];
  requests: { source: string; operation: string; requestBytes: number; responseBytes: number; fetchMs: number }[];
  thermal?: { maxC: number | null; waitMs: number };
};
const path = Bun.argv[2];
if (!path) throw new Error('Usage: bun run shared-feed:verify EVIDENCE_JSON');
const { host, bun, cpus, cooldownC, manifest, feedId, samples, validation, buildMs } = await Bun.file(path).json() as {
  host: string; bun: string; cpus?: { allowed: string | null; models: Record<string, string> }; cooldownC?: number;
  manifest: unknown; feedId: string; samples: Record<string, Sample>;
  validation: { source: string; finalized: number; requests: Sample['requests'] }[]; buildMs: number;
};
const feed = await loadReference();
assert.match(host, /^(bazzite|turing-node-[123])$/);
if (host !== 'bazzite') {
  assert.equal(cpus?.allowed, '4-7');
  assert.deepEqual(['4', '5', '6', '7'].map(cpu => cpus.models[cpu]), Array(4).fill('Cortex-A76'));
  assert.equal(cooldownC, 70);
}
if (cooldownC !== undefined) {
  for (const sample of Object.values(samples)) {
    assert.ok(sample.thermal?.maxC != null && sample.thermal.maxC <= cooldownC && sample.thermal.waitMs >= 0);
  }
}
assert.equal(bun, '1.4.4');
assert.equal(digest(manifest), feedId);
assert.equal(feedId, feed.id);
assert.deepEqual(validation.map(row => row.source), ['base.gateway.tenderly.co', 'base.rpc.sentio.xyz']);
for (const row of validation) {
  assert.ok(Number.isSafeInteger(row.finalized) && row.finalized >= scope.head);
  assert.deepEqual(row.requests.map(request => request.operation),
    ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber']);
}
assert.ok(Number.isFinite(buildMs) && buildMs >= 0);

const end = feed.primary.length;
const firstPositive = feed.primary.findIndex(page => page.rows.length > 0);
const sampleNames = new Set<string>();
function check(label: string, initial: number, next: number, attempts: number[], requests: number, fault?: 'hold' | 'omit') {
  sampleNames.add(label);
  const sample = samples[label];
  assert.ok(sample, label);
  assert.equal(sample.initialNext, initial, label);
  assert.equal(sample.next, next, label);
  assert.equal(sample.initialBlock, feed.manifest.pages[initial - 1]?.at(-1)?.to ?? scope.start - 1, label);
  assert.equal(sample.block, feed.manifest.pages[next - 1]?.at(-1)?.to ?? scope.start - 1, label);
  assert.deepEqual(sample.attemptPages, attempts, label);
  assert.deepEqual(sample.retries, fault === 'hold' ? [firstPositive] : [], label);
  assert.equal(sample.stop, fault === 'hold' ? 'Error: Feed disagreement' : null, label);
  assert.equal(sample.catchUpMs, next === end ? sample.elapsedMs : null, label);
  for (const duration of [sample.elapsedMs, sample.scanMs, sample.verificationMs]) {
    assert.ok(Number.isFinite(duration) && duration >= 0 && duration <= sample.elapsedMs, label);
  }
  assert.equal(sample.pages.length, next, label);
  assert.equal(sample.requests.length, requests, label);
  assert.equal(sample.firstCanonicalMatchMs, null, label);
  if ([2, warmPage + 1].some(index => index >= initial && index < next)) {
    assert.ok(sample.firstSyntheticMatchMs !== null && sample.firstSyntheticMatchMs >= 0 &&
      sample.firstSyntheticMatchMs <= sample.elapsedMs, label);
  } else assert.equal(sample.firstSyntheticMatchMs, null, label);
  for (const [index, page] of sample.pages.entries()) {
    const rows = fault === 'omit' ? [] : feed.primary[index]!.rows;
    assert.deepEqual(page, { index, count: rows.length, digest: digest(rows),
      syntheticMatches: index === 2 || index === warmPage + 1 ? 1 : 0, canonicalMatches: 0 }, label);
  }
  for (const request of sample.requests) {
    assert.ok(Number.isSafeInteger(request.requestBytes) && request.requestBytes >= 0, label);
    assert.ok(Number.isSafeInteger(request.responseBytes) && request.responseBytes > 0, label);
    assert.ok(Number.isFinite(request.fetchMs) && request.fetchMs >= 0, label);
  }
  const rpc = label.startsWith('rpc-');
  const sources = fault === 'omit' ? 1 : 2;
  assert.deepEqual(sample.requests.map(row => row.operation), rpc
    ? ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber', ...attempts.flatMap(index =>
      feed.manifest.pages[index]!.map(() => 'eth_getLogs'))]
    : [...Array<string>(sources).fill('manifest'), ...Array<string>(attempts.length * sources).fill('page')], label);
  assert.ok(sample.requests.every(row => rpc === (row.requestBytes > 0)), label);
  const expected = feed.primary.slice(initial, next).reduce((sum, page) => sum + page.rows.length, 0);
  const observed = sample.pages.slice(initial).reduce((sum, page) => sum + page.count, 0);
  const sum = (key: 'requestBytes' | 'responseBytes' | 'fetchMs') =>
    sample.requests.reduce((total, request) => total + request[key], 0);
  return { expected, observed, posts: rpc ? requests : 0, gets: rpc ? 0 : requests,
    requestBytes: sum('requestBytes'), responseBytes: sum('responseBytes'), fetchMs: sum('fetchMs'),
    primaryPageBytes: sample.requests.filter(row => row.operation === 'eth_getLogs' ||
      (row.operation === 'page' && row.source === 'feed-1')).reduce((total, row) => total + row.responseBytes, 0),
    scanMs: sample.scanMs, verificationMs: sample.verificationMs, elapsedMs: sample.elapsedMs,
    firstSyntheticMatchMs: sample.firstSyntheticMatchMs };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const summaries: Record<string, ReturnType<typeof check>[]> = {};
for (const mode of ['rpc', 'dual']) {
  const requests = (pages: number) => mode === 'rpc' ? 3 + pages * 4 : 2 + pages * 2;
  for (const round of [1, 2, 3]) {
    const cold = check(`${mode}-cold-${round}`, 0, end, range(0, end), requests(end));
    check(`${mode}-warm-${round}-seed`, 0, warmPage, range(0, warmPage), requests(warmPage));
    const warm = check(`${mode}-warm-${round}`, warmPage, end, range(warmPage, end), requests(end - warmPage));
    (summaries[`${mode}-cold`] ??= []).push(cold);
    (summaries[`${mode}-warm`] ??= []).push(warm);
  }
}
const omit = check('omission-single', 0, end, range(0, end), 1 + end, 'omit');
assert.equal(omit.expected - omit.observed, 48);
const held = [...range(0, firstPositive + 1), firstPositive];
const hold = check('omission-hold', 0, firstPositive, held, 2 + held.length * 2, 'hold');
const resume = check('omission-resume', firstPositive, end, range(firstPositive, end), 2 + (end - firstPositive) * 2);
assert.equal(resume.observed, 48);
const altered = check('payload-hold', 0, firstPositive, held, 2 + held.length * 2, 'hold');
assert.deepEqual(Object.keys(samples).sort(), [...sampleNames].sort());

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return [sorted[1], sorted[0], sorted[2]];
}
const thermal = cooldownC === undefined ? null : {
  cooldownC, maxC: Math.max(...Object.values(samples).map(sample => sample.thermal!.maxC!)),
  waitMs: Object.values(samples).reduce((sum, sample) => sum + sample.thermal!.waitMs, 0),
};
console.log(JSON.stringify({ host, bun, cpus: cpus ?? null, thermal, buildMs, summaries: Object.fromEntries(Object.entries(summaries).map(([key, rows]) => [
  key, Object.fromEntries(Object.keys(rows[0]!).map(field => [
    field, stats(rows.map(row => row[field as keyof typeof row]!)),
  ])),
])), controls: { omit, hold, resume, altered } }, null, 2));
