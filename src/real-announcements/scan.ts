// `bun run real-announcements:scan [--time REPS] [--out FILE]`: runs the scan engines over every real
// announcement fetched to work/real-announcements/. Classifies malformed fields, checks whether one bad entry aborts
// the SDK's getAnnouncementsForUser for the whole batch, and with --time compares per-announcement crypto
// scan time on real and on synthetic input of the same size.
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname } from 'node:os';
import { ProjectivePoint } from '@noble/secp256k1';
import { checkStealthAddress, getAnnouncementsForUser, getViewTagFromMetadata, type AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { decodeAnnouncements, type RawLog } from '../shared/raw-logs.ts';
import { loadFixture } from '../shared/fixtures.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
export const CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'gnosis', 'polygon', 'sepolia'];
// The scan-cost 100k zero-match fixture's test recipient (data/scan-cost/baseline-100k-1m/fixtures/100000-zero); nothing real matches it.
// A full-size viewing key matters: a tiny one makes the ECDH cheap and the timing meaningless.
const RECIPIENT = {
  spendingPublicKey: '0x03b790fa25d152286e031a9f45fbda836e51daaed14d2818ac4248b6e048bd9f49',
  viewingPrivateKey: '0x1244ed4b491a7d778dbd171a5efe9403d45661d3e09cbfca2fa0380b75e08f68',
} as const;

/** `other-scheme`: schemeId ≠ 1, not secp256k1 with view tags, so out of scope rather than malformed. */
export type Defect = 'decode' | 'other-scheme' | 'bad-key' | 'no-view-tag';
export function defects(raw: RawLog): { log: AnnouncementLog | null; defects: Defect[] } {
  let log: AnnouncementLog;
  try { [log] = decodeAnnouncements([raw]) as [AnnouncementLog]; } catch { return { log: null, defects: ['decode'] }; }
  if (log.schemeId !== 1n) return { log, defects: ['other-scheme'] };
  const out: Defect[] = [];
  // Scheme 1 keys are secp256k1 points, compressed (33 bytes) or uncompressed (65 bytes).
  try { ProjectivePoint.fromHex(log.ephemeralPubKey.slice(2)); } catch { out.push('bad-key'); }
  if (log.metadata.length < 4) out.push('no-view-tag');
  return { log, defects: out };
}

function cryptoScan(logs: AnnouncementLog[]): { matches: number; errors: number } {
  let matches = 0, errors = 0;
  for (const a of logs) {
    try {
      if (checkStealthAddress({ ephemeralPublicKey: a.ephemeralPubKey, schemeId: Number(a.schemeId), spendingPublicKey: RECIPIENT.spendingPublicKey,
        userStealthAddress: a.stealthAddress, viewingPrivateKey: RECIPIENT.viewingPrivateKey, viewTag: getViewTagFromMetadata(a.metadata) })) matches++;
    } catch { errors++; }
  }
  return { matches, errors };
}

async function sdkBatch(logs: AnnouncementLog[]): Promise<{ ok: boolean; matches: number | null; error: string | null }> {
  try {
    const found = await getAnnouncementsForUser({ announcements: logs, ...RECIPIENT });
    return { ok: true, matches: found.length, error: null };
  } catch (e) {
    return { ok: false, matches: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const reps = args.includes('--time') ? Number(args[args.indexOf('--time') + 1]) : 0;
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : `${ROOT}data/real-announcements/scan.json`;
  const chains = [];
  const all: AnnouncementLog[] = [];
  /** Scheme-1 entries without defects: the input the timing compares against synthetic data. */
  const clean: AnnouncementLog[] = [];
  for (const chain of CHAINS) {
    const raw: RawLog[] = JSON.parse(readFileSync(`${ROOT}work/real-announcements/${chain}.json`, 'utf8')).logs;
    const rows = raw.map(defects);
    const parsed = rows.flatMap(r => (r.log ? [r.log] : []));
    const counts: Record<string, number> = {};
    for (const r of rows) for (const d of r.defects) counts[d] = (counts[d] ?? 0) + 1;
    // Per entry: does the SDK throw on this one alone?
    const sdkThrows = [];
    for (const log of parsed) if (!(await sdkBatch([log])).ok) sdkThrows.push(`${log.blockNumber}:${log.logIndex}`);
    const keyBytes: Record<string, number> = {};
    for (const l of parsed) if (l.schemeId === 1n) { const n = (l.ephemeralPubKey.length - 2) / 2; keyBytes[n] = (keyBytes[n] ?? 0) + 1; }
    chains.push({
      chain, announcements: raw.length, parsed: parsed.length, clean: rows.filter(r => r.log && r.defects.length === 0).length, defects: counts, scheme1KeyBytes: keyBytes,
      crypto: cryptoScan(parsed), sdkWholeBatch: await sdkBatch(parsed), sdkThrowsAlone: sdkThrows,
    });
    all.push(...parsed);
    clean.push(...rows.flatMap(r => (r.log && r.defects.length === 0 ? [r.log] : [])));
  }
  const result: Record<string, unknown> = { measuredAt: new Date().toISOString(), host: hostname(), chains };
  if (reps > 0) {
    // Same count of synthetic zero-match announcements from the scan-cost fixture, interleaved with the real set.
    const synthetic = (await loadFixture(`${ROOT}work/fixtures/100000-zero`)).announcements.slice(0, clean.length);
    const time = (logs: AnnouncementLog[]) => { const t = performance.now(); cryptoScan(logs); return performance.now() - t; };
    time(clean); time(synthetic); time(all); // warm-up
    const real: number[] = [], synth: number[] = [], withDefects: number[] = [];
    for (let i = 0; i < reps; i++) { real.push(time(clean)); synth.push(time(synthetic)); withDefects.push(time(all)); }
    result.timing = { engine: 'crypto', clean: clean.length, all: all.length, reps, cpu: cpus()[0]?.model, cleanMs: real, syntheticMs: synth, allMs: withDefects };
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const c of chains) console.log(c.chain, c.announcements, 'parsed', c.parsed, 'clean', c.clean, JSON.stringify(c.defects), 'sdk', c.sdkWholeBatch.ok ? 'ok' : c.sdkWholeBatch.error, 'throwsAlone', c.sdkThrowsAlone.length, 'cryptoErrors', c.crypto.errors);
}
