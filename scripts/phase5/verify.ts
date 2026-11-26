import { deepStrictEqual, ok } from 'node:assert/strict';
import type { RawLog } from './browser.ts';
import { hex, identity, scope, type Window } from './config.ts';

const [referencePath, output] = Bun.argv.slice(2);
if (!referencePath || !output) throw new Error('Usage: bun scripts/phase5/verify.ts REFERENCE_JSON OUTPUT_DIR');
interface Captured {
  request: { method: string; params: unknown[] };
  body: string;
}
const { identities, windows, agreed, headHash, captures } = await Bun.file(referencePath).json() as {
  identities: string[]; windows: Window[]; agreed: boolean; headHash: string;
  captures: { url: string; error: string | null; requests: Captured[] }[];
};
ok(agreed && identities.length === 48);
deepStrictEqual(new Set(captures.map(source => new URL(source.url).hostname)).size, 2);
for (const capture of captures) {
  deepStrictEqual(capture.error, null);
  const results = <T>(method: string) => capture.requests.filter(entry => entry.request.method === method)
    .map(entry => JSON.parse(entry.body).result as T);
  deepStrictEqual(results('eth_chainId'), [scope.chainId]);
  const heads = results<{ number: string; hash: string }>('eth_getBlockByNumber');
  deepStrictEqual(heads.map(head => [head.number, head.hash]), [[hex(scope.head), headHash]]);
  const logs = results<RawLog[]>('eth_getLogs').flat();
  deepStrictEqual(logs.map(identity).sort(), identities);
  const receipts = results<{ logs: RawLog[] }>('eth_getTransactionReceipt').flatMap(receipt => receipt.logs);
  for (const log of logs) {
    ok(receipts.some(row => identity(log) === identity(row) && row.data.toLowerCase() === log.data.toLowerCase() &&
      row.address.toLowerCase() === log.address.toLowerCase() &&
      JSON.stringify(row.topics).toLowerCase() === JSON.stringify(log.topics).toLowerCase()));
  }
}

const read = async (name: string) => Bun.file(`${output}/${name}.json`).json();
const gate = Bun.file(`${output}/fixture-gate-cross.json`);
const prior = await gate.exists() ? await gate.json() : null;

interface Request {
  endpoint: string;
  request: { method: string; params: { fromBlock: string; toBlock: string }[] };
  error?: { kind: string };
  body?: string;
}
interface Vote {
  endpoint: string;
  ids?: string[];
}
interface Decision extends Window {
  index: number; before: number; after: number; initial: string;
  votes: Vote[]; accepted?: string[];
}
interface Sample {
  name: string; mode: string; initialNext: number; checkpoint: { next: number; observed: string[] };
  stop: string | null; windows: Decision[]; requests: Request[]; requestCount: number;
  missing: string[]; extra: string[]; observed: string[]; elapsedMs: number; catchUpMs: number | null;
}
const metrics = [];
const glob = new Bun.Glob('{live,fixture}-*.json');
for await (const filename of glob.scan({ cwd: output })) {
  const sample = await read(filename.slice(0, -5)) as Sample;
  const probe = sample.mode === 'probe';
  let cursor = sample.initialNext;
  const observed: string[] = sample.mode === 'resume' ? [...prior.checkpoint.observed] : [];
  const logRequests = sample.requests.filter(row => row.request.method === 'eth_getLogs');
  for (const window of sample.windows) {
    deepStrictEqual(window.before, cursor);
    if (!probe) {
      deepStrictEqual(window.index, cursor);
      const expectedWindow = windows[cursor]!;
      deepStrictEqual([window.from, window.to], [expectedWindow.from, expectedWindow.to]);
    }
    for (const vote of window.votes) {
      const req = logRequests.find(row => row.endpoint === vote.endpoint &&
        Number(row.request.params[0]?.fromBlock) === window.from &&
        Number(row.request.params[0]?.toBlock) === window.to);
      if (vote.ids) {
        ok(req && !req.error && req.body);
        const { result } = JSON.parse(req.body) as { result: RawLog[] };
        deepStrictEqual(result.map(identity).sort(), vote.ids);
      }
    }
    const votes = window.votes.flatMap(vote => vote.ids ? [vote.ids] : []);
    let expected: string[] | undefined;
    if (probe || sample.mode === 'single') expected = votes[0];
    else {
      const representations = votes.map(ids => JSON.stringify(ids));
      const duplicate = representations.find((ids, index) => representations.indexOf(ids) < index);
      expected = duplicate ? JSON.parse(duplicate) : undefined;
    }
    deepStrictEqual(window.accepted, expected);
    if (expected) {
      observed.push(...expected);
      if (!probe) cursor++;
    }
    deepStrictEqual(window.after, cursor);
  }
  deepStrictEqual(sample.observed, observed);
  deepStrictEqual(sample.checkpoint.next, cursor);
  deepStrictEqual(sample.requestCount, sample.requests.length);
  deepStrictEqual(sample.missing, identities.filter(id => !observed.includes(id)));
  deepStrictEqual(sample.extra, [...new Set(observed.filter(id => !identities.includes(id)))]);
  const committedMissing = probe ? null : sample.missing.filter(id => {
    const block = Number(id.split(':')[0]);
    return windows.slice(0, cursor).some(window => block >= window.from && block <= window.to);
  }).length;
  metrics.push({
    name: sample.name, mode: sample.mode, requests: sample.requestCount, logRequests: logRequests.length,
    fallbackWindows: sample.windows.filter(window => window.votes.length === 3).length,
    initialMismatches: sample.windows.filter(window => window.initial === 'mismatch').length,
    initialErrors: sample.windows.filter(window => window.initial === 'error').length,
    wireErrors: sample.requests.flatMap(request => request.error ? [request.error.kind] : []),
    initialNext: sample.initialNext, finalNext: cursor, attemptedWindows: sample.windows.length,
    observed: observed.length, missing: sample.missing.length, extra: sample.extra.length,
    committedMissing, unprocessedExpected: committedMissing === null ? null : sample.missing.length - committedMissing,
    stop: sample.stop, catchUpMs: sample.catchUpMs, elapsedMs: sample.elapsedMs,
  });
}
ok(metrics.length > 0);
if (prior) {
  const recovered = await read('fixture-gate-resume');
  const failedWindow = prior.windows.at(-1);
  ok(prior.stop && prior.checkpoint.next === failedWindow.index);
  deepStrictEqual(recovered.initialNext, failedWindow.index);
  deepStrictEqual(recovered.windows[0].from, failedWindow.from);
  deepStrictEqual(recovered.missing, []);
  for (const [name, expectedMisses] of [
    ['fixture-omission-single-single', 48],
    ['fixture-omission-cross-cross', 0],
    ['fixture-shared-omission-cross', 48],
    ['fixture-error-cross-cross', 0],
  ] as const) {
    const run = await read(name);
    deepStrictEqual(run.checkpoint.next, windows.length);
    deepStrictEqual(run.missing.length, expectedMisses);
    deepStrictEqual(run.extra.length, 0);
  }
  const equalCount = await read('fixture-equal-count-cross');
  const [a, b, c] = equalCount.windows.at(-1).votes;
  ok(equalCount.stop && a.ids.length === b.ids.length && a.ids[0] !== b.ids[0] && c.ids.length > a.ids.length);
}
console.log(JSON.stringify(metrics.sort((a, b) => a.name.localeCompare(b.name) || a.mode.localeCompare(b.mode)), null, 2));
