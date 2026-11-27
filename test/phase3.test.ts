import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { endpointExclusion, endpointsFromChainlist } from '../src/phase3/chains.ts';
import { isCloudflareChallenge, parseRetryAfter, type HttpResult, type Transport } from '../src/phase3/http.ts';
import { parseEtherscanLogs, parseV2Page, etherscanLogs, blockscoutV2Logs } from '../src/phase3/indexers.ts';
import { findDeployBlock } from '../src/phase3/probe.ts';
import { percentile, searchMaxRange } from '../src/phase3/range-search.ts';
import { compareSets, retrieveHistory } from '../src/phase3/retrieve.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER, classifyError, interpretRpc, parseLimitHint, quantity, rpcLogsSchema } from '../src/phase3/rpc.ts';

/** Recorded provider responses (bodies trimmed); see test/fixtures/phase3/. */
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/phase3/rpc-errors.json', import.meta.url), 'utf8')) as Array<{ provider: string; httpStatus: number; body: string; kind: string; limitHint: number | null }>;

function http(text: string, status = 200, extra: Partial<HttpResult> = {}): HttpResult {
  return {
    url: 'https://rpc.example', status, ok: status >= 200 && status < 300, ms: 10, requestBytes: 100, responseBytes: text.length,
    contentLength: null, contentEncoding: null, retryAfter: null, lastModified: null, text, networkError: null,
    cloudflareChallenge: false, rateLimited: status === 429, attempts: 1, rateLimitHits: status === 429 ? 1 : 0, ...extra,
  };
}

describe('error classification on recorded provider messages', () => {
  for (const fixture of fixtures) {
    test(`${fixture.provider}: ${fixture.kind}`, () => {
      const call = interpretRpc(http(fixture.body, fixture.httpStatus), rpcLogsSchema);
      expect(call.error?.kind).toBe(fixture.kind as never);
      expect(call.error?.limitHint ?? null).toBe(fixture.limitHint);
    });
  }
  test('limit hints', () => {
    expect(parseLimitHint('eth_getLogs is limited to a 10,000 range')).toBe(10_000);
    expect(parseLimitHint('exceed maximum block range: 50000')).toBe(50_000);
    expect(parseLimitHint('Requested range is over limit of 100')).toBe(100);
    expect(parseLimitHint('block range too large, max 10000 blocks')).toBe(10_000);
    expect(parseLimitHint('Block range limit exceeded. Allowed: up to 1000 blocks')).toBe(1000);
    expect(parseLimitHint('ranges over 100 blocks are not supported on free plan')).toBe(100);
    expect(parseLimitHint('request limit reached')).toBe(null);
  });
  test('rate limit wins over other words when HTTP 429', () => {
    expect(classifyError('too many requests, upgrade your plan', 429)).toBe('rate-limit');
  });
  test('Cloudflare challenge page is "blocked"', () => {
    const page = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenges.cloudflare.com</body></html>';
    expect(isCloudflareChallenge(403, null, page)).toBe(true);
    const call = interpretRpc(http(page, 403, { cloudflareChallenge: true, ok: false }), rpcLogsSchema);
    expect(call.error?.kind).toBe('blocked');
  });
  test('successful result is parsed', () => {
    const call = interpretRpc(http('{"jsonrpc":"2.0","id":1,"result":"0x1a"}'), quantity);
    expect(call.result).toBe(26);
    expect(call.error).toBeNull();
  });
  test('retry-after', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('endpoint list filtering', () => {
  test('credentials, templates, relays and demo keys are excluded', () => {
    expect(endpointExclusion('https://ethereum-rpc.publicnode.com')).toBeNull();
    expect(endpointExclusion('https://mainnet.infura.io/v3/${INFURA_API_KEY}')).toBe('template needs a key');
    expect(endpointExclusion('https://services.tokenview.io/vipapi/nodeservice/eth?apikey=abc')).toBe('key in query string');
    expect(endpointExclusion('https://rpc.owlracle.info/eth/70d38ce1826c4a60bb2a8e05a6c8b20f')).toBe('key-shaped path segment');
    expect(endpointExclusion('https://api-base-mainnet-archive.n.dwellir.com/2ccf18bf-2916-4198-8856-42172854353c')).toBe('key-shaped path segment');
    expect(endpointExclusion('https://eth-mainnet.g.alchemy.com/v2/demo')).toBe('demo key in path');
    expect(endpointExclusion('https://rpc.flashbots.net/fast')).toBe('transaction relay / MEV endpoint');
    expect(endpointExclusion('wss://ethereum-rpc.publicnode.com')).toBe('websocket');
  });
  test('chainlist entries (object and string forms) are deduplicated', () => {
    const list = [{ chainId: 1, name: 'Ethereum Mainnet', rpc: [{ url: 'https://a.example/', tracking: 'none' }, 'https://a.example', 'https://b.example/v1/0123456789abcdef0123456789abcdef'] }];
    const out = endpointsFromChainlist(list, 1);
    expect(out.map(entry => entry.url)).toEqual(['https://a.example', 'https://b.example/v1/0123456789abcdef0123456789abcdef']);
    expect(out[0]?.excluded).toBeNull();
    expect(out[1]?.excluded).toBe('key-shaped path segment');
  });
});

describe('max-range binary search', () => {
  const limited = (limit: number) => async (blocks: number) => ({ verdict: blocks <= limit ? 'ok' as const : 'fail' as const, note: null });
  for (const limit of [1, 50, 100, 800, 1000, 2000, 3333, 10_000, 50_000, 123_457]) {
    test(`finds exact limit ${limit}`, async () => {
      const result = await searchMaxRange(limited(limit), { start: 1000, ceiling: 5_000_000 });
      expect(result.maxOk).toBe(limit);
      expect(result.minFail).toBe(limit + 1);
      expect(result.steps.length).toBeLessThanOrEqual(40);
    });
  }
  test('whole history accepted is reported as unbounded', async () => {
    const result = await searchMaxRange(limited(1e12), { start: 1000, ceiling: 6_400_000 });
    expect(result.unbounded).toBe(true);
    expect(result.maxOk).toBe(6_400_000);
  });
  test('nothing accepted', async () => {
    const result = await searchMaxRange(async () => ({ verdict: 'fail', note: 'auth-required' }), { start: 1000, ceiling: 1e6 });
    expect(result.maxOk).toBe(0);
  });
  test('percentile', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('deploy block bisection', () => {
  test('finds first block with code', async () => {
    const found = await findDeployBlock(async block => block >= 20_042_207, 26_500_000);
    expect(found.deployBlock).toBe(20_042_207);
    expect(found.requests).toBeLessThan(30);
  });
  test('reports missing archive state', async () => {
    const found = await findDeployBlock(async block => (block > 26_000_000 ? true : null), 26_500_000);
    expect(found.deployBlock).toBeNull();
  });
});

const pad = (n: number) => n.toString(16).padStart(64, '0');
function makeLog(block: number, index: number) {
  return {
    address: ANNOUNCER, blockHash: `0x${pad(block)}`, blockNumber: `0x${block.toString(16)}`, data: '0x', logIndex: `0x${index.toString(16)}`,
    removed: false, topics: [ANNOUNCEMENT_TOPIC, `0x${pad(1)}`, `0x${pad(2)}`, `0x${pad(3)}`], transactionHash: `0x${pad(block * 1000 + index)}`, transactionIndex: '0x0',
  };
}
interface SimEndpoint { maxSpan: number; errorBody: string; prunedBelow?: number; silentPrune?: boolean; failEvery?: number; rateLimitFirst?: number }
class SimTransport implements Transport {
  calls: Record<string, number> = {};
  constructor(private readonly endpoints: Record<string, SimEndpoint>, private readonly logs: Array<{ block: number; index: number }>) {}
  async request(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<HttpResult> {
    const endpoint = this.endpoints[url];
    if (endpoint === undefined) throw new Error(`unknown ${url}`);
    const n = (this.calls[url] = (this.calls[url] ?? 0) + 1);
    const body = JSON.parse(init.body ?? '{}') as { id: number; params: Array<{ fromBlock: string; toBlock: string }> };
    const from = Number(BigInt(body.params[0]?.fromBlock ?? '0x0'));
    const to = Number(BigInt(body.params[0]?.toBlock ?? '0x0'));
    if (endpoint.rateLimitFirst !== undefined && n <= endpoint.rateLimitFirst) return http('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit exceeded"}}', 429);
    if (endpoint.failEvery !== undefined && n % endpoint.failEvery === 0) return http('<html>502 Bad Gateway</html>', 502);
    if (to - from + 1 > endpoint.maxSpan) return http(endpoint.errorBody.replaceAll('"id":1', `"id":${body.id}`), 200);
    if (endpoint.prunedBelow !== undefined && from < endpoint.prunedBelow) {
      if (endpoint.silentPrune) return http(`{"jsonrpc":"2.0","id":${body.id},"result":[]}`);
      return http(`{"jsonrpc":"2.0","id":${body.id},"error":{"code":-32000,"message":"missing trie node"}}`);
    }
    const result = this.logs.filter(entry => entry.block >= from && entry.block <= to).map(entry => makeLog(entry.block, entry.index));
    return http(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  }
}

const rangeError = fixtures.find(fixture => fixture.kind === 'range-limit')?.body ?? '';
const LOGS = Array.from({ length: 296 }, (_, i) => ({ block: 1_000_000 + i * 997, index: i % 7 }));

describe('wallet retriever', () => {
  test('halves on range errors and gets the exact set', async () => {
    const transport = new SimTransport({ 'https://a': { maxSpan: 1000, errorBody: rangeError } }, LOGS);
    const result = await retrieveHistory(transport, { endpoints: ['https://a'], fromBlock: 999_000, toBlock: 1_300_000, initialSpan: 50_000, sleep: async () => {} });
    expect(result.success).toBe(true);
    expect(result.logs.length).toBe(296);
    expect(Math.max(...Object.keys(result.spanHistogram).map(Number))).toBeLessThanOrEqual(1000);
  });
  test('falls back to the next endpoint when one has no archive', async () => {
    const transport = new SimTransport({
      'https://pruned': { maxSpan: 1e9, errorBody: rangeError, prunedBelow: 1_250_000 },
      'https://archive': { maxSpan: 10_000, errorBody: rangeError },
    }, LOGS);
    const result = await retrieveHistory(transport, { endpoints: ['https://pruned', 'https://archive'], fromBlock: 999_000, toBlock: 1_300_000, initialSpan: 50_000, sleep: async () => {} });
    expect(result.success).toBe(true);
    expect(result.endpointSwitches).toBe(1);
    expect(result.logs.length).toBe(296);
  });
  test('retries transient 502s and 429s without skipping a window', async () => {
    const transport = new SimTransport({ 'https://flaky': { maxSpan: 5000, errorBody: rangeError, failEvery: 5, rateLimitFirst: 1 } }, LOGS);
    const result = await retrieveHistory(transport, { endpoints: ['https://flaky'], fromBlock: 999_000, toBlock: 1_300_000, initialSpan: 5000, sleep: async () => {} });
    expect(result.success).toBe(true);
    expect(result.logs.length).toBe(296);
  });
  test('a silently pruned endpoint returns too few logs, which the set comparison catches', async () => {
    const transport = new SimTransport({ 'https://silent': { maxSpan: 1e9, errorBody: rangeError, prunedBelow: 1_250_000, silentPrune: true } }, LOGS);
    const result = await retrieveHistory(transport, { endpoints: ['https://silent'], fromBlock: 999_000, toBlock: 1_300_000, initialSpan: 50_000, sleep: async () => {} });
    expect(result.success).toBe(true); // the wallet cannot tell
    const reference = LOGS.map(entry => ({ key: `${entry.block}:${entry.index}`, tx: `0x${pad(entry.block * 1000 + entry.index)}` }));
    const got = result.logs.map(log => ({ key: `${log.blockNumber}:${log.logIndex}`, tx: log.transactionHash }));
    const comparison = compareSets(reference, got);
    expect(comparison.exact).toBe(false);
    expect(comparison.missing.length).toBeGreaterThan(0);
  });
  test('resumes from a saved checkpoint without gaps or duplicates', async () => {
    const transport = new SimTransport({ 'https://a': { maxSpan: 1000, errorBody: rangeError } }, LOGS);
    const base = { endpoints: ['https://a'], fromBlock: 999_000, toBlock: 1_300_000, initialSpan: 1000, sleep: async () => {} };
    let saved: Parameters<NonNullable<Parameters<typeof retrieveHistory>[1]['onCheckpoint']>>[2] | null = null;
    const first = await retrieveHistory(transport, { ...base, maxRequests: 120, onCheckpoint: (_n, _c, progress) => { saved = JSON.parse(JSON.stringify(progress)); } });
    expect(first.success).toBe(false);
    const state = saved as unknown as typeof first;
    expect(state.checkpoint).toBeGreaterThan(base.fromBlock);
    const second = await retrieveHistory(transport, { ...base, resume: { checkpoint: state.checkpoint, logs: state.logs, requests: state.requests, okRequests: state.okRequests, responseBytes: state.responseBytes, requestBytes: state.requestBytes, fetchMs: state.fetchMs, elapsedMs: 0 } });
    expect(second.success).toBe(true);
    expect(second.logs.length).toBe(296);
    expect(new Set(second.logs.map(log => `${log.blockNumber}:${log.logIndex}`)).size).toBe(296);
    expect(second.requests).toBeGreaterThan(state.requests);
  });
  test('reports failure when every endpoint refuses', async () => {
    const transport = new SimTransport({ 'https://x': { maxSpan: 1e9, errorBody: rangeError, prunedBelow: 2_000_000 } }, LOGS);
    const result = await retrieveHistory(transport, { endpoints: ['https://x'], fromBlock: 999_000, toBlock: 1_300_000, initialSpan: 50_000, sleep: async () => {} });
    expect(result.success).toBe(false);
    expect(result.checkpoint).toBe(999_000);
  });
});

describe('set comparison', () => {
  test('tx hash mismatches and missing tx hashes are separated', () => {
    const comparison = compareSets(
      [{ key: '1:0', tx: '0xaa' }, { key: '2:0', tx: '' }, { key: '3:1', tx: '0xcc' }],
      [{ key: '1:0', tx: '0xaa' }, { key: '2:0', tx: '0xbb' }, { key: '3:1', tx: '0xdd' }],
    );
    expect(comparison.txMismatch).toEqual(['3:1']);
    expect(comparison.referenceTxMissing).toBe(1);
    expect(comparison.exact).toBe(false);
  });
});

describe('indexer parsing and paging (recorded bodies)', () => {
  const v2 = readFileSync(new URL('./fixtures/phase3/blockscout-v2-page.json', import.meta.url), 'utf8');
  test('Blockscout v2 page with empty transaction_hash rows', () => {
    const page = parseV2Page(v2);
    expect(page.logs.length).toBe(page.itemCount);
    expect(page.logs.some(log => log.transactionHash === '')).toBe(true);
    expect(page.logs.every(log => /^\d+:\d+$/.test(log.identity))).toBe(true);
  });
  test('etherscan-compatible paging continues past a 100-result cap', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ blockNumber: `0x${(100 + i).toString(16)}`, logIndex: '0x1', transactionHash: `0x${pad(i)}`, timeStamp: '0x6553f100', topics: [ANNOUNCEMENT_TOPIC] }));
    const transport: Transport = {
      async request(url) {
        const from = Number(new URL(url).searchParams.get('fromBlock'));
        const page = rows.filter(row => Number(BigInt(row.blockNumber)) >= from).slice(0, 100);
        return http(JSON.stringify({ status: page.length ? '1' : '0', message: page.length ? 'OK' : 'No records found', result: page }));
      },
    };
    const run = await etherscanLogs(transport, 'routescan', 'https://idx.example/api', 0, 1000);
    expect(run.ok).toBe(true);
    expect(run.logs.length).toBe(250);
    expect(run.pageSizeObserved).toBe(100);
  });
  test('etherscan error body', () => {
    expect(() => parseEtherscanLogs('{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}')).toThrow('Missing/Invalid API Key');
    expect(parseEtherscanLogs('{"status":"0","message":"No records found","result":[]}').logs).toEqual([]);
  });
  test('v2 paging follows next_page_params and stops on Cloudflare', async () => {
    let n = 0;
    const transport: Transport = {
      async request() {
        n++;
        if (n === 1) return http(v2);
        return http('<title>Just a moment...</title>', 403, { cloudflareChallenge: true, ok: false });
      },
    };
    const run = await blockscoutV2Logs(transport, 'https://bs.example');
    expect(run.ok).toBe(false);
    expect(run.blocked).toBe(true);
    expect(run.pages).toBe(1);
  });
});
