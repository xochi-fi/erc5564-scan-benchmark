// `bun run real-announcements:fetch`: raw logs of every canonical ERC-5564 announcement recorded in
// data/chain-volume (identities only there). Keyless, read-only. Writes data/real-announcements/<chain>.json
// and fails unless the fetched identities equal the recorded set.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PoliteHttp } from '../chain-volume/http.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const http = new PoliteHttp({ minIntervalMs: 275 });

/** Endpoint per chain and the widest span it served in data/chain-volume/endpoints.csv (0: one block per request). */
export const SOURCES: Record<string, { url: string; span: number }> = {
  ethereum: { url: 'https://gateway.tenderly.co/public/mainnet', span: 1_000_000 },
  base: { url: 'https://base.gateway.tenderly.co', span: 0 },
  arbitrum: { url: 'https://arbitrum.gateway.tenderly.co', span: 50_000_000 },
  optimism: { url: 'https://optimism.gateway.tenderly.co', span: 10_000_000 },
  gnosis: { url: 'https://rpc.gnosischain.com', span: 10_000_000 },
  polygon: { url: 'https://polygon.gateway.tenderly.co', span: 10_000_000 },
  sepolia: { url: 'https://sepolia.gateway.tenderly.co', span: 1_000_000 },
};

export function recordedIdentities(chain: string): string[] {
  for (const strategy of ['parallel', 'probe-informed', 'list-order']) {
    try {
      const d = JSON.parse(readFileSync(`${ROOT}data/chain-volume/canonical/retrieve-${chain}-${strategy}.json`, 'utf8'));
      if (d.result.success) return d.identities;
    } catch { /* not run */ }
  }
  throw new Error(`${chain}: no complete retrieval`);
}

const hex = (n: number) => `0x${n.toString(16)}`;
async function getLogs(url: string, from: number, to: number): Promise<any[]> {
  const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC], fromBlock: hex(from), toBlock: hex(to) }] }) });
  const body = JSON.parse(res.text);
  if (!Array.isArray(body.result)) throw new Error(`${url} ${from}-${to}: ${JSON.stringify(body.error ?? res.status)}`);
  return body.result;
}

if (import.meta.main) {
  mkdirSync(`${ROOT}data/real-announcements`, { recursive: true });
  const only = Bun.argv.slice(2);
  for (const chain of only.length ? only : Object.keys(SOURCES)) {
    const { url, span } = SOURCES[chain]!;
    const ids = recordedIdentities(chain);
    const blocks = [...new Set(ids.map(i => Number(i.split(':')[0])))].sort((a, b) => a - b);
    const logs: any[] = [];
    if (span === 0) for (const b of blocks) logs.push(...await getLogs(url, b, b));
    else for (let from = blocks[0]!; from <= blocks.at(-1)!; from += span) logs.push(...await getLogs(url, from, Math.min(from + span - 1, blocks.at(-1)!)));
    const got = logs.map(l => `${Number(BigInt(l.blockNumber))}:${Number(BigInt(l.logIndex))}:${l.transactionHash.toLowerCase()}`).sort();
    const want = ids.map(i => i.toLowerCase()).sort();
    if (got.length !== want.length || got.some((g, i) => g !== want[i])) throw new Error(`${chain}: fetched ${got.length} logs, recorded ${want.length}; sets differ`);
    writeFileSync(`${ROOT}data/real-announcements/${chain}.json`, `${JSON.stringify({ chain, url, fetchedAt: new Date().toISOString(), logs })}\n`);
    console.log(chain, logs.length);
  }
}
