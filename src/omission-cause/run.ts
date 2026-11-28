// `bun run omission-cause`: why do some keyless providers return [] for known announcements?
// For each known announcement a provider omitted (data/chain-volume/consistency/), ask that provider and a
// control provider the same read-only questions: the announcement's block header, the announcement's
// receipt, eth_getLogs for the Announcer over three page sizes and by block hash, and two canaries in the
// same block (every Transfer log; one busy token's Transfer logs). Writes data/omission-cause/<chain>.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PoliteHttp } from '../chain-volume/http.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const http = new PoliteHttp({ minIntervalMs: 275 });
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const TARGETS = {
  base: {
    canaryToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    control: 'https://base.gateway.tenderly.co',
    suspects: ['https://base.daybreak-rpc.network', 'https://rpc.degenprotocol.io/base', 'https://rpc.baseazul.dev'],
  },
  optimism: {
    canaryToken: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    control: 'https://optimism.gateway.tenderly.co',
    suspects: ['https://public.1rpc.io/op'],
  },
} as const;

async function rpc(url: string, method: string, params: unknown[]) {
  const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  let body: any = null;
  try { body = JSON.parse(res.text); } catch { /* recorded as text */ }
  return {
    method, params, status: res.status, ms: Math.round(res.ms), requestBytes: res.requestBytes, responseBytes: res.responseBytes,
    ...(body?.error ? { error: body.error } : body && 'result' in body ? { result: body.result } : { text: (res.networkError ?? res.text).slice(0, 200) }),
  };
}

const hex = (n: number) => `0x${n.toString(16)}`;
const logs = (from: number, to: number, filter: Record<string, unknown>) => [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }];

/** One provider's answers about one known announcement. */
async function probe(url: string, block: number, logIndex: number, tx: string, token: string) {
  const header = await rpc(url, 'eth_getBlockByNumber', [hex(block), false]);
  const head = (header as any).result;
  const blockHash: string | null = head?.hash ?? null;
  const announcer = { address: ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC] };
  return {
    url, block, logIndex, tx,
    header: { ...header, result: head ? { hash: head.hash, timestamp: head.timestamp } : head ?? null },
    receipt: summarizeReceipt(await rpc(url, 'eth_getTransactionReceipt', [tx]), logIndex),
    announcerOneBlock: summarizeLogs(await rpc(url, 'eth_getLogs', logs(block, block, announcer)), logIndex),
    announcer50: summarizeLogs(await rpc(url, 'eth_getLogs', logs(block - 25, block + 24, announcer)), logIndex),
    announcer1000: summarizeLogs(await rpc(url, 'eth_getLogs', logs(block - 500, block + 499, announcer)), logIndex),
    announcerByHash: blockHash ? summarizeLogs(await rpc(url, 'eth_getLogs', [{ ...announcer, blockHash }]), logIndex) : null,
    topicOnlyOneBlock: summarizeLogs(await rpc(url, 'eth_getLogs', logs(block, block, { topics: [ANNOUNCEMENT_TOPIC] })), logIndex),
    canaryTransfers: summarizeLogs(await rpc(url, 'eth_getLogs', logs(block, block, { topics: [TRANSFER] })), null),
    canaryToken: summarizeLogs(await rpc(url, 'eth_getLogs', logs(block, block, { address: token, topics: [TRANSFER] })), null),
  };
}

function summarizeLogs(call: Awaited<ReturnType<typeof rpc>>, logIndex: number | null) {
  const { result, ...rest } = call as any;
  if (!Array.isArray(result)) return { ...rest, result: result ?? null };
  return {
    ...rest, count: result.length,
    ...(logIndex === null ? {} : { hasTarget: result.some((l: any) => Number(BigInt(l.logIndex)) === logIndex && l.address.toLowerCase() === ANNOUNCER) }),
  };
}
function summarizeReceipt(call: Awaited<ReturnType<typeof rpc>>, logIndex: number) {
  const { result, ...rest } = call as any;
  if (!result) return { ...rest, result: result ?? null };
  return { ...rest, status: result.status, blockNumber: Number(BigInt(result.blockNumber)), logs: result.logs.length,
    hasTarget: result.logs.some((l: any) => Number(BigInt(l.logIndex)) === logIndex && l.address.toLowerCase() === ANNOUNCER) };
}

function knownAnnouncements(chain: string): { block: number; logIndex: number; tx: string }[] {
  const consistency = JSON.parse(readFileSync(`${ROOT}data/chain-volume/consistency/${chain}.json`, 'utf8'));
  const ids: string[] = ['parallel', 'probe-informed', 'list-order'].flatMap(strategy => {
    try { return JSON.parse(readFileSync(`${ROOT}data/chain-volume/canonical/retrieve-${chain}-${strategy}.json`, 'utf8')).identities as string[]; } catch { return []; }
  });
  return (consistency.targets as string[]).map(target => {
    const [block, logIndex] = target.split(':').map(Number) as [number, number];
    const id = ids.find(i => i === `${block}:${logIndex}:${i.split(':')[2]}`);
    if (id === undefined) throw new Error(`${chain}: no recorded identity for ${target}`);
    return { block, logIndex, tx: id.split(':')[2]! };
  });
}

if (import.meta.main) {
  mkdirSync(`${ROOT}data/omission-cause`, { recursive: true });
  for (const [chain, t] of Object.entries(TARGETS)) {
    const targets = knownAnnouncements(chain);
    const providers = [];
    // Two passes a few minutes apart: load-balanced providers can answer the same question differently.
    for (const pass of [1, 2]) for (const url of [t.control, ...t.suspects]) {
      const probes = [];
      for (const k of targets) probes.push(await probe(url, k.block, k.logIndex, k.tx, t.canaryToken));
      providers.push({ url, pass, control: url === t.control, probes });
      console.log(chain, url, probes.map(p => `${p.block}: ann=${p.announcerOneBlock.count ?? 'err'} rcpt=${p.receipt.hasTarget ?? 'null'} canary=${p.canaryTransfers.count ?? 'err'}`).join(' | '));
    }
    writeFileSync(`${ROOT}data/omission-cause/${chain}.json`, `${JSON.stringify({ chain, measuredAt: new Date().toISOString(), canaryToken: t.canaryToken, targets, providers })}\n`);
  }
}
