// `bun run seed-recovery:derive`: offline. One public test mnemonic through each deployed key derivation,
// per chain, per ECDSA library and per signature variant. Writes data/seed-recovery/derive.json; the test recomputes it.
import { createRequire } from 'node:module';
import { createHash, webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 as curves } from '@noble/curves/secp256k1';
import * as noble from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import * as tiny from 'tiny-secp256k1';
import { checkStealthAddress, generateKeysFromSignature, generateStealthAddress, getViewTagFromMetadata } from '@scopelift/stealth-address-sdk';
import { bytesToHex, hashMessage, hexToBytes, keccak256, toHex, type Hex } from 'viem';
import { HDKey, mnemonicToAccount } from 'viem/accounts';

noble.etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, noble.etc.concatBytes(...msgs));
const native = createRequire(import.meta.url)('secp256k1/bindings') as {
  ecdsaSign(msg32: Uint8Array, seckey: Uint8Array): { signature: Uint8Array; recid: number };
};

/** Public test material: never fund it. */
export const MNEMONIC = entropyToMnemonic(createHash('sha256').update('erc5564-scan-benchmark seed-recovery v1').digest().subarray(0, 16), wordlist);
export const CHAIN_IDS = [1, 8453, 42161, 10, 100, 137, 11155111];
const account = (index = 0) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
const privateKey = (index = 0) => bytesToHex(account(index).getHdKey().privateKey!);

type Sig = { r: bigint; s: bigint; recovery: number };
const fromBytes = (sig: Uint8Array, recovery: number): Sig => ({ r: BigInt(bytesToHex(sig.subarray(0, 32))), s: BigInt(bytesToHex(sig.subarray(32))), recovery });
export const SIGNERS: Record<string, (hash: Hex, key: Hex) => Sig> = {
  'viem (@noble/curves)': (h, k) => curves.sign(h.slice(2), k.slice(2), { lowS: true }),
  '@noble/secp256k1': (h, k) => noble.sign(h.slice(2), k.slice(2)),
  'libsecp256k1 WASM': (h, k) => { const s = tiny.signRecoverable(hexToBytes(h), hexToBytes(k)); return fromBytes(s.signature, s.recoveryId); },
  'libsecp256k1 native': (h, k) => { const s = native.ecdsaSign(hexToBytes(h), hexToBytes(k)); return fromBytes(s.signature, s.recid); },
};
const viem = SIGNERS['viem (@noble/curves)']!;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const serialize = ({ r, s, recovery }: Sig, v = 27) => `0x${word(r)}${word(s)}${(v + recovery).toString(16).padStart(2, '0')}` as Hex;

interface Keys { spendingPrivateKey: Hex; spendingPublicKey: Hex; viewingPrivateKey: Hex; viewingPublicKey: Hex }
const pair = (spend: Uint8Array, view: Uint8Array): Keys => ({
  spendingPrivateKey: bytesToHex(spend), spendingPublicKey: bytesToHex(curves.getPublicKey(spend, true)),
  viewingPrivateKey: bytesToHex(view), viewingPublicKey: bytesToHex(curves.getPublicKey(view, true)),
});
/** Umbra.generatePrivateKeys: sha256 of r and of s. The SDK and Fluidkey's kit use keccak256. */
const umbraKeys = (sig: Hex) => pair(sha256(hexToBytes(`0x${sig.slice(2, 66)}`)), sha256(hexToBytes(`0x${sig.slice(66, 130)}`)));

/** Deployed derivations, sources in docs/seed-recovery.md. Each returns the keys for one chain. */
export const WALLETS: Record<string, (chainId: number, sign?: (h: Hex, k: Hex) => Sig) => Keys> = {
  'ScopeLift SDK example': (id, sign = viem) => generateKeysFromSignature(serialize(sign(hashMessage(`Generate Stealth Meta-Address on ${id} chain`), privateKey()))) as Keys,
  Umbra: (id, sign = viem) => {
    const base = 'Sign this message to access your Umbra account.\n\nOnly sign this message for a trusted client!';
    return umbraKeys(serialize(sign(hashMessage(id === 1 ? base : `${base}\n\nChain ID: ${id}`), privateKey())));
  },
  'Fluidkey (PIN 0000)': (_id, sign = viem) => fluidkey('0000', sign),
  'kohaku-cli (BIP-32 paths)': () => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    return pair(root.derive("m/44'/60'/0'/5564'/1'/0'").privateKey!, root.derive("m/44'/60'/0'/5564'/1'/1'").privateKey!);
  },
};
function fluidkey(pin: string, sign = viem) {
    const secret = keccak256(toHex(account().address + pin)).slice(2);
    const message = `Sign this message to generate your Fluidkey private payment keys.\n\nWARNING: Only sign this message within a trusted website or platform to avoid loss of funds.\n\nSecret: ${secret}`;
    return generateKeysFromSignature(serialize(sign(hashMessage(message), privateKey()))) as Keys;
}

const id = (k: Keys) => `${k.spendingPublicKey}:${k.viewingPublicKey}`;
function sdkKeys(sig: Hex): Keys | null {
  try { return generateKeysFromSignature(sig) as Keys; } catch { return null; }
}
/** A payment to the reference keys, found by the check a wallet runs with re-derived keys. */
function finds(reference: Keys, k: Keys) {
  const pay = generateStealthAddress({ stealthMetaAddressURI: `st:eth:0x${reference.spendingPublicKey.slice(2)}${reference.viewingPublicKey.slice(2)}`,
    schemeId: 1, ephemeralPrivateKey: hexToBytes(`0x${'11'.repeat(32)}`) });
  return checkStealthAddress({ ephemeralPublicKey: pay.ephemeralPublicKey, schemeId: 1, spendingPublicKey: k.spendingPublicKey,
    userStealthAddress: pay.stealthAddress, viewingPrivateKey: k.viewingPrivateKey, viewTag: getViewTagFromMetadata(pay.viewTag) });
}

export interface Row { wallet: string; variant: string; derivations: number; distinctKeys: number; accepted: number; findsPayment: boolean }
export async function derive(): Promise<{ mnemonicSha256: string; rows: Row[] }> {
  const rows: Row[] = [];
  const add = (wallet: string, variant: string, reference: Keys, keys: (Keys | null)[]) => {
    const ok = keys.filter((k): k is Keys => k !== null);
    rows.push({ wallet, variant, derivations: keys.length, distinctKeys: new Set(ok.map(id)).size, accepted: ok.length, findsPayment: ok.length > 0 && ok.every(k => finds(reference, k)) });
  };
  for (const [wallet, keysFor] of Object.entries(WALLETS)) {
    const reference = keysFor(1);
    if (!wallet.startsWith('kohaku')) add(wallet, 'Four ECDSA libraries, two runs each, chain 1', reference, Object.values(SIGNERS).flatMap(sign => [keysFor(1, sign), keysFor(1, sign)]));
    add(wallet, 'Seven chains', reference, CHAIN_IDS.map(c => keysFor(c)));
  }
  add('Fluidkey (PIN 0000)', 'PIN 1234', WALLETS['Fluidkey (PIN 0000)']!(1), [fluidkey('1234')]);
  const hash = hashMessage('Generate Stealth Meta-Address on 1 chain'), key = privateKey();
  const ref = viem(hash, key), reference = sdkKeys(serialize(ref))!;
  const sdk = (variant: string, sigs: Hex[]) => add('ScopeLift SDK example', variant, reference, sigs.map(sdkKeys));
  sdk('v as 0/1 instead of 27/28', [serialize(ref, 0)]);
  sdk('Same signature with high s, also valid', [serialize({ r: ref.r, s: curves.CURVE.n - ref.s, recovery: ref.recovery ^ 1 })]);
  sdk('Hedged nonce (viem setSignEntropy), two runs', [0, 1].map(() => serialize(curves.sign(hash.slice(2), key.slice(2), { lowS: true, extraEntropy: true }))));
  sdk('Second account of the seed', [serialize(viem(hash, privateKey(1)))]);
  const p256 = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  sdk('P-256 passkey signer, two runs', await Promise.all([0, 1].map(async () =>
    `${bytesToHex(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, p256.privateKey, new Uint8Array(hexToBytes(hash))))) }1b` as Hex)));
  sdk('Two-owner Safe signature, 130 bytes', [`${serialize(ref)}${serialize(ref).slice(2)}` as Hex]);
  return { mnemonicSha256: createHash('sha256').update(MNEMONIC).digest('hex'), rows };
}

if (import.meta.main) {
  const out = Bun.argv[2] ?? new URL('../../data/seed-recovery/derive.json', import.meta.url).pathname;
  const result = await derive();
  writeFileSync(out, `{"mnemonicSha256":"${result.mnemonicSha256}","rows":[\n${result.rows.map(r => JSON.stringify(r)).join(',\n')}\n]}\n`);
  for (const r of result.rows) console.log(r.distinctKeys, `${r.accepted}/${r.derivations}`, r.findsPayment, r.wallet, '|', r.variant);
}
