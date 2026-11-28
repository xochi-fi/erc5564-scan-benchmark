// Phone bench app, loaded as app.js after the static page has painted. The fixture (fixture.js) and the
// worker (worker.js) load only when the user taps Run, each as a visible step with a timeout. If the worker
// cannot start, the scan runs on the page in small steps.
import { detectApp, iphoneCandidates, jitGuess, parseUserAgent } from './detect.ts';
import { runScan, type PackedFixture } from './scan.ts';

declare const PAGE_VERSION: string;
export const REPO = 'xochi-fi/erc5564-scan-benchmark';
const CHUNK = 250;
const FALLBACK_CHUNK = 10;
const FIXTURE_TIMEOUT_MS = 60_000;
const WORKER_TIMEOUT_MS = 8_000;

type State = 'idle' | 'running' | 'done' | 'error';
type Boot = { step(name: string): void; fail(message: string): void; ready(): void };
const boot = (window as unknown as { phoneBoot: Boot }).phoneBoot;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const show = (id: string, on: boolean) => { $(id).hidden = !on; };

function setState(state: State, message = '') {
  document.body.dataset.state = state;
  $('state').textContent = { idle: 'Ready', running: 'Running', done: 'Done', error: 'Error' }[state];
  $('message').textContent = message;
  $<HTMLButtonElement>('run').disabled = state === 'running';
  show('cancel', state === 'running');
  show('progress-box', state === 'running');
  show('result-box', state === 'done');
}

let worker: Worker | null = null;
let cancelled = false;
let timer: ReturnType<typeof setInterval> | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let lastResult: Record<string, unknown> | null = null;
function stop() {
  worker?.terminate(); worker = null;
  if (timer) clearInterval(timer); timer = null;
  wakeLock?.release().catch(() => {}); wakeLock = null;
}
const fail = (message: string) => { stop(); setState('error', message); boot.step(`error: ${message}`); };
window.addEventListener('error', e => fail(`Page error: ${e.message}`));
window.addEventListener('unhandledrejection', e => fail(`Page error: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));

// ---- detection: user agent, client hints, screen size; every field stays editable ----
const ua = navigator.userAgent;
const parsed = parseUserAgent(ua);
const app = detectApp(ua, 'brave' in navigator);
const hasWasm = typeof WebAssembly === 'object';
const candidates = parsed.device === 'iPhone' ? iphoneCandidates(screen.width, screen.height, devicePixelRatio) : [];
const jit = jitGuess(parsed.os, hasWasm);
const detected: Record<string, unknown> = { ...parsed, app, deviceCandidates: candidates, ...jit, uaChModel: null, uaChPlatform: null, uaChPlatformVersion: null };
input('device').value = candidates.length ? `${candidates.length === 1 ? candidates[0] : candidates.join(' or ')} (guess: pick one)` : parsed.device;
input('os').value = [parsed.os, parsed.osVersion].filter(Boolean).join(' ');
input('browser').value = app ?? [parsed.browser, parsed.browserVersion].filter(Boolean).join(' ');
$<HTMLSelectElement>('jit').value = jit.jitGuess;
$('jit-reason').textContent = `Prefilled: ${jit.jitReason}.`;
$('candidates').textContent = candidates.length ? 'iPhones do not report their model; these share your screen size. Edit the field to your model.' : '';
const hints = (navigator as unknown as { userAgentData?: { getHighEntropyValues(k: string[]): Promise<Record<string, string>> } }).userAgentData;
hints?.getHighEntropyValues(['model', 'platform', 'platformVersion']).then(v => {
  detected.uaChModel = v.model || null; detected.uaChPlatform = v.platform || null; detected.uaChPlatformVersion = v.platformVersion || null;
  if (v.model) input('device').value = v.model;
}).catch(() => {});
$('signals').textContent = `${ua} · screen ${screen.width}×${screen.height} @${devicePixelRatio}x · ${navigator.hardwareConcurrency ?? '?'} cores · WebAssembly ${hasWasm ? 'yes' : 'no'}`;

// ---- loading on demand, each step visible and timed ----
let fixturePromise: Promise<PackedFixture> | null = null;
function loadFixture(): Promise<PackedFixture> {
  const w = window as unknown as { FIXTURE?: PackedFixture };
  if (w.FIXTURE) return Promise.resolve(w.FIXTURE);
  fixturePromise ??= new Promise<PackedFixture>((resolve, reject) => {
    const s = document.createElement('script');
    const t = setTimeout(() => reject(new Error(`fixture.js did not load within ${FIXTURE_TIMEOUT_MS / 1000} s`)), FIXTURE_TIMEOUT_MS);
    s.onload = () => { clearTimeout(t); w.FIXTURE ? resolve(w.FIXTURE) : reject(new Error('fixture.js loaded but defined no fixture')); };
    s.onerror = () => { clearTimeout(t); reject(new Error('fixture.js failed to load')); };
    s.src = `fixture.js?v=${PAGE_VERSION}`;
    document.head.appendChild(s);
  }).catch(e => { fixturePromise = null; throw e; });
  return fixturePromise;
}

/** Starts worker.js and waits for its hello; null when workers are missing, blocked or silent. */
function startWorker(): Promise<Worker | null> {
  return new Promise(resolve => {
    let w: Worker;
    try {
      if (typeof Worker === 'undefined') return resolve(null);
      w = new Worker(`worker.js?v=${PAGE_VERSION}`);
    } catch { return resolve(null); }
    const t = setTimeout(() => { w.terminate(); resolve(null); }, WORKER_TIMEOUT_MS);
    w.onmessage = e => { if ((e.data as { type?: string })?.type === 'hello') { clearTimeout(t); resolve(w); } };
    w.onerror = e => { e.preventDefault(); clearTimeout(t); w.terminate(); resolve(null); };
  });
}

$('run').addEventListener('click', async () => {
  const engine = $<HTMLSelectElement>('engine').value;
  const count = Number($<HTMLSelectElement>('count').value);
  cancelled = false;
  lastResult = null;
  setState('running', 'Loading the test data…');
  const bar = $<HTMLProgressElement>('bar');
  bar.max = count; bar.value = 0;
  const started = performance.now();
  const progress = (done: number) => { bar.value = done; $('count-done').textContent = `${done.toLocaleString()} of ${count.toLocaleString()} announcements`; };
  progress(0);
  $('elapsed').textContent = '0.0 s';
  timer = setInterval(() => { $('elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`; }, 100);
  try { wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { wakeLock = null; }

  let fixture: PackedFixture;
  try { boot.step('loading fixture'); fixture = await loadFixture(); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  if (cancelled) return;
  boot.step('starting worker');
  $('message').textContent = 'Starting the scan… Keep this tab open and in front until it finishes.';
  const startedAt = new Date().toISOString();

  const finish = (r: { scanMs: number; matches: number; expected: number; verified: boolean }, usedWorker: boolean, chunk: number) => {
    stop();
    const ms = r.scanMs / count;
    lastResult = {
      kind: 'phone-bench', pageVersion: PAGE_VERSION, startedAt,
      device: input('device').value.trim(), os: input('os').value.trim(), browser: input('browser').value.trim(),
      jit: $<HTMLSelectElement>('jit').value, notes: input('notes').value.trim() || null,
      detected, userAgent: ua, screen: { width: screen.width, height: screen.height, devicePixelRatio },
      hardwareConcurrency: navigator.hardwareConcurrency ?? null, webAssembly: hasWasm, secureContext: window.isSecureContext, worker: usedWorker,
      engine, count, chunk, seed: fixture.seed, fixtureSha256: fixture.fixtureSha256, packedSha256: fixture.packedSha256,
      scanMs: Number(r.scanMs.toFixed(1)), msPerAnnouncement: Number(ms.toFixed(4)),
      matches: r.matches, expectedMatches: r.expected, verified: r.verified,
    };
    $('big').textContent = `${ms.toFixed(2)} ms per announcement`;
    $('verdict').textContent = r.verified ? 'Oracle check passed' : 'ORACLE CHECK FAILED: this result is invalid';
    $('verdict').className = r.verified ? 'ok' : 'bad';
    $<HTMLTextAreaElement>('result').value = JSON.stringify(lastResult, null, 2);
    setState('done', r.verified ? 'Submit, copy or download the result below.' : 'Do not submit this result.');
    $<HTMLButtonElement>('submit').disabled = !r.verified;
    boot.step(`done (${usedWorker ? 'worker' : 'main thread'})`);
  };

  worker = await startWorker();
  if (cancelled) { stop(); return; }
  if (worker) {
    boot.step('scanning (worker)');
    $('message').textContent = 'Scanning. Keep this tab open and in front until it finishes.';
    worker.onmessage = (e: MessageEvent<{ type: string; done?: number; message?: string; scanMs: number; matches: number; expected: number; verified: boolean }>) => {
      if (e.data.type === 'progress') progress(e.data.done!);
      else if (e.data.type === 'done') finish(e.data, true, CHUNK);
      else if (e.data.type === 'error') fail(`Scan error: ${e.data.message}`);
    };
    worker.onerror = e => { e.preventDefault(); fail(`Worker error: ${e.message || 'unknown'}`); };
    worker.postMessage({ fixture, engine, count, chunk: CHUNK });
  } else {
    boot.step('scanning (main thread)');
    $('message').textContent = 'This browser did not start a Web Worker, so the scan runs on the page in small steps. Keep this tab open.';
    try {
      const r = await runScan(fixture, engine, count, FALLBACK_CHUNK, progress, () => cancelled);
      finish({ scanMs: r.scanMs, matches: r.matches.length, expected: r.expected.length, verified: r.verified }, false, FALLBACK_CHUNK);
    } catch (error) {
      if (!cancelled) fail(`Scan error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});
$('cancel').addEventListener('click', () => { cancelled = true; stop(); setState('idle', 'Cancelled.'); boot.step('cancelled'); });

// ---- sharing: nothing leaves the device unless the user clicks one of these ----
const json = () => $<HTMLTextAreaElement>('result').value;
$('submit').addEventListener('click', () => {
  if (!lastResult) return;
  const url = `https://github.com/${REPO}/issues/new?template=phone-bench.yml&title=${encodeURIComponent(`Phone bench: ${String(lastResult.device)}`)}&result=${encodeURIComponent(json())}`;
  window.open(url, '_blank', 'noopener');
});
$('copy').addEventListener('click', async () => {
  const box = $<HTMLTextAreaElement>('result');
  box.focus(); box.select();
  try { await navigator.clipboard.writeText(json()); $('shared').textContent = 'Copied.'; }
  catch { try { document.execCommand('copy'); $('shared').textContent = 'Copied.'; } catch { $('shared').textContent = 'Selected: copy it by hand.'; } }
});
$('download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
  a.download = `phone-bench-${Date.now()}.json`;
  a.click();
});

(window as unknown as { phoneBench: unknown }).phoneBench = { result: () => lastResult, state: () => document.body.dataset.state };
setState('idle', 'Tap Run. Keep this tab open while it runs; the default run takes seconds on a recent phone.');
boot.ready();
