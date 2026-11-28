// Device bench scan core, shared by the page's Web Worker, its main-thread fallback, the CLI and tests.
import { checkStealthAddress, getAnnouncementsForUser, getViewTagFromMetadata, type AnnouncementLog } from '@scopelift/stealth-address-sdk';
import type { Hex } from 'viem';

export interface PackedFixture {
  seed: string;
  count: number;
  matchEvery: number;
  fixtureSha256: string;
  packedSha256: string;
  recipient: { spendingPublicKey: Hex; viewingPrivateKey: Hex };
  expectedIndices: number[];
  /** Per announcement: 33-byte ephemeral key, 20-byte stealth address, 57-byte metadata; base64. */
  rows: string;
}

const ROW = 33 + 20 + 57;
const ANNOUNCER = '0x55649e01b5df198d18d95b5cc5051630cfD45564';
const toHex = (bytes: Uint8Array) => `0x${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}` as Hex;

export function unpack(fixture: PackedFixture, count: number): AnnouncementLog[] {
  const raw = Uint8Array.from(atob(fixture.rows), c => c.charCodeAt(0));
  if (raw.length !== fixture.count * ROW) throw new Error('packed fixture has the wrong length');
  const out: AnnouncementLog[] = [];
  for (let i = 0; i < count; i++) {
    const row = raw.subarray(i * ROW, (i + 1) * ROW);
    const id = `0x${i.toString(16).padStart(64, '0')}` as Hex;
    out.push({
      address: ANNOUNCER, blockHash: id, blockNumber: BigInt(20_000_000 + Math.floor(i / 128)), data: '0x', logIndex: i % 128,
      removed: false, topics: [], transactionHash: id, transactionIndex: i % 128,
      caller: '0x0000000000000000000000000000000000000001', schemeId: 1n,
      ephemeralPubKey: toHex(row.subarray(0, 33)), stealthAddress: toHex(row.subarray(33, 53)), metadata: toHex(row.subarray(53)),
    } as AnnouncementLog);
  }
  return out;
}

type Recipient = PackedFixture['recipient'];
/**
 * Scan engines available in a browser. Each scans announcements[start, end) and returns matching indices.
 * Hook: the WASM engine from the fast-scan-engines branch registers here once it merges.
 */
export const ENGINES: Record<string, (a: AnnouncementLog[], r: Recipient, start: number, end: number) => Promise<number[]>> = {
  crypto: async (a, r, start, end) => {
    const hits: number[] = [];
    for (let i = start; i < end; i++) {
      const x = a[i]!;
      if (checkStealthAddress({
        ephemeralPublicKey: x.ephemeralPubKey, schemeId: 1, spendingPublicKey: r.spendingPublicKey,
        userStealthAddress: x.stealthAddress, viewingPrivateKey: r.viewingPrivateKey, viewTag: getViewTagFromMetadata(x.metadata),
      })) hits.push(i);
    }
    return hits;
  },
  sdk: async (a, r, start, end) => {
    const found = await getAnnouncementsForUser({ announcements: a.slice(start, end), ...r });
    return found.map(x => Number(BigInt(x.transactionHash!)));
  },
};

export async function runScan(fixture: PackedFixture, engine: string, count: number, chunk: number,
  progress: (done: number) => void = () => {}, cancelled: () => boolean = () => false): Promise<{ scanMs: number; matches: number[]; expected: number[]; verified: boolean }> {
  const announcements = unpack(fixture, count);
  const scan = ENGINES[engine];
  if (!scan) throw new Error(`unknown engine ${engine}`);
  const recipient = fixture.recipient;
  const matches: number[] = [];
  let scanMs = 0;
  for (let start = 0; start < count; start += chunk) {
    if (cancelled()) throw new Error('cancelled');
    const t = performance.now();
    matches.push(...await scan(announcements, recipient, start, Math.min(start + chunk, count)));
    scanMs += performance.now() - t;
    progress(Math.min(start + chunk, count));
    // Yield so the page repaints and the browser does not treat the tab as hung.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const expected = fixture.expectedIndices.filter(i => i < count);
  const verified = matches.length === expected.length && matches.every((m, i) => m === expected[i]);
  return { scanMs, matches, expected, verified };
}

