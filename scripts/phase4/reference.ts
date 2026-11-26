import { filter, hex, identity, scope, type LogIdentity } from './config.ts';

const sources = [
  { url: 'https://base-rpc.publicnode.com', span: 200 },
  { url: 'https://gateway.tenderly.co/public/base', span: 173 },
];
// The two reference hosts are independent providers. Keep Tenderly-operated
// reference hosts out of the measured endpoint matrix.
const file = Bun.argv[2];
if (!file || await Bun.file(file).exists()) throw new Error('Pass a new reference output path');
type Raw = LogIdentity & { address: string; topics: string[]; data: string; removed?: boolean };
const captures = await Promise.all(sources.map(async ({ url, span }) => {
  const requests: unknown[] = [];
  const startedAt = new Date().toISOString();
  const makeCall = async <T>(method: string, params: unknown[]): Promise<T> => {
    const id = requests.length + 1;
    const start = performance.now();
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
    for (let from = scope.start; from <= scope.head; from += span) {
      const to = Math.min(from + span - 1, scope.head);
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
    return { url, span, startedAt, requests, headHash: head.hash.toLowerCase(), identities, error: null };
  } catch (error) {
    return { url, span, startedAt, requests, error: String(error) };
  }
}));
const [a, b] = captures;
const agreed = a?.error === null && b?.error === null && a.headHash === b.headHash &&
  JSON.stringify(a.identities) === JSON.stringify(b.identities);
await Bun.write(file, JSON.stringify({
  scope, captures, agreed, headHash: agreed ? a.headHash : null, identities: agreed ? a.identities : null,
}, null, 2) + '\n');
if (!agreed) process.exitCode = 1;
console.log({ agreed, sources: captures.map(({ url, error, identities }) => ({ url, error, identities })) });
