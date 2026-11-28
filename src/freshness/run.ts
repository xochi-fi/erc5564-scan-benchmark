// `bun run freshness [MINUTES]`: samples each chain's `latest` and `finalized` headers every 12 s and polls
// the Announcer tail from finalized+1 to latest, the hybrid client's RPC part. Read-only and keyless.
// Writes data/freshness/<chain>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PoliteHttp } from '../chain-volume/http.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const http = new PoliteHttp({ minIntervalMs: 275 });
export const INTERVAL_MS = 12_000;

/** One keyless endpoint per chain with a getLogs span cap from data/chain-volume/endpoints.csv. */
export const FRESHNESS_CHAINS: Record<string, { url: string; maxSpan: number }> = {
  ethereum: { url: 'https://gateway.tenderly.co/public/mainnet', maxSpan: 100_000 },
  base: { url: 'https://base-rpc.publicnode.com', maxSpan: 50_000 },
  arbitrum: { url: 'https://arbitrum.gateway.tenderly.co', maxSpan: 100_000 },
  optimism: { url: 'https://optimism.gateway.tenderly.co', maxSpan: 100_000 },
  gnosis: { url: 'https://rpc.gnosischain.com', maxSpan: 100_000 },
  polygon: { url: 'https://polygon.gateway.tenderly.co', maxSpan: 100_000 },
  sepolia: { url: 'https://sepolia.gateway.tenderly.co', maxSpan: 100_000 },
};

async function call(url: string, method: string, params: unknown[]) {
  const sentAt = Date.now();
  const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const receivedAt = Date.now();
  let body: any = null;
  try { body = JSON.parse(res.text); } catch { /* recorded below */ }
  return { sentAt, receivedAt, ms: Math.round(res.ms), bytes: res.responseBytes, result: body?.result ?? null, error: body?.error ?? (res.ok ? null : `HTTP ${res.status} ${res.networkError ?? ''}`.trim()) };
}
const header = (b: any) => (b ? { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)), hash: b.hash } : null);
const hex = (n: number) => `0x${n.toString(16)}`;

async function sampleChain(chain: string, until: number) {
  const { url, maxSpan } = FRESHNESS_CHAINS[chain]!;
  const samples = [];
  while (Date.now() < until) {
    const tick = Date.now();
    const latest = await call(url, 'eth_getBlockByNumber', ['latest', false]);
    const finalized = await call(url, 'eth_getBlockByNumber', ['finalized', false]);
    const l = header(latest.result), f = header(finalized.result);
    const tail = [];
    if (l && f && l.number > f.number) {
      for (let from = f.number + 1; from <= l.number; from += maxSpan) {
        const to = Math.min(from + maxSpan - 1, l.number);
        const r = await call(url, 'eth_getLogs', [{ address: ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC], fromBlock: hex(from), toBlock: hex(to) }]);
        tail.push({ from, to, ms: r.ms, bytes: r.bytes, logs: Array.isArray(r.result) ? r.result.map((x: any) => `${Number(BigInt(x.blockNumber))}:${x.blockHash}:${x.transactionHash}:${Number(BigInt(x.logIndex))}`) : null, error: r.error });
      }
    }
    samples.push({
      latest: { sentAt: latest.sentAt, receivedAt: latest.receivedAt, ms: latest.ms, block: l, error: latest.error },
      finalized: { sentAt: finalized.sentAt, receivedAt: finalized.receivedAt, ms: finalized.ms, block: f, error: finalized.error },
      tail,
    });
    await Bun.sleep(Math.max(0, tick + INTERVAL_MS - Date.now()));
  }
  return { chain, url, intervalMs: INTERVAL_MS, startedAt: new Date(samples[0]?.latest.sentAt ?? Date.now()).toISOString(), samples };
}

if (import.meta.main) {
  const minutes = Number(Bun.argv[2] ?? 30);
  mkdirSync(`${ROOT}data/freshness`, { recursive: true });
  const until = Date.now() + minutes * 60_000;
  await Promise.all(Object.keys(FRESHNESS_CHAINS).map(async chain => {
    const record = await sampleChain(chain, until);
    writeFileSync(`${ROOT}data/freshness/${chain}.json`, `${JSON.stringify(record)}\n`);
    console.log(chain, record.samples.length, 'samples');
  }));
}
