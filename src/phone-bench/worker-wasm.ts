// worker-wasm.js: the scan with libsecp256k1 compiled to WASM (tiny-secp256k1, as in src/shared/engines.ts).
import { keccak_256 } from '@noble/hashes/sha3';
import { pointAddScalar, pointMultiply } from 'tiny-secp256k1';
import { unpack, type PackedFixture } from './scan.ts';

interface Job { fixture: PackedFixture; count: number; chunk: number }
const post = (message: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(message);
const bytes = (hex: string) => Uint8Array.from(hex.slice(2).match(/../g)!, h => parseInt(h, 16));
post({ type: 'hello' });

self.onmessage = (event: MessageEvent<Job>) => {
  const { fixture, count, chunk } = event.data;
  try {
    // Counts above the fixture repeat it in passes, so fast engines can run for several seconds.
    const passes = Math.ceil(count / fixture.count);
    const announcements = unpack(fixture, Math.min(count, fixture.count));
    const viewing = bytes(fixture.recipient.viewingPrivateKey), spending = bytes(fixture.recipient.spendingPublicKey);
    const matches: number[] = [];
    let scanMs = 0;
    for (let start = 0; start < count; start += chunk) {
      const t = performance.now();
      for (let i = start; i < Math.min(start + chunk, count); i++) {
        const a = announcements[i % announcements.length]!;
        const shared = pointMultiply(bytes(a.ephemeralPubKey), viewing, true);
        if (!shared) continue;
        const hashed = keccak_256(shared);
        if (hashed[0] !== parseInt(a.metadata.slice(2, 4), 16)) continue;
        const stealth = pointAddScalar(spending, hashed, false);
        if (!stealth) continue;
        const address = keccak_256(stealth.subarray(1)).subarray(12);
        const announced = bytes(a.stealthAddress);
        if (address.every((b, k) => b === announced[k])) matches.push(i);
      }
      scanMs += performance.now() - t;
      post({ type: 'progress', done: Math.min(start + chunk, count) });
    }
    const expected = Array.from({ length: passes }, (_, p) => fixture.expectedIndices.map(i => i + p * fixture.count)).flat().filter(i => i < count);
    post({ type: 'done', scanMs, matches: matches.length, expected: expected.length, verified: matches.length === expected.length && matches.every((m, k) => m === expected[k]) });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
