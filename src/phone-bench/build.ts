// `bun run phone-bench:build`: writes work/phone-bench/index.html, one self-contained page with the scan
// bundle and a packed 10,000-announcement seeded fixture inlined. No external requests.
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { hexToBytes } from 'viem';
import { generateFixture, loadFixture } from '../shared/fixtures.ts';
import type { PackedFixture } from './page.ts';

export const PHONE_SEED = 'phone-bench:v1';
export const PHONE_COUNT = 10_000;
export const PHONE_MATCH_EVERY = 1_000;
export const PAGE_VERSION = '1';
/** SHA256 of the packed rows of the 10,000-announcement fixture; the record script accepts only this fixture. */
export const PHONE_PACKED_SHA256 = '59eed706f08063ec731f66f6868376f1bef809c5fcb98151850a11badd00720d';
const ROOT = new URL('../../', import.meta.url).pathname;

export async function packedFixture(dir: string, count = PHONE_COUNT, matchEvery = PHONE_MATCH_EVERY): Promise<PackedFixture> {
  await generateFixture(dir, { seed: PHONE_SEED, count, matchEvery });
  const { manifest, announcements } = await loadFixture(dir);
  const rows = new Uint8Array(count * 110);
  announcements.forEach((a, i) => {
    const parts = [hexToBytes(a.ephemeralPubKey), hexToBytes(a.stealthAddress), hexToBytes(a.metadata)];
    if (parts[0]!.length !== 33 || parts[1]!.length !== 20 || parts[2]!.length !== 57) throw new Error(`row ${i} has unexpected field sizes`);
    rows.set(parts[0]!, i * 110);
    rows.set(parts[1]!, i * 110 + 33);
    rows.set(parts[2]!, i * 110 + 53);
  });
  return {
    seed: PHONE_SEED, count, matchEvery, fixtureSha256: manifest.fixtureSha256,
    packedSha256: createHash('sha256').update(rows).digest('hex'),
    recipient: manifest.recipient as PackedFixture['recipient'], expectedIndices: manifest.expectedIndices,
    rows: Buffer.from(rows).toString('base64'),
  };
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --line: #d1d9e0; }
@media (prefers-color-scheme: dark) { :root { --fg: #f0f6fc; --muted: #9198a1; --bg: #0d1117; --line: #2f353d; } }
body { font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 640px; padding: 16px; }
label { display: block; margin: 10px 0 4px; color: var(--muted); font-size: 14px; }
input, select, button, textarea { font: inherit; width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
button { margin-top: 14px; font-weight: 600; }
textarea { height: 18em; font: 13px ui-monospace, Menlo, monospace; }
#summary { font: 14px ui-monospace, Menlo, monospace; user-select: all; -webkit-user-select: all; }
.muted { color: var(--muted); font-size: 14px; }`;

export function html(fixture: PackedFixture, bundle: string): string {
  const esc = (s: string) => s.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan bench</title><style>${STYLE}</style></head><body>
<h1>ERC-5564 scan bench</h1>
<p class="muted">Scans a seeded test fixture in this browser and checks the result. Nothing is sent anywhere. Test keys only; never fund them.</p>
<label for="device">Device model (the user agent does not say)</label><input id="device" placeholder="e.g. iPhone 15 Pro" autocomplete="off">
<label for="engine">Engine</label><select id="engine"><option value="crypto">crypto (checkStealthAddress)</option><option value="sdk">sdk (getAnnouncementsForUser, 250 per call)</option></select>
<label for="count">Announcements</label><select id="count"><option value="1000">1,000 (default)</option><option value="5000">5,000</option><option value="10000">10,000</option></select>
<label for="jit">JavaScript JIT</label><select id="jit"><option value="on">On (normal)</option><option value="off-lockdown">Off: iOS Lockdown Mode</option><option value="off-other">Off: other</option><option value="unknown">Unknown</option></select>
<label for="notes">Notes (optional: battery saver, charging, temperature)</label><input id="notes" autocomplete="off">
<button id="run">Run</button>
<p id="status" class="muted" aria-live="polite">Ready. Keep this tab in front while it runs.</p>
<p id="summary"></p>
<label for="result">Result JSON</label><textarea id="result" readonly></textarea>
<button id="copy" hidden>Copy result</button><p id="copied" class="muted"></p>
<p class="muted">User agent: <span id="ua"></span><br>Logical cores: <span id="cores"></span></p>
<script>const FIXTURE = ${JSON.stringify(fixture)}; const PAGE_VERSION = ${JSON.stringify(PAGE_VERSION)};</script>
<script>${esc(bundle)}</script>
</body></html>
`;
}

if (import.meta.main) {
  const out = `${ROOT}work/phone-bench/`;
  await mkdir(out, { recursive: true });
  await rm(`${out}fixture`, { recursive: true, force: true });
  const fixture = await packedFixture(`${out}fixture`);
  if (fixture.packedSha256 !== PHONE_PACKED_SHA256) throw new Error(`packed fixture ${fixture.packedSha256} differs from the pinned ${PHONE_PACKED_SHA256}`);
  const build = await Bun.build({ entrypoints: [`${ROOT}src/phone-bench/page.ts`], target: 'browser', format: 'iife', minify: true });
  const [artifact] = build.outputs;
  if (!build.success || !artifact) throw new Error(build.logs.join('\n'));
  const page = html(fixture, await artifact.text());
  await writeFile(`${out}index.html`, page);
  console.log(`wrote work/phone-bench/index.html (${(page.length / 1024).toFixed(0)} kB), fixture ${fixture.fixtureSha256}, packed ${fixture.packedSha256}`);
}
