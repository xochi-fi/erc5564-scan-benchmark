import { filter, hex, identity, chainVolumeIdentity, scope, rpc, type LogIdentity, type Window } from './config.ts';

const sources = [
  { url: rpc.tenderly, span: 1000 },
  { url: rpc.sentio, span: 613 },
];
const file = Bun.argv[2];
if (!file || await Bun.file(file).exists()) throw new Error("Pass a new reference output path");
const prior = await Bun.file('data/chain-volume/canonical/retrieve-base-parallel.json').json() as { identities: string[] };
const sequential = await Bun.file('data/chain-volume/canonical/retrieve-base-probe-informed.json').json() as {
  identities: string[];
  result: { checkpoint: number; endpoints: { url: string; ok: number }[] };
};
const inScope = (id: string) => {
  const block = Number(id.split(":")[0]);
  return block >= scope.start && block <= scope.head;
};
const expected = prior.identities.filter(inScope).sort();
if (expected.length !== 48 || sequential.identities.some(inScope) || sequential.result.checkpoint !== scope.head + 1 ||
    sequential.result.endpoints.find(endpoint => endpoint.url === rpc.daybreak)?.ok !== (scope.head - scope.start + 1) / 2000) {
  throw new Error('Chain-volume raw runs do not match the expected Daybreak omission');
}
const positive = new Set(expected.map(id => Math.floor((Number(id.split(":")[0]) - scope.start) / scope.pageBlocks)));
const sampled = [0, 3059, 6119, 9179, 12239, ...positive];
const indices = new Set(sampled.flatMap(index => [index - (index % 2), index - (index % 2) + 1]));
const windows: Window[] = [...indices].sort((a, b) => a - b).map(index => {
  const from = scope.start + index * scope.pageBlocks;
  return { from, to: from + scope.pageBlocks - 1 };
});
type Raw = LogIdentity & { address: string; topics: string[]; data: string; removed?: boolean };
const captures = await Promise.all(sources.map(async ({ url, span }) => {
  const requests: unknown[] = [];
  const startedAt = new Date().toISOString();
  let nextRequest = 0;
  const makeCall = async <T>(method: string, params: unknown[]): Promise<T> => {
    const id = requests.length + 1;
    await Bun.sleep(Math.max(0, nextRequest - performance.now()));
    const start = performance.now();
    nextRequest = start + 275;
    const request = { jsonrpc: '2.0', id, method, params };
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      requests.push({ request, status: response.status, elapsedMs: performance.now() - start, body });
      const json = JSON.parse(body);
      if (!response.ok || json.id !== id || json.error || !Object.hasOwn(json, 'result')) throw new Error(`${method} failed`);
      return json.result;
    } catch (error) {
      if (requests.length < id) requests.push({ request, elapsedMs: performance.now() - start, error: String(error) });
      throw error;
    }
  };
  try {
    if (await makeCall('eth_chainId', []) !== scope.chainId) throw new Error('wrong chain');
    const head = await makeCall<{ hash: string; number: string }>('eth_getBlockByNumber', [hex(scope.head), false]);
    if (Number(head.number) !== scope.head || !/^0x[\da-f]{64}$/i.test(head.hash)) throw new Error('wrong head');
    const logs: Raw[] = [];
    for (const window of windows) for (let from = window.from; from <= window.to; from += span) {
      const to = Math.min(from + span - 1, window.to);
      const query = filter(from, to);
      const page = await makeCall<Raw[]>('eth_getLogs', [query]);
      for (const log of page) {
        const block = Number(log.blockNumber);
        if (block < from || block > to || log.removed ||
            log.address.toLowerCase() !== query.address || log.topics[0]?.toLowerCase() !== query.topics[0]) {
          throw new Error('reference log outside filter');
        }
        logs.push(log);
      }
    }
    const identities = logs.map(identity).sort();
    if (!identities.length || new Set(identities).size !== identities.length) throw new Error('empty or duplicate reference');
    for (const log of logs) {
      const receipt = await makeCall<{ logs: Raw[] }>('eth_getTransactionReceipt', [log.transactionHash]);
      if (!receipt.logs.some(row => identity(row) === identity(log) &&
          row.address.toLowerCase() === log.address.toLowerCase() &&
          JSON.stringify(row.topics).toLowerCase() === JSON.stringify(log.topics).toLowerCase() &&
          row.data.toLowerCase() === log.data.toLowerCase())) throw new Error('reference receipt mismatch');
    }
    return { url, span, startedAt, requests, headHash: head.hash.toLowerCase(), identities, logs, error: null };
  } catch (error) {
    return { url, span, startedAt, requests, error: String(error) };
  }
}));
const [a, b] = captures;
const agreed = a?.error === null && b?.error === null && a.headHash === b.headHash &&
  JSON.stringify(a.identities) === JSON.stringify(b.identities) &&
  JSON.stringify(a.identities.map(chainVolumeIdentity).sort()) === JSON.stringify(expected);
await Bun.write(file, JSON.stringify({
  scope, windows, expected, captures, agreed, logs: agreed ? a.logs : null, headHash: agreed ? a.headHash : null, identities: agreed ? a.identities : null,
}, null, 2) + '\n');
if (!agreed) process.exitCode = 1;
console.log({ agreed, sources: captures.map(({ url, error, requests }) => ({ url, error, requests: requests.length })) });
