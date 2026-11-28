// Checks a remote-feed evidence file and prints its summary (medians of three, as verify.ts).
import { strict as assert } from 'node:assert';
import { scope } from '../shared/base-windows.ts';
import { digest, loadReference, warmPage } from './feed.ts';

type Request = { source: string; operation: string; status: number; responseBytes: number; wireBytes: number | null;
  encoding: string | null; cache: string | null; servedBy?: string | null; fetchMs: number };
type Sample = {
  initialNext: number; initialBlock: number; next: number; block: number; stop: string | null; elapsedMs: number;
  catchUpMs: number | null; scanMs: number; verificationMs: number; firstSyntheticMatchMs: number | null;
  retries: number[]; attemptPages: number[]; requests: Request[];
  pages: { index: number; count: number; digest: string; canonicalMatches: number; syntheticMatches: number }[];
  thermal: { maxC: number | null; waitMs: number };
};
const path = Bun.argv[2];
if (!path) throw new Error('Usage: bun run shared-feed:remote-verify EVIDENCE_JSON');
const evidence = await Bun.file(path).json() as {
  host: string; bun: string; cpusAllowed: string | null; cooldownC: number; feedId: string; urls: string[];
  rounds?: number; sharedHost?: string | null; samples: Record<string, Sample>;
};
const feed = await loadReference();
assert.match(evidence.host, /^(bazzite|turing-node-[123])$/);
if (evidence.host !== 'bazzite') assert.equal(evidence.cpusAllowed, '4-7');
assert.equal(evidence.bun, '1.4.4');
assert.equal(evidence.feedId, feed.id);
assert.equal(evidence.urls.length, 2);
assert.notEqual(new URL(evidence.urls[0]!).host, new URL(evidence.urls[1]!).host);

const end = feed.primary.length;
const medianOf = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
function check(label: string, initial: number, next: number) {
  const sample = evidence.samples[label];
  assert.ok(sample, label);
  assert.equal(sample.stop, null, label);
  assert.deepEqual(sample.retries, [], label);
  assert.equal(sample.initialNext, initial, label);
  assert.equal(sample.next, next, label);
  assert.equal(sample.initialBlock, feed.manifest.pages[initial - 1]?.at(-1)?.to ?? scope.start - 1, label);
  assert.equal(sample.block, feed.manifest.pages[next - 1]?.at(-1)?.to ?? scope.start - 1, label);
  assert.deepEqual(sample.attemptPages, range(initial, next), label);
  assert.ok(sample.thermal.maxC === null || sample.thermal.maxC <= evidence.cooldownC, label);
  for (const [index, page] of sample.pages.entries()) {
    const rows = feed.primary[index]!.rows;
    assert.deepEqual(page, { index, count: rows.length, digest: digest(rows),
      syntheticMatches: index === 2 || index === warmPage + 1 ? 1 : 0, canonicalMatches: 0 }, label);
  }
  assert.deepEqual(sample.requests.map(row => row.operation),
    ['manifest', 'manifest', ...Array<string>((next - initial) * 2).fill('page')], label);
  for (const row of sample.requests) {
    assert.equal(row.status, 200, label);
    assert.ok(Number.isSafeInteger(row.responseBytes) && row.responseBytes > 0, label);
    assert.ok(Number.isFinite(row.fetchMs) && row.fetchMs >= 0, label);
  }
  for (const duration of [sample.scanMs, sample.verificationMs]) assert.ok(duration >= 0 && duration <= sample.elapsedMs, label);
  const sum = (rows: Request[], key: 'responseBytes' | 'fetchMs') => rows.reduce((total, row) => total + row[key], 0);
  const compressed = sample.requests.filter(row => row.encoding !== null);
  return {
    expected: feed.primary.slice(initial, next).reduce((total, page) => total + page.rows.length, 0),
    observed: sample.pages.slice(initial).reduce((total, page) => total + page.count, 0),
    posts: 0, gets: sample.requests.length, requestBytes: 0, responseBytes: sum(sample.requests, 'responseBytes'),
    // Content-Length of compressed responses; null when any response lacked it.
    wireBytes: sample.requests.every(row => row.wireBytes !== null) ? sample.requests.reduce((total, row) => total + row.wireBytes!, 0) : null,
    compressed: compressed.length, cacheHits: sample.requests.filter(row => /HIT/i.test(row.cache ?? '')).length,
    // Median page time per feed: separates a slow CDN edge (every request slow) from single misses.
    feed1PageMs: medianOf(sample.requests.filter(row => row.source === 'feed-1' && row.operation === 'page').map(row => row.fetchMs)),
    feed2PageMs: medianOf(sample.requests.filter(row => row.source === 'feed-2' && row.operation === 'page').map(row => row.fetchMs)),
    fetchMs: sum(sample.requests, 'fetchMs'), scanMs: sample.scanMs, verificationMs: sample.verificationMs,
    elapsedMs: sample.elapsedMs, firstSyntheticMatchMs: sample.firstSyntheticMatchMs,
  };
}
const summaries: Record<string, ReturnType<typeof check>[]> = {};
const rounds = evidence.rounds ?? 3;
const tags = evidence.rounds === undefined ? ['remote'] : ['remote', 'remote-concurrent'];
for (const tag of tags) {
  for (let round = 1; round <= rounds; round++) {
    (summaries[`${tag}-cold`] ??= []).push(check(`${tag}-cold-${round}`, 0, end));
    check(`${tag}-warm-${round}-seed`, 0, warmPage);
    (summaries[`${tag}-warm`] ??= []).push(check(`${tag}-warm-${round}`, warmPage, end));
  }
}
assert.equal(Object.keys(evidence.samples).length, tags.length * rounds * 3);
// [median, min, max] per field, as verify.ts (an odd sample count, so the median is a sample).
const stats = (values: (number | null)[]) => {
  const sorted = [...values].sort((a, b) => (a ?? 0) - (b ?? 0));
  return [sorted[(sorted.length - 1) / 2], sorted[0], sorted.at(-1)];
};
console.log(JSON.stringify({
  host: evidence.host, bun: evidence.bun, urls: evidence.urls, rounds, sharedHost: evidence.sharedHost ?? null,
  thermal: { cooldownC: evidence.cooldownC, maxC: Math.max(...Object.values(evidence.samples).map(s => s.thermal.maxC ?? -Infinity)) },
  summaries: Object.fromEntries(Object.entries(summaries).map(([key, rows]) => [key, Object.fromEntries(
    Object.keys(rows[0]!).map(field => [field, stats(rows.map(row => row[field as keyof typeof row] as number | null))]))])),
}, null, 2));
