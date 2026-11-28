// `bun run seed-recovery [chain...]`: live, read-only, keyless. Per chain: rediscover every announcement from the
// published feed with no checkpoint and scan it with seed-derived keys, then measure what finding the assets of every
// scheme-1 stealth address costs over keyless RPC. Writes data/seed-recovery/<chain>.json: counts only, no addresses.
import { writeFileSync } from 'node:fs';
import { getAnnouncementsForUser, type AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { PoliteHttp } from '../chain-volume/http.ts';
import { agree, FEED_CHAINS, manifestSchema, type Row } from '../feed/format.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';
import { decodeAnnouncements } from '../shared/raw-logs.ts';
import { SOURCES } from '../real-announcements/fetch.ts';
import { WALLETS } from './derive.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const FEED = 'https://raw.githubusercontent.com/xochi-fi/erc5564-scan-benchmark/feed/';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_1155 = ['0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'];
/** Per chain, eth_getLogs requests for the Transfer scan; past it the result records how far it got. */
const BUDGET = 600;
const CHUNK = 50;
const abi = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
  'function getEthBalance(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const http = new PoliteHttp({ minIntervalMs: 275, timeoutMs: 60_000 });
const stats = { requests: 0, bytes: 0, errors: 0 };
async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  stats.requests++; stats.bytes += res.responseBytes;
  const body = res.text ? JSON.parse(res.text) : {};
  if (body.result === undefined) { stats.errors++; throw new Error(`${method}: ${JSON.stringify(body.error ?? res.networkError ?? res.status).slice(0, 200)}`); }
  return body.result;
}
const hex = (n: number) => `0x${n.toString(16)}`;
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function feed(chainId: number) {
  let requests = 0, bytes = 0;
  const get = (side: string) => async (path: string) => {
    const res = await fetch(`${FEED}${side}/v1/${chainId}/${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${res.url} HTTP ${res.status}`);
    const text = await res.text();
    requests++; bytes += Number(res.headers.get('content-length') ?? text.length);
    return text;
  };
  const start = performance.now();
  const [ga, gb] = [get('a'), get('b')];
  const [a, b] = await Promise.all([ga, gb].map(async g => manifestSchema.parse(JSON.parse(await g('manifest.json')))));
  const { rows, agreedTo, disagreement } = await agree(a!, b!, ga, gb);
  const fetchMs = performance.now() - start;
  if (disagreement) throw new Error(`feeds disagree: ${JSON.stringify(disagreement)}`);
  return { requests, bytes, fetchMs, agreedTo, rows };
}

const toLogs = (rows: Row[]): AnnouncementLog[] => decodeAnnouncements(rows.map(r => ({
  address: ANNOUNCER, blockHash: r.blockHash, blockNumber: hex(r.block), data: r.data, logIndex: hex(r.logIndex),
  topics: [ANNOUNCEMENT_TOPIC, ...r.topics], transactionHash: r.txHash, transactionIndex: hex(r.txIndex),
})));

/** ERC-5564 metadata: view tag, 0xeeeeeeee or a transfer selector, token, amount or id. Also seen: 54 bytes of view tag, 0x01, token, amount. */
export function announcedAsset(metadata: Hex): { kind: 'no asset field' | 'native' | 'token' | 'token, 54-byte layout' | 'other layout'; token: string | null } {
  const selector = metadata.slice(4, 12);
  if (metadata.length <= 4) return { kind: 'no asset field', token: null };
  if (metadata.length === 2 + 2 * 54 && metadata.slice(4, 6) === '01') return { kind: 'token, 54-byte layout', token: `0x${metadata.slice(6, 46)}`.toLowerCase() };
  if (metadata.length < 52) return { kind: 'other layout', token: null };
  if (selector === 'eeeeeeee') return { kind: 'native', token: null };
  if (selector === 'a9059cbb' || selector === '23b872dd') return { kind: 'token', token: `0x${metadata.slice(12, 52)}`.toLowerCase() };
  return { kind: 'other layout', token: null };
}

async function multicall(url: string, calls: { target: string; callData: Hex }[], decode: (data: Hex) => bigint) {
  let nonzero = 0, failed = 0;
  for (const batch of chunks(calls, 100)) {
    const data = encodeFunctionData({ abi, functionName: 'aggregate3', args: [batch.map(c => ({ target: c.target as Hex, allowFailure: true, callData: c.callData }))] });
    const out = decodeFunctionResult({ abi, functionName: 'aggregate3', data: await rpc(url, 'eth_call', [{ to: MULTICALL3, data }, 'latest']) }) as readonly { success: boolean; returnData: Hex }[];
    for (const r of out) {
      if (!r.success || r.returnData === '0x') { failed++; continue; }
      try { if (decode(r.returnData) > 0n) nonzero++; } catch { failed++; }
    }
  }
  return { calls: calls.length, requests: Math.ceil(calls.length / 100), nonzero, failed };
}

/** Logs whose recipient topic is one of `addresses`, from `from` to `to`, halving the span on errors, within BUDGET. */
async function transferScan(url: string, addresses: string[], from: number, to: number, span: number) {
  const received = new Set<string>();
  const start = performance.now(), before = stats.requests;
  let coveredTo = from - 1, requests = 0;
  const jobs = chunks(addresses.map(topic), CHUNK).flatMap(set => [[TRANSFER, null, set], [TRANSFER_1155, null, null, set]]);
  let block = from, step = span;
  while (block <= to && requests < BUDGET) {
    const end = Math.min(to, block + step - 1);
    try {
      for (const topics of jobs) {
        requests++;
        for (const log of await rpc(url, 'eth_getLogs', [{ topics, fromBlock: hex(block), toBlock: hex(end) }])) {
          const recipient = `0x${(log.topics[0] === TRANSFER ? log.topics[2] : log.topics[3]).slice(26)}`;
          received.add(`${recipient}:${log.address.toLowerCase()}`);
        }
      }
      coveredTo = end; block = end + 1;
    } catch { if (step <= 1000) break; step = Math.max(1000, Math.floor(step / 2)); }
  }
  return { received, from, to, coveredTo, finalSpan: step, requests: stats.requests - before, ms: performance.now() - start, complete: coveredTo >= to };
}

async function chain(key: string) {
  const c = FEED_CHAINS.find(x => x.key === key)!;
  const { url, span } = SOURCES[key]!;
  const f = await feed(c.chainId);
  const logs = toLogs(f.rows);
  const keys = WALLETS['ScopeLift SDK example']!(c.chainId);
  const t = performance.now();
  const matches = await getAnnouncementsForUser({ announcements: logs, spendingPublicKey: keys.spendingPublicKey, viewingPrivateKey: keys.viewingPrivateKey });
  const scanMs = performance.now() - t;

  const scheme1 = logs.filter(l => l.schemeId === 1n);
  const addresses = [...new Set(scheme1.map(l => l.stealthAddress.toLowerCase()))];
  const announced = new Map<string, Set<string>>();
  const metadata: Record<string, number> = {};
  for (const l of scheme1) {
    const a = announcedAsset(l.metadata);
    metadata[a.kind] = (metadata[a.kind] ?? 0) + 1;
    if (a.token) {
      const set = announced.get(l.stealthAddress.toLowerCase()) ?? new Set();
      announced.set(l.stealthAddress.toLowerCase(), set.add(a.token));
    }
  }
  const native = await multicall(url, addresses.map(a => ({ target: MULTICALL3, callData: encodeFunctionData({ abi, functionName: 'getEthBalance', args: [a as Hex] }) })),
    d => decodeFunctionResult({ abi, functionName: 'getEthBalance', data: d }) as bigint);
  const pairs = [...announced].flatMap(([a, tokens]) => [...tokens].map(token => ({ target: token, callData: encodeFunctionData({ abi, functionName: 'balanceOf', args: [a as Hex] }) })));
  const tokens = await multicall(url, pairs, d => decodeFunctionResult({ abi, functionName: 'balanceOf', data: d }) as bigint);
  const first = Math.min(...scheme1.map(l => Number(l.blockNumber)));
  const scan = await transferScan(url, addresses, first, f.agreedTo, span || 1000);
  const unannounced = [...scan.received].filter(r => { const [a, token] = r.split(':') as [string, string]; return !announced.get(a)?.has(token); });
  return {
    chain: key, measuredAt: new Date().toISOString(), rpc: new URL(url).host,
    feed: { requests: f.requests, bytes: f.bytes, fetchMs: Math.round(f.fetchMs), agreedThrough: f.agreedTo, announcements: logs.length, scanMs: Math.round(scanMs), matches: matches.length },
    assets: {
      stealthAddresses: addresses.length, metadata, native, announcedTokens: tokens,
      transfers: { from: scan.from, to: scan.to, coveredTo: scan.coveredTo, complete: scan.complete, finalSpan: scan.finalSpan, requests: scan.requests, ms: Math.round(scan.ms),
        receivedPairs: scan.received.size, unannouncedPairs: unannounced.length, addressesWithUnannounced: new Set(unannounced.map(r => r.split(':')[0])).size },
    },
    rpcTotals: { ...stats },
  };
}

if (import.meta.main) {
  const only = Bun.argv.slice(2);
  for (const c of FEED_CHAINS) {
    if (only.length && !only.includes(c.key)) continue;
    Object.assign(stats, { requests: 0, bytes: 0, errors: 0 });
    const result = await chain(c.key);
    writeFileSync(`${ROOT}data/seed-recovery/${c.key}.json`, `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify(result));
  }
}
