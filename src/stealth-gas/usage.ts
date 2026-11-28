// `bun run stealth-gas:usage`: how real stealth addresses paid for gas, from chain state alone.
// ERC-5564: every recorded announcement is checked for a payment; up to 20 paid stealth addresses per chain, spread
// over history, are classified. Umbra: up to 20 most recent
// TokenWithdrawal events per chain. Keyless archive RPC, read-only. Writes data/stealth-gas/usage-<chain>.jsonl.
import { mkdirSync, writeFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, keccak256, pad, parseAbi, toHex, type Hex } from 'viem';
import { PoliteHttp } from '../chain-volume/http.ts';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';
import { recordedIdentities, SOURCES } from '../real-announcements/fetch.ts';
import { UMBRA } from './run.ts';

const OUT = new URL('../../data/stealth-gas/', import.meta.url).pathname;
const http = new PoliteHttp({ minIntervalMs: 275 });
export const SAMPLE = 20;
export const ENTRYPOINTS = ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x0000000071727de22e5e9d8baf0edac6f37da032', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108'];
const REGISTRY_6538 = '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538';
const UMBRA_REGISTRY = '0x31fe56609C65Cd0C510E7125f051D440424D38f3';
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
export const TOKEN_WITHDRAWAL = keccak256(toHex('TokenWithdrawal(address,address,uint256,address)'));
// Umbra log scans: endpoint and span when SOURCES' span is per-block.
const UMBRA_LOGS: Record<string, { url: string; span: number }> = { base: { url: 'https://base.api.pocket.network', span: 10_000 } };
const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256)',
  'function stealthMetaAddressOf(address,uint256) view returns (bytes)',
  'function stealthKeys(address) view returns (uint256,uint256,uint256,uint256)',
]);

const addr = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();
const num = (h: string) => Number(BigInt(h));

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    let body: any = null;
    try { body = JSON.parse(res.text); } catch { /* retried below */ }
    if (body && 'result' in body) return body.result;
    const limited = res.status === 429 || res.status >= 500 || body?.error?.code === -32005 || !body;
    if (!limited || attempt >= 5) throw new Error(`${method} ${JSON.stringify(params).slice(0, 120)}: ${JSON.stringify(body?.error ?? res.status)}`);
    await Bun.sleep(2000 * 2 ** attempt);
  }
}

/** Lowest block in [lo, hi] where `pred` holds, given it holds at hi and is monotone over the range. */
async function firstBlock(lo: number, hi: number, pred: (block: number) => Promise<boolean>): Promise<number> {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await pred(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

class Chain {
  constructor(readonly name: string, readonly url: string) {}
  call = (to: string, data: Hex, block: number | 'latest' = 'latest') => rpc(this.url, 'eth_call', [{ to, data }, block === 'latest' ? block : toHex(block)]);
  nonce = async (a: string, block: number | 'latest' = 'latest') => num(await rpc(this.url, 'eth_getTransactionCount', [a, block === 'latest' ? block : toHex(block)]));
  balance = async (a: string, block: number) => BigInt(await rpc(this.url, 'eth_getBalance', [a, toHex(block)]));
  tokenBalance = async (token: string, a: string, block: number | 'latest') => BigInt(await this.call(token, encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [a as Hex] }), block));
  block = (n: number) => rpc(this.url, 'eth_getBlockByNumber', [toHex(n), true]);
  tx = (hash: string) => rpc(this.url, 'eth_getTransactionByHash', [hash]);
  async registrant(a: string) {
    const r6538 = await this.call(REGISTRY_6538, encodeFunctionData({ abi: ABI, functionName: 'stealthMetaAddressOf', args: [a as Hex, 1n] }));
    const umbra = await this.call(UMBRA_REGISTRY, encodeFunctionData({ abi: ABI, functionName: 'stealthKeys', args: [a as Hex] }));
    return decodeAbiParameters([{ type: 'bytes' }], r6538)[0] !== '0x' || BigInt(`0x${umbra.slice(66, 130)}`) !== 0n; // the prefix word reads 3 when unregistered
  }

  /** The stealth address's first own transaction, if any. */
  async firstOwnTx(s: string, from: number, head: number) {
    if (await this.nonce(s, head) === 0) return null;
    const b = await firstBlock(from, head, async n => await this.nonce(s, n) > 0);
    const txs = (await this.block(b)).transactions.filter((t: any) => t.from.toLowerCase() === s);
    const tx = txs.sort((x: any, y: any) => num(x.nonce) - num(y.nonce))[0];
    return { block: b, tx: tx ?? null };
  }

  /** Who sent the first ETH to `s` in (from, before]. */
  async funder(s: string, from: number, before: number, paymentTx: string) {
    if (await this.balance(s, before) === 0n) return { funder: null, funderTx: null };
    const b = await firstBlock(from, before, async n => await this.balance(s, n) > 0n);
    const direct = (await this.block(b)).transactions.find((t: any) => t.to?.toLowerCase() === s && BigInt(t.value) > 0n);
    if (direct) return { funder: direct.from.toLowerCase(), funderTx: direct.hash.toLowerCase() };
    const payment = paymentTx && (await this.block(b)).transactions.some((t: any) => t.hash.toLowerCase() === paymentTx);
    return { funder: payment ? 'payment' : 'contract', funderTx: payment ? paymentTx : `block:${b}` };
  }
}

function destination(tx: any): string {
  if (tx.input?.startsWith('0xa9059cbb')) {
    const { args } = decodeFunctionData({ abi: ABI, data: tx.input });
    return (args[0] as string).toLowerCase();
  }
  return (tx.to ?? '').toLowerCase();
}

/** Every recorded announcement: which scheme-1 stealth addresses got a payment in the announcing transaction. */
async function erc5564(chain: string, c: Chain, head: number) {
  const ids = recordedIdentities(chain);
  const hashes = [...new Set(ids.map(i => i.split(':').find(p => p.startsWith('0x'))!.toLowerCase()))];
  const census = { announcements: ids.length, scheme1: 0, paidToken: 0, paidEth: 0 };
  const paid: any[] = [];
  for (const hash of hashes) {
    const receipt = await rpc(c.url, 'eth_getTransactionReceipt', [hash]);
    const a = num(receipt.blockNumber);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ANNOUNCER || log.topics[0] !== ANNOUNCEMENT_TOPIC || BigInt(log.topics[1]) !== 1n) continue;
      census.scheme1++;
      const s = addr(log.topics[2]);
      // The asset comes from the payment's Transfer log: some senders do not follow the spec's metadata layout.
      const transfer = receipt.logs.find((l: any) => l.topics[0] === TRANSFER && l.topics.length === 3 && addr(l.topics[2]) === s);
      const eth = !transfer && await c.balance(s, a) > 0n;
      if (transfer) census.paidToken++; else if (eth) census.paidEth++; else continue;
      if (paid.some(p => p.s === s)) continue;
      paid.push({ chain, kind: 'erc5564', tx: hash, s, payer: receipt.from.toLowerCase(), asset: eth ? 'eth' : 'token',
        token: transfer ? transfer.address.toLowerCase() : null, amount: transfer ? BigInt(transfer.data) : null, block: a });
    }
  }
  const out: any[] = [];
  const picks = Math.min(paid.length, SAMPLE);
  for (let j = 0; j < picks; j++) {
    const { amount, ...p } = paid[Math.floor(j * paid.length / picks)]!;
    out.push({ ...p, ...await classify(c, p.s, p.block, head, p.tx, p.token, amount, p.asset === 'eth') });
  }
  return { out, census: { ...census, paidAddresses: paid.length } };
}

async function classify(c: Chain, s: string, from: number, head: number, paymentTx: string, token: string | null, amount: bigint | null, eth: boolean) {
  const code = await rpc(c.url, 'eth_getCode', [s, 'latest']) as string;
  const delegated = code.startsWith('0xef0100') ? `0x${code.slice(8)}` : null;
  const own = await c.firstOwnTx(s, from, head);
  if (own?.tx) {
    const fund = eth ? { funder: 'payment', funderTx: paymentTx } : await c.funder(s, from, own.block - 1, paymentTx);
    return { route: eth ? 'own-eth' : 'funded', spendTx: own.tx.hash.toLowerCase(), spendFrom: s, spendTo: (own.tx.to ?? '').toLowerCase(), dest: destination(own.tx), delegated, ...fund };
  }
  if (own) return { route: delegated ? '7702' : 'unknown', spendTx: `block:${own.block}`, delegated };
  if (token && amount !== null) {
    const now = await c.tokenBalance(token, s, 'latest').catch(() => null);
    if (now !== null && now < amount) {
      const b = await firstBlock(from, head, async n => await c.tokenBalance(token, s, n) < amount);
      const logs = await rpc(c.url, 'eth_getLogs', [{ address: token, topics: [TRANSFER, pad(s as Hex)], fromBlock: toHex(b), toBlock: toHex(b) }]);
      const log = logs[0];
      if (log) {
        const tx = await c.tx(log.transactionHash);
        const to = (tx.to ?? '').toLowerCase();
        return { route: ENTRYPOINTS.includes(to) ? '4337' : 'relayed', spendTx: log.transactionHash.toLowerCase(), spendFrom: tx.from.toLowerCase(), spendTo: to, dest: addr(log.topics[2]), delegated };
      }
      return { route: 'unknown', spendTx: `block:${b}`, delegated };
    }
  }
  return { route: 'unspent', delegated };
}

async function umbra(chain: string, c: Chain, head: number, deploy: number) {
  const { url, span } = UMBRA_LOGS[chain] ?? SOURCES[chain]!;
  const out: any[] = [];
  let requests = 0;
  for (let to = head; to > deploy && out.length < SAMPLE && requests < 60; to -= span, requests++) {
    const logs = await rpc(url, 'eth_getLogs', [{ address: UMBRA, topics: [TOKEN_WITHDRAWAL], fromBlock: toHex(Math.max(deploy, to - span + 1)), toBlock: toHex(to) }]);
    for (const log of logs.reverse()) {
      if (out.length >= SAMPLE) break;
      const tx = await c.tx(log.transactionHash);
      const s = addr(log.topics[1]);
      const self = tx.from.toLowerCase() === s;
      const b = num(log.blockNumber);
      out.push({ chain, kind: 'umbra', tx: log.transactionHash.toLowerCase(), s, asset: 'token', token: addr(log.topics[3]), block: b,
        route: self ? 'funded' : ENTRYPOINTS.includes((tx.to ?? '').toLowerCase()) ? '4337' : 'relayed',
        spendTx: log.transactionHash.toLowerCase(), spendFrom: tx.from.toLowerCase(), spendTo: (tx.to ?? '').toLowerCase(), dest: addr(log.topics[2]),
        ...(self ? await c.funder(s, deploy, b - 1, '') : {}) });
    }
  }
  return { out, requests };
}

const UMBRA_DEPLOY: Record<string, number> = { ethereum: 12343914, base: 10761374, arbitrum: 7285883, optimism: 4069556, gnosis: 28237950, polygon: 20750142, sepolia: 3539169 };

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  const only = Bun.argv.slice(2).filter(a => !a.startsWith('-'));
  for (const chain of only.length ? only : Object.keys(SOURCES)) {
    const c = new Chain(chain, SOURCES[chain]!.url);
    const head = num(await rpc(c.url, 'eth_blockNumber', []));
    let rows: any[];
    try {
      const announced = await erc5564(chain, c, head);
      const withdrawals = await umbra(chain, c, head, UMBRA_DEPLOY[chain]!);
      rows = [...announced.out, ...withdrawals.out];
      writeFileSync(`${OUT}census-${chain}.json`, `${JSON.stringify({ chain, head, source: new URL(c.url).host, erc5564: announced.census, umbraLogRequests: withdrawals.requests })}\n`);
    } catch (error) {
      console.error(chain, 'FAILED', String(error).slice(0, 300));
      continue;
    }
    // Registry lookups for every destination and funder: heuristic 6.1 of Kovács and Seres.
    const known = new Map<string, boolean>();
    for (const r of rows) for (const a of [r.dest, r.funder]) if (a && a.startsWith('0x') && !known.has(a)) known.set(a, await c.registrant(a));
    const lines: string[] = [];
    for (const r of rows) {
      r.destRegistrant = r.dest ? known.get(r.dest) ?? false : null;
      r.funderRegistrant = r.funder?.startsWith('0x') ? known.get(r.funder) ?? false : null;
      lines.push(JSON.stringify({ ...r, head, source: new URL(c.url).host }));
    }
    console.log(chain, rows.length, rows.map(r => r.route).join(','));
    writeFileSync(`${OUT}usage-${chain}.jsonl`, `${lines.join('\n')}\n`);
  }
}
