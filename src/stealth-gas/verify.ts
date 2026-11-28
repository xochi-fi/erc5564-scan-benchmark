// `bun run stealth-gas:verify`: re-reads every recorded spend and funding transaction from a second provider and
// checks sender, target and, for Umbra, the TokenWithdrawal log. Read-only, keyless. Exits nonzero on a mismatch.
import { PoliteHttp } from '../chain-volume/http.ts';
import { SPAM_CHAINS } from '../spam-cost/run.ts';
import { stealthSpends } from '../figures/data.ts';
import { TOKEN_WITHDRAWAL } from './usage.ts';

const http = new PoliteHttp({ minIntervalMs: 275 });
// Gnosis publicnode and pocket return null for older transactions.
const EXTRA: Record<string, string[]> = { gnosis: ['https://rpc.gnosis.gateway.fm'] };
/** First answer from the chain's endpoints other than the one that recorded the sample. */
async function rpc(chain: string, source: string, method: string, params: unknown[]) {
  const errors: string[] = [];
  for (const url of [...SPAM_CHAINS[chain]!.endpoints, ...EXTRA[chain] ?? []].filter(u => new URL(u).host !== source)) {
    const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    try {
      const body = JSON.parse(res.text);
      if ('result' in body && body.result !== null) return body.result;
      errors.push(`${url}: ${JSON.stringify(body.error)}`);
    } catch { errors.push(`${url}: HTTP ${res.status}`); }
  }
  throw new Error(`${chain} ${method}: ${errors.join('; ')}`);
}

let checked = 0, bad = 0;
for (const r of stealthSpends() as any[]) {
  const ask = (method: string, params: unknown[]) => rpc(r.chain, r.source, method, params);
  const problems: string[] = [];
  if (r.spendTx?.startsWith('0x')) {
    const tx = await ask('eth_getTransactionByHash', [r.spendTx]);
    if (tx?.from.toLowerCase() !== r.spendFrom || (tx.to ?? '').toLowerCase() !== r.spendTo) problems.push(`spend ${r.spendTx}`);
    if (r.kind === 'umbra') {
      const receipt = await ask('eth_getTransactionReceipt', [r.spendTx]);
      if (!receipt.logs.some((l: any) => l.topics[0] === TOKEN_WITHDRAWAL && l.topics[1].endsWith(r.s.slice(2)) && l.topics[2].endsWith(r.dest.slice(2)))) problems.push(`withdrawal log ${r.spendTx}`);
    }
  }
  if (r.funderTx?.startsWith('0x') && r.funder?.startsWith('0x')) {
    const tx = await ask('eth_getTransactionByHash', [r.funderTx]);
    if (tx?.from.toLowerCase() !== r.funder || (tx.to ?? '').toLowerCase() !== r.s) problems.push(`funding ${r.funderTx}`);
  }
  checked++;
  if (problems.length) { bad++; console.error(r.chain, r.s, problems.join(', ')); }
}
console.log(`${checked} spends checked, ${bad} mismatched`);
if (bad) process.exitCode = 1;
