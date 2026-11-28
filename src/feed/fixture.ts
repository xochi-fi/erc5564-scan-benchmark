// Recorded-RPC fixture for the feed tests: real keyless responses for a small Gnosis range
// (blocks 40,950,000-41,059,999, all three Gnosis announcements), replayed without network.
import type { HttpResult, Transport } from '../chain-volume/http.ts';
import type { Post } from './build-b.ts';

export const FIXTURE_DIR = 'test/fixtures/feed';
export const FIXTURE_TARGET = { key: 'gnosis', chainId: 100, deployBlock: 40_950_000, pageBlocks: 25_000, maxBlock: 41_059_999 };
export const FIXTURE_TIME = '2026-11-28T00:00:00.000Z';
export type Exchange = { url: string; request: string; status: number; text: string };

/** Request identity without the JSON-RPC id, which differs between runs. */
export const key = (url: string, body: string) => {
  const { method, params } = JSON.parse(body) as { method: string; params: unknown };
  return `${url} ${method} ${JSON.stringify(params)}`;
};

/**
 * Replays recorded exchanges. A `getLogs` range that was not recorded is answered from all logs
 * recorded for that URL, filtered to the range, so refetches of a disputed page can replay too.
 */
export function replay(exchanges: Exchange[]) {
  const table = new Map(exchanges.map(exchange => [key(exchange.url, exchange.request), exchange]));
  const logsOf = (url: string) => exchanges.filter(exchange => exchange.url === url && exchange.request.includes('eth_getLogs'))
    .flatMap(exchange => (JSON.parse(exchange.text).result ?? []) as { blockNumber: string }[]);
  const find = (url: string, body: string): Exchange => {
    const hit = table.get(key(url, body));
    if (hit) return hit;
    const { method, params } = JSON.parse(body) as { method: string; params: [{ fromBlock: string; toBlock: string }] };
    if (method !== 'eth_getLogs') throw new Error(`No recorded response for ${key(url, body)}`);
    const [from, to] = [Number(params[0].fromBlock), Number(params[0].toBlock)];
    const result = logsOf(url).filter(log => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to);
    return { url, request: body, status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };
  const transport: Transport = {
    async request(url, init) {
      const hit = find(url, init.body ?? '');
      return {
        url, status: hit.status, ok: hit.status >= 200 && hit.status < 300, ms: 0,
        requestBytes: Buffer.byteLength(init.body ?? ''), responseBytes: Buffer.byteLength(hit.text),
        contentLength: null, contentEncoding: null, retryAfter: null, lastModified: null, text: hit.text,
        networkError: null, cloudflareChallenge: false, rateLimited: hit.status === 429, attempts: 1, rateLimitHits: 0,
      } satisfies HttpResult;
    },
  };
  const post: Post = async (url, body) => {
    const hit = find(url, body);
    return { status: hit.status, text: hit.text };
  };
  return { transport, post };
}
