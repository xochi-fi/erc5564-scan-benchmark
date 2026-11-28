// Phone bench page. The scan runs in a Web Worker (a chunked main-thread loop if workers are unavailable),
// so the page stays responsive. No network requests, storage or telemetry; the CSP blocks them. A result
// leaves the device only when the user submits, copies or downloads it.
import { iphoneCandidates, jitGuess, parseUserAgent } from './detect.ts';
import { runScan, type PackedFixture } from './scan.ts';

declare const FIXTURE: PackedFixture;
declare const PAGE_VERSION: string;
declare const WORKER_SOURCE: string;
export const REPO = 'xochi-fi/erc5564-scan-benchmark';
const CHUNK = 250;

type State = 'idle' | 'running' | 'done' | 'error';

if (typeof document !== 'undefined') {
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

  // ---- running state ----
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
  const fail = (message: string) => { stop(); setState('error', message); };
  window.addEventListener('error', e => fail(`Page error: ${e.message}`));
  window.addEventListener('unhandledrejection', e => fail(`Page error: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));

  // ---- detection: user agent, client hints, screen size; every field stays editable ----
  const ua = navigator.userAgent;
  const parsed = parseUserAgent(ua);
  const hasWasm = typeof WebAssembly === 'object';
  const candidates = parsed.device === 'iPhone' ? iphoneCandidates(screen.width, screen.height, devicePixelRatio) : [];
  const jit = jitGuess(parsed.os, hasWasm);
  const detected: Record<string, unknown> = { ...parsed, deviceCandidates: candidates, ...jit, uaChModel: null, uaChPlatform: null, uaChPlatformVersion: null };
  input('device').value = candidates.length ? `${candidates[0]!.split(',')[0]} (guess)` : parsed.device;
  input('os').value = [parsed.os, parsed.osVersion].filter(Boolean).join(' ');
  input('browser').value = [parsed.browser, parsed.browserVersion].filter(Boolean).join(' ');
  $<HTMLSelectElement>('jit').value = jit.jitGuess;
  $('jit-reason').textContent = `Prefilled: ${jit.jitReason}.`;
  $('candidates').textContent = candidates.length ? `Models with this screen: ${candidates.join('; ')}. Correct the field if it is wrong.` : '';
  const hints = (navigator as unknown as { userAgentData?: { getHighEntropyValues(k: string[]): Promise<Record<string, string>> } }).userAgentData;
  hints?.getHighEntropyValues(['model', 'platform', 'platformVersion']).then(v => {
    detected.uaChModel = v.model || null; detected.uaChPlatform = v.platform || null; detected.uaChPlatformVersion = v.platformVersion || null;
    if (v.model) input('device').value = v.model;
  }).catch(() => {});
  $('signals').textContent = `${ua} · screen ${screen.width}×${screen.height} @${devicePixelRatio}x · ${navigator.hardwareConcurrency ?? '?'} cores · WebAssembly ${hasWasm ? 'yes' : 'no'}`;

  function makeWorker(): Worker | null {
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
      return new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
    } catch { return null; }
  }

  $('run').addEventListener('click', async () => {
    const engine = $<HTMLSelectElement>('engine').value;
    const count = Number($<HTMLSelectElement>('count').value);
    cancelled = false;
    lastResult = null;
    setState('running', 'Keep this tab open and in front until it finishes.');
    const bar = $<HTMLProgressElement>('bar');
    bar.max = count; bar.value = 0;
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const progress = (done: number) => { bar.value = done; $('count-done').textContent = `${done.toLocaleString()} of ${count.toLocaleString()} announcements`; };
    progress(0);
    $('elapsed').textContent = '0.0 s';
    timer = setInterval(() => { $('elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`; }, 100);
    try { wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { wakeLock = null; }

    const finish = (r: { scanMs: number; matches: number; expected: number; verified: boolean }, usedWorker: boolean) => {
      stop();
      const ms = r.scanMs / count;
      lastResult = {
        kind: 'phone-bench', pageVersion: PAGE_VERSION, startedAt,
        device: input('device').value.trim(), os: input('os').value.trim(), browser: input('browser').value.trim(),
        jit: $<HTMLSelectElement>('jit').value, notes: input('notes').value.trim() || null,
        detected, userAgent: ua, screen: { width: screen.width, height: screen.height, devicePixelRatio },
        hardwareConcurrency: navigator.hardwareConcurrency ?? null, webAssembly: hasWasm, secureContext: window.isSecureContext, worker: usedWorker,
        engine, count, chunk: CHUNK, seed: FIXTURE.seed, fixtureSha256: FIXTURE.fixtureSha256, packedSha256: FIXTURE.packedSha256,
        scanMs: Number(r.scanMs.toFixed(1)), msPerAnnouncement: Number(ms.toFixed(4)),
        matches: r.matches, expectedMatches: r.expected, verified: r.verified,
      };
      $('big').textContent = `${ms.toFixed(2)} ms per announcement`;
      $('verdict').textContent = r.verified ? 'Oracle check passed' : 'ORACLE CHECK FAILED: this result is invalid';
      $('verdict').className = r.verified ? 'ok' : 'bad';
      $<HTMLTextAreaElement>('result').value = JSON.stringify(lastResult, null, 2);
      setState('done', r.verified ? 'Submit, copy or download the result below.' : 'Do not submit this result.');
      $<HTMLButtonElement>('submit').disabled = !r.verified;
    };

    worker = makeWorker();
    if (worker) {
      worker.onmessage = (e: MessageEvent<{ type: string; done?: number; message?: string; scanMs: number; matches: number; expected: number; verified: boolean }>) => {
        if (e.data.type === 'progress') progress(e.data.done!);
        else if (e.data.type === 'done') finish(e.data, true);
        else fail(`Scan error: ${e.data.message}`);
      };
      worker.onerror = e => { e.preventDefault(); fail(`Worker error: ${e.message || 'unknown'}`); };
      worker.postMessage({ fixture: FIXTURE, engine, count, chunk: CHUNK });
    } else {
      $('message').textContent = 'Web Workers are unavailable here, so the scan runs on the page in small steps. Keep this tab open.';
      try {
        const r = await runScan(FIXTURE, engine, count, CHUNK, progress, () => cancelled);
        finish({ scanMs: r.scanMs, matches: r.matches.length, expected: r.expected.length, verified: r.verified }, false);
      } catch (error) {
        if (!cancelled) fail(`Scan error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  $('cancel').addEventListener('click', () => { cancelled = true; stop(); setState('idle', 'Cancelled.'); });

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

  // Scripted runs (orca eval or Playwright) click Run and poll these.
  (window as unknown as { phoneBench: unknown }).phoneBench = { result: () => lastResult, state: () => document.body.dataset.state };
  setState('idle', 'Keep this tab open while it runs. The default run takes seconds on a recent phone.');
}
