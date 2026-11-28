// Scan engines that compute the SDK's checkStealthAddress with a different secp256k1 backend.
// Per announcement: ECDH with the viewing key (compressed point, as noble's getSharedSecret returns),
// keccak256, view-tag compare, and on a tag hit the stealth public key and address check.
import { createRequire } from 'node:module';
import type { AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { getSharedSecret, ProjectivePoint } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import * as wasm from 'tiny-secp256k1';
import type { Recipient } from './model.ts';

export const FAST_ENGINES = ['noble', 'wasm', 'native'] as const;
export type FastEngine = typeof FAST_ENGINES[number];

interface Curve {
  /** Compressed 33-byte point·scalar. */
  multiply(point: Uint8Array, scalar: Uint8Array): Uint8Array;
  /** Uncompressed 65-byte point + scalar·G. */
  addScalar(point: Uint8Array, scalar: Uint8Array): Uint8Array;
}

const noble: Curve = {
  multiply: (point, scalar) => getSharedSecret(scalar, point, true),
  addScalar: (point, scalar) => ProjectivePoint.fromHex(point).add(ProjectivePoint.fromPrivateKey(scalar)).toRawBytes(false),
};

const tiny: Curve = {
  multiply(point, scalar) {
    const result = wasm.pointMultiply(point, scalar, true);
    if (result === null) throw new Error('ECDH result is the point at infinity');
    return result;
  },
  addScalar(point, scalar) {
    const result = wasm.pointAddScalar(point, scalar, false);
    if (result === null) throw new Error('Stealth public key is the point at infinity');
    return result;
  },
};

interface NativeSecp256k1 {
  publicKeyTweakMul(point: Uint8Array, tweak: Uint8Array, compressed: boolean): Uint8Array;
  publicKeyTweakAdd(point: Uint8Array, tweak: Uint8Array, compressed: boolean): Uint8Array;
}
let nativeCurve: Curve | undefined;
/** Loads the libsecp256k1 N-API addon directly, never the package's elliptic fallback. */
function native(): Curve {
  if (nativeCurve === undefined) {
    const addon = createRequire(import.meta.url)('secp256k1/bindings') as NativeSecp256k1;
    nativeCurve = {
      multiply: (point, scalar) => addon.publicKeyTweakMul(point, scalar, true),
      addScalar: (point, scalar) => addon.publicKeyTweakAdd(point, scalar, false),
    };
  }
  return nativeCurve;
}

export function curveFor(engine: FastEngine): Curve {
  if (engine === 'noble') return noble;
  if (engine === 'wasm') return tiny;
  if (engine === 'native') return native();
  throw new Error(`Unsupported fast engine: ${String(engine)}`);
}

export function hexBytes(hex: string): Uint8Array {
  if (!hex.startsWith('0x') || hex.length % 2 !== 0 || !/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error(`Invalid hex: ${hex.slice(0, 12)}`);
  return Buffer.from(hex.slice(2), 'hex');
}

/** The announcement fields a scan reads. */
export type ScanInput = Pick<AnnouncementLog, 'ephemeralPubKey' | 'metadata' | 'stealthAddress' | 'schemeId'>;

/** Appends the indices in [start, end) whose announcement is for the recipient. */
export function scanRange(
  curve: Curve,
  announcements: readonly ScanInput[],
  recipient: Recipient,
  start: number,
  end: number,
  matches: number[],
): void {
  const viewingKey = hexBytes(recipient.viewingPrivateKey);
  const spendingKey = hexBytes(recipient.spendingPublicKey);
  for (let index = start; index < end; index += 1) {
    const announcement = announcements[index];
    if (announcement === undefined) throw new Error(`Missing announcement at index ${index}`);
    if (Number(announcement.schemeId) !== 1) throw new Error(`Unsupported schemeId: ${announcement.schemeId}`);
    const { metadata } = announcement;
    if (!metadata.startsWith('0x') || metadata.length < 4) throw new Error('Invalid metadata format');
    const hashed = keccak_256(curve.multiply(hexBytes(announcement.ephemeralPubKey), viewingKey));
    if (hashed[0] !== Number.parseInt(metadata.slice(2, 4), 16)) continue;
    const address = keccak_256(curve.addScalar(spendingKey, hashed).subarray(1)).subarray(12);
    const announced = hexBytes(announcement.stealthAddress);
    if (announced.length === 20 && address.every((byte, i) => byte === announced[i])) matches.push(index);
  }
}
