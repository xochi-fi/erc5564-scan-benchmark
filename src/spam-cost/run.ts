// `bun run spam-cost`: what it costs to push a chain's ERC-5564 Announcer past a daily volume.
// Read-only and keyless: eth_estimateGas (no transaction is signed or sent), eth_feeHistory, eth_call to
// fee oracles, receipts of recorded real announcements, and one public price quote. Writes
// data/spam-cost/<chain>.json and data/spam-cost/prices.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, serializeTransaction, type Hex } from 'viem';
import { PoliteHttp } from '../chain-volume/http.ts';
import { ANNOUNCER } from '../shared/announcer.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${ROOT}data/spam-cost/`;
const http = new PoliteHttp({ minIntervalMs: 275 });

// Endpoints tried in order until one answers every probe. All appear as usable in data/chain-volume/endpoints.csv.
export const SPAM_CHAINS: Record<string, { chainId: number; opStack: boolean; endpoints: string[] }> = {
  ethereum: { chainId: 1, opStack: false, endpoints: ['https://ethereum-rpc.publicnode.com', 'https://gateway.tenderly.co/public/mainnet', 'https://ethereum-mainnet.gateway.tatum.io'] },
  base: { chainId: 8453, opStack: true, endpoints: ['https://base-rpc.publicnode.com', 'https://gateway.tenderly.co/public/base', 'https://base.api.pocket.network'] },
  arbitrum: { chainId: 42161, opStack: false, endpoints: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.gateway.tenderly.co', 'https://arb-one.api.pocket.network'] },
  optimism: { chainId: 10, opStack: true, endpoints: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://gateway.tenderly.co/public/optimism'] },
  gnosis: { chainId: 100, opStack: false, endpoints: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com', 'https://gnosis.api.pocket.network'] },
  polygon: { chainId: 137, opStack: false, endpoints: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.gateway.tenderly.co', 'https://polygon-mainnet.gateway.tatum.io'] },
  sepolia: { chainId: 11155111, opStack: false, endpoints: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://gateway.tenderly.co/public/sepolia', 'https://ethereum-sepolia.gateway.tatum.io'] },
};

const ANNOUNCE_ABI = [{
  type: 'function', name: 'announce', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'schemeId', type: 'uint256' }, { name: 'stealthAddress', type: 'address' },
    { name: 'ephemeralPubKey', type: 'bytes' }, { name: 'metadata', type: 'bytes' }],
}] as const;
// Smallest announcement a scanner must process: compressed 33-byte ephemeral key, 1-byte metadata (view tag).
// Test material only; nothing here is a funded key.
export const MINIMAL_CALLDATA = encodeFunctionData({
  abi: ANNOUNCE_ABI, functionName: 'announce',
  args: [1n, '0x000000000000000000000000000000000000dEaD', `0x02${'11'.repeat(32)}`, '0x7f'],
});
const FROM = '0x000000000000000000000000000000000000bEEF';
const BATCHER = '0x00000000000000000000000000000000005a5a5a';

/** Runtime code of a contract that copies its calldata and forwards it to the Announcer `n` times. */
export function batcherCode(n: number): Hex {
  if (n < 1 || n > 0xffff) throw new Error('n out of range');
  const pushN = n.toString(16).padStart(4, '0');
  const addr = ANNOUNCER.slice(2);
  // 0: CALLDATASIZE PUSH1 0 PUSH1 0 CALLDATACOPY; 6: PUSH2 n; 9: JUMPDEST DUP1 ISZERO PUSH1 0x37 JUMPI
  // 15: PUSH1 0 PUSH1 0 CALLDATASIZE PUSH1 0 PUSH1 0 PUSH20 announcer GAS CALL POP
  // 48: PUSH1 1 SWAP1 SUB PUSH1 9 JUMP; 55: JUMPDEST STOP
  return `0x3660006000376${'1'}${pushN}5b801560375760006000366000600073${addr}5af15060019003600956${'5b00'}` as Hex;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: any; error?: any; ms: number }> {
  const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) return { error: { http: res.status, message: (res.networkError ?? res.text).slice(0, 200) }, ms: res.ms };
  try {
    const body = JSON.parse(res.text);
    return body.error ? { error: body.error, ms: res.ms } : { result: body.result, ms: res.ms };
  } catch {
    return { error: { message: `not JSON: ${res.text.slice(0, 120)}` }, ms: res.ms };
  }
}

const hexNum = (h: string) => Number(BigInt(h));

async function probeChain(chain: string) {
  const config = SPAM_CHAINS[chain]!;
  const attempts: unknown[] = [];
  for (const url of config.endpoints) {
    const chainId = await rpc(url, 'eth_chainId', []);
    if (chainId.error || hexNum(chainId.result) !== config.chainId) { attempts.push({ url, chainId }); continue; }
    const direct = await rpc(url, 'eth_estimateGas', [{ from: FROM, to: ANNOUNCER, data: MINIMAL_CALLDATA }, 'latest']);
    const batch: Record<string, unknown> = {};
    for (const n of [1, 101]) {
      batch[n] = await rpc(url, 'eth_estimateGas', [{ from: FROM, to: BATCHER, data: MINIMAL_CALLDATA }, 'latest', { [BATCHER]: { code: batcherCode(n) } }]);
    }
    const head = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
    const fees = await rpc(url, 'eth_feeHistory', ['0x400', 'latest', [10, 50]]);
    let l1: unknown = null;
    if (config.opStack && !direct.error) {
      // L1 data fee of one signed direct-call transaction (dummy signature), from the OP Stack GasPriceOracle.
      const tx = serializeTransaction({
        type: 'eip1559', chainId: config.chainId, nonce: 1000, to: ANNOUNCER, data: MINIMAL_CALLDATA,
        gas: BigInt(direct.result), maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 6n,
      }, { r: `0x${'ab'.repeat(32)}`, s: `0x${'cd'.repeat(32)}`, yParity: 1 });
      const data = encodeFunctionData({ abi: [{ type: 'function', name: 'getL1Fee', stateMutability: 'view', inputs: [{ name: '_data', type: 'bytes' }], outputs: [{ type: 'uint256' }] }], functionName: 'getL1Fee', args: [tx] });
      l1 = { signedTxBytes: (tx.length - 2) / 2, getL1Fee: await rpc(url, 'eth_call', [{ to: '0x420000000000000000000000000000000000000F', data }, 'latest']) };
    }
    const sample = await receipts(url, chain);
    const ok = !direct.error && !head.error && !fees.error;
    const record = { chain, chainId: config.chainId, url, measuredAt: new Date().toISOString(), calldata: MINIMAL_CALLDATA, direct, batch, head: head.result ? { number: hexNum(head.result.number), timestamp: hexNum(head.result.timestamp), gasLimit: hexNum(head.result.gasLimit), baseFeePerGas: head.result.baseFeePerGas } : head, fees, l1, receipts: sample, attempts };
    if (ok) return record;
    attempts.push({ url, direct, head: head.error, fees: fees.error });
  }
  return { chain, chainId: config.chainId, failed: true, attempts };
}

/** Receipts of up to 12 recorded real announcements, spread over the chain's history. */
async function receipts(url: string, chain: string) {
  const file = JSON.parse(readFileSync(`${ROOT}data/chain-volume/canonical/retrieve-${chain}-probe-informed.json`, 'utf8'));
  const ids: string[] = file.identities;
  const picks = [...new Set(Array.from({ length: Math.min(12, ids.length) }, (_, i) => ids[Math.floor(i * ids.length / Math.min(12, ids.length))]!.split(':')[2]!))];
  const out = [];
  for (const hash of picks) {
    const tx = await rpc(url, 'eth_getTransactionByHash', [hash]);
    const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash]);
    if (tx.error || receipt.error || !tx.result || !receipt.result) { out.push({ hash, error: tx.error ?? receipt.error ?? 'null' }); continue; }
    const r = receipt.result;
    out.push({
      hash, to: tx.result.to, inputBytes: (tx.result.input.length - 2) / 2, gasUsed: hexNum(r.gasUsed),
      effectiveGasPrice: r.effectiveGasPrice ? hexNum(r.effectiveGasPrice) : null, l1Fee: r.l1Fee ? hexNum(r.l1Fee) : null,
      gasUsedForL1: r.gasUsedForL1 ? hexNum(r.gasUsedForL1) : null,
      logs: r.logs.length, announcerLogs: r.logs.filter((l: any) => l.address.toLowerCase() === ANNOUNCER).length,
    });
  }
  return out;
}

async function prices() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,polygon-ecosystem-token,xdai&vs_currencies=usd&include_last_updated_at=true';
  const res = await http.request(url, { method: 'GET' });
  return { source: url, fetchedAt: new Date().toISOString(), status: res.status, body: res.ok ? JSON.parse(res.text) : res.text.slice(0, 200) };
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
  for (const chain of only.length ? only : Object.keys(SPAM_CHAINS)) {
    const record = await probeChain(chain);
    writeFileSync(`${OUT}${chain}.json`, `${JSON.stringify(record, null, 2)}\n`);
    console.log(chain, 'failed' in record ? 'FAILED' : `direct ${hexNum((record as any).direct.result)} via ${(record as any).url}`);
  }
  if (!process.argv.includes('--no-prices')) writeFileSync(`${OUT}prices.json`, `${JSON.stringify(await prices(), null, 2)}\n`);
}
