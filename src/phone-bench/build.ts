// `bun run phone-bench:build`: writes work/phone-bench/index.html, one self-contained page with the scan
// bundle and a packed 10,000-announcement seeded fixture inlined. No external requests.
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { hexToBytes } from 'viem';
import { generateFixture, loadFixture } from '../shared/fixtures.ts';
import type { PackedFixture } from './scan.ts';

export const PHONE_SEED = 'phone-bench:v1';
export const PHONE_COUNT = 10_000;
export const PHONE_MATCH_EVERY = 1_000;
export const PAGE_VERSION = '3';
/** SHA256 of the packed rows of the 10,000-announcement fixture; the record script accepts only this fixture. */
export const PHONE_PACKED_SHA256 = '59eed706f08063ec731f66f6868376f1bef809c5fcb98151850a11badd00720d';
const ROOT = new URL('../../', import.meta.url).pathname;

export async function packedFixture(dir: string, count = PHONE_COUNT, matchEvery = PHONE_MATCH_EVERY): Promise<PackedFixture> {
  await generateFixture(dir, { seed: PHONE_SEED, count, matchEvery });
  return packFrom(dir);
}

/** Packs an existing generated fixture directory. */
export async function packFrom(dir: string): Promise<PackedFixture> {
  const { manifest, announcements } = await loadFixture(dir);
  const { count, matchEvery } = manifest;
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
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --line: #d1d9e0; --accent: #2a78d6; --ok: #1a7f37; --bad: #cf222e; }
@media (prefers-color-scheme: dark) { :root { --fg: #f0f6fc; --muted: #9198a1; --bg: #0d1117; --line: #2f353d; --accent: #3987e5; --ok: #3fb950; --bad: #f85149; } }
body { font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 640px; padding: 16px; }
h1 { font-size: 22px; margin: 0 0 4px; }
label { display: block; margin: 10px 0 4px; color: var(--muted); font-size: 14px; }
input, select, button, textarea { font: inherit; width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
button { margin-top: 12px; font-weight: 600; }
button#run { background: var(--accent); color: #fff; border-color: var(--accent); font-size: 18px; }
button:disabled { opacity: 0.45; }
textarea { height: 14em; font: 12px ui-monospace, Menlo, monospace; }
.muted { color: var(--muted); font-size: 14px; }
.row { display: flex; gap: 8px; } .row > * { flex: 1; }
#statusbar { position: sticky; top: 0; background: var(--bg); padding: 10px 0; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; font-weight: 600; z-index: 1; }
#dot { width: 14px; height: 14px; border-radius: 50%; background: var(--muted); flex: none; }
body[data-state="running"] #dot { background: var(--accent); animation: pulse 0.9s ease-in-out infinite; }
body[data-state="done"] #dot { background: var(--ok); } body[data-state="error"] #dot { background: var(--bad); }
body[data-state="error"] #message { color: var(--bad); font-weight: 600; }
@keyframes pulse { 0%, 100% { transform: scale(0.7); opacity: 0.5; } 50% { transform: scale(1.15); opacity: 1; } }
#spinner { width: 18px; height: 18px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; vertical-align: middle; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }
progress { width: 100%; height: 18px; }
#big { font-size: 32px; font-weight: 700; margin: 8px 0 0; }
.ok { color: var(--ok); font-weight: 600; } .bad { color: var(--bad); font-weight: 600; }
details { margin-top: 12px; }`;

export function html(fixture: PackedFixture, bundle: string, workerBundle: string): string {
  const esc = (s: string) => s.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src blob:; child-src blob:; connect-src 'none'; img-src 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan bench</title><style>${STYLE}</style></head><body data-state="idle">
<h1>ERC-5564 scan bench</h1>
<p class="muted">Scans a seeded test fixture on this device and checks the result. Nothing leaves the device unless you submit, copy or download it. Test keys only; never fund them.</p>
<div id="statusbar" role="status" aria-live="polite"><span id="dot"></span><span id="state">Loading</span></div>
<p id="message" class="muted">If this stays on Loading, the page failed to start: please report your browser.</p>
<div id="progress-box" hidden>
<p><span id="spinner"></span><span id="count-done"></span> · <span id="elapsed"></span></p>
<progress id="bar" value="0" max="1"></progress>
</div>
<div id="result-box" hidden>
<p id="big"></p><p id="verdict"></p>
</div>
<div class="row"><button id="run">Run</button><button id="cancel" hidden>Cancel</button></div>
<label for="device">Device model (detected; correct it if wrong)</label><input id="device" autocomplete="off">
<p id="candidates" class="muted"></p>
<div class="row"><div><label for="os">OS</label><input id="os" autocomplete="off"></div><div><label for="browser">Browser</label><input id="browser" autocomplete="off"></div></div>
<label for="jit">JavaScript JIT</label><select id="jit"><option value="on">On (normal)</option><option value="off-lockdown">Off: iOS Lockdown Mode</option><option value="off-other">Off: other</option><option value="unknown">Unknown</option></select>
<p id="jit-reason" class="muted"></p>
<div class="row"><div><label for="engine">Engine</label><select id="engine"><option value="crypto">crypto</option><option value="sdk">sdk (250 per call)</option></select></div>
<div><label for="count">Announcements</label><select id="count"><option value="1000">1,000</option><option value="5000">5,000</option><option value="10000">10,000</option></select></div></div>
<label for="notes">Notes (optional: charging, low power mode, temperature)</label><input id="notes" autocomplete="off">
<div id="share">
<button id="submit" disabled>Submit result (opens a GitHub issue)</button>
<p class="muted">Submitting needs a GitHub account. The issue form asks whether to credit your handle.</p>
<div class="row"><button id="copy">Copy</button><button id="download">Download</button></div>
<p id="shared" class="muted"></p>
<label for="result">Result JSON</label><textarea id="result" readonly></textarea>
</div>
<details><summary class="muted">What this page reads</summary><p class="muted" id="signals"></p></details>
<script>const FIXTURE = ${JSON.stringify(fixture)}; const PAGE_VERSION = ${JSON.stringify(PAGE_VERSION)}; const WORKER_SOURCE = ${esc(JSON.stringify(workerBundle))};</script>
<script>${esc(bundle)}</script>
</body></html>
`;
}

async function bundle(entry: string): Promise<string> {
  const build = await Bun.build({ entrypoints: [`${ROOT}src/phone-bench/${entry}`], target: 'browser', format: 'iife', minify: true });
  const [artifact] = build.outputs;
  if (!build.success || !artifact) throw new Error(build.logs.join('\n'));
  return artifact.text();
}

if (import.meta.main) {
  const out = (Bun.argv[2] ?? `${ROOT}work/phone-bench`).replace(/\/?$/, '/');
  const fixtureDir = `${ROOT}work/phone-bench/fixture`;
  await mkdir(out, { recursive: true });
  // Reuse a fixture generated earlier; the packed digest below proves it is the pinned one.
  let fixture: PackedFixture;
  try { fixture = await packFrom(fixtureDir); } catch {
    await rm(fixtureDir, { recursive: true, force: true });
    await mkdir(`${ROOT}work/phone-bench`, { recursive: true });
    fixture = await packedFixture(fixtureDir);
  }
  if (fixture.packedSha256 !== PHONE_PACKED_SHA256) throw new Error(`packed fixture ${fixture.packedSha256} differs from the pinned ${PHONE_PACKED_SHA256}`);
  const page = html(fixture, await bundle('page.ts'), await bundle('worker.ts'));
  await writeFile(`${out}index.html`, page);
  console.log(`wrote ${out}index.html (${(page.length / 1024).toFixed(0)} kB), packed ${fixture.packedSha256}`);
}
