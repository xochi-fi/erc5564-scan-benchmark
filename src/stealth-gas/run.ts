// `bun run stealth-gas`: gas of each way a token-holding stealth address with no ETH can spend, per chain.
// Read-only and keyless: eth_estimateGas and eth_call with state overrides; signatures come from a public,
// unfunded test key. Nothing is sent. Writes data/stealth-gas/<chain>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  concat, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, hashDomain, keccak256, pad, parseAbi, serializeTransaction, toHex, type Hex,
} from 'viem';
import { privateKeyToAccount, sign, signAuthorization } from 'viem/accounts';
import { PoliteHttp } from '../chain-volume/http.ts';
import { SPAM_CHAINS } from '../spam-cost/run.ts';

const OUT = new URL('../../data/stealth-gas/', import.meta.url).pathname;
const http = new PoliteHttp({ minIntervalMs: 275 });

// Test material only (METHODS.md "Test keys"). Never fund these.
export const STEALTH_KEY = keccak256(toHex('erc5564-scan-benchmark stealth-gas test key'));
export const STEALTH = privateKeyToAccount(STEALTH_KEY).address;
export const RECIPIENT = '0x5e1f000000000000000000000000000000000001';
export const RELAYER = '0x5e1f000000000000000000000000000000000002';
export const PAYMASTER = '0x5e1f000000000000000000000000000000000003';

export const USDC: Record<string, Hex> = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  gnosis: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
};
// Same address on all seven chains (eth_getCode checked by the probe).
export const UMBRA = '0xFb2dc580Eed955B528407b4d36FfaFe3da685401';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const ENTRYPOINT_V08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
export const SIMPLE_7702 = '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9';
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';

export const AMOUNT = 100_000_000n; // 100 USDC
export const FEE = 1_000_000n;      // 1 USDC to the relayer or paymaster
// validatePaymasterUserOp that accepts everything: returns (bytes context = "", uint256 validationData = 0).
export const FAKE_PAYMASTER_CODE: Hex = '0x604060005260606000f3';

const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)', 'function transferFrom(address,address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)', 'function name() view returns (string)',
  'function version() view returns (string)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
]);
const UMBRA_ABI = parseAbi([
  'function tokenPayments(address,address) view returns (uint256)',
  'function withdrawTokenOnBehalf(address,address,address,address,uint256,uint8,bytes32,bytes32)',
]);
const MC3_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }',
  'function aggregate3(Call3[] calls) payable returns ((bool,bytes)[])']);
const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
const EP_ABI = parseAbi([`function handleOps(${OP}[] ops, address beneficiary)`, `function getUserOpHash(${OP} op) view returns (bytes32)`,
  'function balanceOf(address) view returns (uint256)']);
const ACCOUNT_ABI = parseAbi(['struct Call { address target; uint256 value; bytes data; }',
  'function execute(address target, uint256 value, bytes data)', 'function executeBatch(Call[] calls)']);

export const mapSlot = (key: Hex, slot: bigint | Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: typeof slot === 'bigint' ? 'uint256' : 'bytes32' }], [key, slot as never]));
const word = (n: bigint) => pad(toHex(n), { size: 32 });
const transfer = (to: Hex, amount: bigint) => encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] });

type Rpc = (method: string, params: unknown[]) => Promise<{ result?: any; error?: any }>;
function rpcAt(url: string): Rpc {
  return async (method, params) => {
    const res = await http.request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) return { error: { http: res.status, message: (res.networkError ?? res.text).slice(0, 200) } };
    try {
      const body = JSON.parse(res.text);
      return body.error ? { error: body.error } : { result: body.result };
    } catch { return { error: { message: `not JSON: ${res.text.slice(0, 120)}` } }; }
  };
}

/** First mapping slot in 0..20 whose override shows up through `read`. */
async function findSlot(rpc: Rpc, contract: Hex, slotKey: (slot: bigint) => Hex, read: Hex): Promise<bigint | null> {
  for (let slot = 0n; slot <= 20n; slot++) {
    const r = await rpc('eth_call', [{ to: contract, data: read }, 'latest', { [contract]: { stateDiff: { [slotKey(slot)]: word(12345n) } } }]);
    if (r.result && BigInt(r.result.slice(0, 66)) === 12345n) return slot;
  }
  return null;
}

const call = async (rpc: Rpc, to: Hex, data: Hex) => {
  const r = await rpc('eth_call', [{ to, data }, 'latest']);
  if (r.error) throw new Error(`eth_call ${to}: ${JSON.stringify(r.error)}`);
  return r.result as Hex;
};

function packOp(op: { nonce: bigint; callData: Hex; paymaster: boolean }) {
  return {
    sender: STEALTH, nonce: op.nonce, initCode: '0x' as Hex, callData: op.callData,
    accountGasLimits: concat([pad(toHex(150_000n), { size: 16 }), pad(toHex(150_000n), { size: 16 })]),
    preVerificationGas: 60_000n,
    gasFees: concat([pad(toHex(10n ** 6n), { size: 16 }), pad(toHex(10n ** 9n), { size: 16 })]),
    paymasterAndData: op.paymaster ? concat([PAYMASTER, pad(toHex(60_000n), { size: 16 }), pad(toHex(0n), { size: 16 })]) : '0x' as Hex,
    signature: '0x' as Hex,
  };
}

async function probeChain(chain: string) {
  const cfg = SPAM_CHAINS[chain]!;
  const token = USDC[chain]!;
  const attempts: unknown[] = [];
  for (const url of cfg.endpoints) {
    const rpc = rpcAt(url);
    const id = await rpc('eth_chainId', []);
    if (id.error || Number(BigInt(id.result)) !== cfg.chainId) { attempts.push({ url, chainId: id }); continue; }
    try {
      return { chain, chainId: cfg.chainId, url, measuredAt: new Date().toISOString(), ...await measure(rpc, chain, cfg.chainId, cfg.opStack, token), attempts };
    } catch (error) {
      attempts.push({ url, error: String(error).slice(0, 300) });
    }
  }
  return { chain, chainId: cfg.chainId, failed: true, attempts };
}

async function measure(rpc: Rpc, chain: string, chainId: number, opStack: boolean, token: Hex) {
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  const block = head.result.number as Hex;
  const balSlot = await findSlot(rpc, token, s => mapSlot(STEALTH, s), encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [STEALTH] }));
  const umbraSlot = await findSlot(rpc, UMBRA, s => mapSlot(token, mapSlot(STEALTH, s)), encodeFunctionData({ abi: UMBRA_ABI, functionName: 'tokenPayments', args: [STEALTH, token] }));
  const depositSlot = await findSlot(rpc, ENTRYPOINT_V08, s => mapSlot(PAYMASTER, s), encodeFunctionData({ abi: EP_ABI, functionName: 'balanceOf', args: [PAYMASTER] }));
  if (balSlot === null || umbraSlot === null || depositSlot === null) throw new Error(`slot not found: ${balSlot} ${umbraSlot} ${depositSlot}`);

  // Stealth holds 100 USDC; relayer, paymaster and Umbra already hold USDC, the recipient holds none.
  const tokenState = {
    [mapSlot(STEALTH, balSlot)]: word(AMOUNT), [mapSlot(RELAYER, balSlot)]: word(10n ** 6n),
    [mapSlot(PAYMASTER, balSlot)]: word(10n ** 6n), [mapSlot(UMBRA, balSlot)]: word(AMOUNT),
  };
  const base: Record<string, unknown> = {
    [token]: { stateDiff: tokenState },
    [STEALTH]: { balance: toHex(10n ** 18n) },
    [RELAYER]: { balance: toHex(10n ** 18n) },
  };
  const estimates: Record<string, unknown> = {};
  const txs: Record<string, { to: Hex; data: Hex; authorizationList?: any[] }> = {};
  const estimate = async (name: string, from: Hex, tx: { to: Hex; data: Hex; value?: Hex; authorizationList?: any[] }, overrides: Record<string, unknown>) => {
    const params: Record<string, unknown> = { from, to: tx.to, data: tx.data, value: tx.value ?? '0x0' };
    if (tx.authorizationList) params.authorizationList = tx.authorizationList.map(a => ({
      chainId: toHex(a.chainId), address: a.address, nonce: toHex(a.nonce), yParity: toHex(a.yParity), r: a.r, s: a.s,
    }));
    // eth_estimateGas would track the UserOperation's declared limits; simulation gives the gas a receipt shows.
    const r = await rpc('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides: overrides, calls: [params] }] }, block]);
    const c = r.result?.[0]?.calls?.[0];
    estimates[name] = r.error ? { error: r.error } : c?.status !== '0x1' ? { error: c?.error ?? c ?? r.result } : Number(BigInt(c.gasUsed));
    txs[name] = tx;
  };

  // Plain spends from the stealth address, as if it held ETH for gas.
  await estimate('ethTransfer', STEALTH, { to: RECIPIENT, data: '0x', value: '0x1' }, base);
  await estimate('erc20Transfer', STEALTH, { to: token, data: transfer(RECIPIENT, AMOUNT) }, base);

  // ERC-2612 permit, then the relayer pulls the amount and its fee (Multicall3 stands in for a relayer contract).
  const name = decodeFunctionResult({ abi: ERC20, functionName: 'name', data: await call(rpc, token, encodeFunctionData({ abi: ERC20, functionName: 'name' })) });
  const version = decodeFunctionResult({ abi: ERC20, functionName: 'version', data: await call(rpc, token, encodeFunctionData({ abi: ERC20, functionName: 'version' })) });
  const domain = { name, version, chainId: BigInt(chainId), verifyingContract: token };
  const separator = await call(rpc, token, encodeFunctionData({ abi: ERC20, functionName: 'DOMAIN_SEPARATOR' }));
  if (hashDomain({ domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } }) !== separator) throw new Error('permit domain mismatch');
  const deadline = 2n ** 48n;
  const permitSig = await privateKeyToAccount(STEALTH_KEY).signTypedData({
    domain, primaryType: 'Permit',
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    message: { owner: STEALTH, spender: MULTICALL3, value: AMOUNT, nonce: 0n, deadline },
  });
  const [r, s, v] = [`0x${permitSig.slice(2, 66)}` as Hex, `0x${permitSig.slice(66, 130)}` as Hex, Number(`0x${permitSig.slice(130)}`)];
  await estimate('permitRelay', RELAYER, {
    to: MULTICALL3, data: encodeFunctionData({ abi: MC3_ABI, functionName: 'aggregate3', args: [[
      { target: token, allowFailure: false, callData: encodeFunctionData({ abi: ERC20, functionName: 'permit', args: [STEALTH, MULTICALL3, AMOUNT, deadline, v, r, s] }) },
      { target: token, allowFailure: false, callData: encodeFunctionData({ abi: ERC20, functionName: 'transferFrom', args: [STEALTH, RECIPIENT, AMOUNT - FEE] }) },
      { target: token, allowFailure: false, callData: encodeFunctionData({ abi: ERC20, functionName: 'transferFrom', args: [STEALTH, RELAYER, FEE] }) },
    ]] }),
  }, base);

  // Umbra: the token sits in the Umbra contract; a relayer submits the stealth key's signed withdrawal.
  const inner = keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes' }],
    [BigInt(chainId), UMBRA, RECIPIENT, token, RELAYER, FEE, '0x0000000000000000000000000000000000000000', '0x']));
  const umbraSig = await sign({ hash: keccak256(concat([toHex('\x19Ethereum Signed Message:\n32'), inner])), privateKey: STEALTH_KEY });
  await estimate('umbraRelay', RELAYER, {
    to: UMBRA, data: encodeFunctionData({ abi: UMBRA_ABI, functionName: 'withdrawTokenOnBehalf', args: [STEALTH, RECIPIENT, token, RELAYER, FEE, Number(umbraSig.v), umbraSig.r, umbraSig.s] }),
  }, { ...base, [UMBRA]: { stateDiff: { [mapSlot(token, mapSlot(STEALTH, umbraSlot))]: word(AMOUNT) } } });

  // EIP-7702 delegation to Simple7702Account, a UserOperation through EntryPoint v0.8, gas paid by a paymaster.
  const paymasterState = {
    [PAYMASTER]: { code: FAKE_PAYMASTER_CODE },
    [ENTRYPOINT_V08]: { stateDiff: { [mapSlot(PAYMASTER, depositSlot)]: word(10n ** 24n) } },
  };
  const delegated = { ...base, ...paymasterState, [STEALTH]: { balance: '0x0', code: concat(['0xef0100', SIMPLE_7702]) } };
  // A fresh stealth address holding only tokens is an empty account, so the authorization gets no refund.
  const undelegated: Record<string, unknown> = { ...base, ...paymasterState };
  delete undelegated[STEALTH];
  const auth = await signAuthorization({ address: SIMPLE_7702, chainId, nonce: 0, privateKey: STEALTH_KEY });
  const userOps = {
    aaSponsored: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'execute', args: [token, 0n, transfer(RECIPIENT, AMOUNT)] }),
    aaTokenFee: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'executeBatch', args: [[
      { target: token, value: 0n, data: transfer(RECIPIENT, AMOUNT - FEE) }, { target: token, value: 0n, data: transfer(PAYMASTER, FEE) }]] }),
  };
  for (const [key, callData] of Object.entries(userOps)) {
    const op = packOp({ nonce: 0n, callData, paymaster: true });
    const hash = await call(rpc, ENTRYPOINT_V08, encodeFunctionData({ abi: EP_ABI, functionName: 'getUserOpHash', args: [op] }));
    op.signature = await sign({ hash, privateKey: STEALTH_KEY, to: 'hex' });
    const data = encodeFunctionData({ abi: EP_ABI, functionName: 'handleOps', args: [[op], RELAYER] });
    // First spend carries the authorization; later spends find the delegation already set.
    await estimate(`${key}FirstUse`, RELAYER, { to: ENTRYPOINT_V08, data, authorizationList: [auth] }, undelegated);
    await estimate(key, RELAYER, { to: ENTRYPOINT_V08, data }, delegated);
  }

  // OP Stack: L1 data fee in wei of the signed transaction (dummy signature). Arbitrum: L1 gas units, priced at the L2 base fee.
  let l1: Record<string, unknown> | null = null;
  if (opStack || chain === 'arbitrum') {
    l1 = {};
    for (const [key, tx] of Object.entries(txs)) {
      const gas = estimates[key];
      if (typeof gas !== 'number') continue;
      let r;
      if (opStack) {
        const serialized = serializeTransaction({
          type: tx.authorizationList ? 'eip7702' : 'eip1559', chainId, nonce: 1000, to: tx.to, data: tx.data, gas: BigInt(gas),
          maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 6n, ...(tx.authorizationList ? { authorizationList: tx.authorizationList } : {}),
        } as never, { r: `0x${'ab'.repeat(32)}`, s: `0x${'cd'.repeat(32)}`, yParity: 1 });
        r = await rpc('eth_call', [{ to: GAS_ORACLE, data: encodeFunctionData({ abi: parseAbi(['function getL1Fee(bytes) view returns (uint256)']), functionName: 'getL1Fee', args: [serialized] }) }, block]);
      } else {
        r = await rpc('eth_call', [{ to: NODE_INTERFACE, data: encodeFunctionData({ abi: parseAbi(['function gasEstimateL1Component(address,bool,bytes) payable returns (uint64,uint256,uint256)']), functionName: 'gasEstimateL1Component', args: [tx.to, false, tx.data] }) }, block]);
      }
      l1[key] = r.error ? { error: r.error } : Number(BigInt(r.result.slice(0, 66)));
    }
  }
  return { block: Number(BigInt(block)), token, tokenName: name, slots: { balance: Number(balSlot), umbra: Number(umbraSlot), deposit: Number(depositSlot) }, gasUsed: estimates, l1: l1 && { unit: opStack ? 'wei' : 'gas', ...l1 } };
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
  for (const chain of only.length ? only : Object.keys(SPAM_CHAINS)) {
    const record = await probeChain(chain);
    writeFileSync(`${OUT}${chain}.json`, `${JSON.stringify(record, null, 1)}\n`);
    console.log(chain, 'failed' in record ? `FAILED ${JSON.stringify(record.attempts).slice(0, 400)}` : JSON.stringify(record.gasUsed));
  }
}
