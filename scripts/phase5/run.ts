import { readFile } from 'node:fs/promises';
import { control, origin, rpc, scope, type Window } from './config.ts';

const [cli, page, referencePath, output, suite = 'all'] = Bun.argv.slice(2);
if (!cli || !page || !referencePath || !output || !['all', 'live', 'fixture'].includes(suite)) {
  throw new Error('Usage: bun scripts/phase5/run.ts ORCA_CLI PAGE REFERENCE_JSON OUTPUT_DIR [all|live|fixture]');
}
const { agreed, headHash, identities, windows } = await Bun.file(referencePath).json() as {
  agreed: boolean; headHash: string; identities: string[]; windows: Window[];
};
if (!agreed || identities.length !== 48) throw new Error('Need the corroborated 48-log reference');
const reference = { headHash, identities, windows };
function evaluate(expression: string) {
  const result = Bun.spawnSync([cli!, 'eval', '--page', page!, '--expect-url', `${origin}/`, '--expression', expression, '--json']);
  if (result.exitCode !== 0) throw new Error(result.stdout.toString() || result.stderr.toString());
  try {
    return JSON.parse(result.stdout.toString()).result.result;
  } catch (error) {
    throw new Error('Invalid Orca eval output: ' + result.stdout.toString() + result.stderr.toString(), { cause: error });
  }
}
const readControlEvents = async (): Promise<{ path: string; method: string }[]> =>
  await (await fetch(`${origin}/control-events`)).json() as { path: string; method: string }[];
const priorControlEvents = (await readControlEvents()).length;
const controls = JSON.parse(evaluate(`phase5.controls(${JSON.stringify(control)}).then(JSON.stringify)`));
const controlEvents = (await readControlEvents()).slice(priorControlEvents);
const methods = (path: string) => controlEvents.filter(event => event.path === path).map(event => event.method);
if (controls[0]?.status !== 200 || controls[1]?.error?.kind !== 'fetch-rejection' ||
    !methods('/allow').includes('OPTIONS') || !methods('/allow').includes('POST') ||
    !methods('/deny').includes('OPTIONS') || methods('/deny').includes('POST')) {
  throw new Error('Normal CORS controls failed');
}
const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
await Bun.write(`${output}/run-${suite}.json`, JSON.stringify({
  suite, scope, controls, controlEvents, revision, startedAt: new Date().toISOString(),
}, null, 2));

const originalWindows = [...new Set(windows.map(({ from }) => scope.start +
  Math.floor((from - scope.start) / 2000) * 2000))].map(from => ({ from, to: from + 1999 }));
const fixture = (...routes: string[]) => routes.map(route => `${control}/fixture/${route}`);
const liveCases = [
  { name: 'live-original-probe', mode: 'probe', endpoints: [rpc.daybreak],
    reference: { ...reference, windows: originalWindows } },
  { name: 'live-daybreak-single', mode: 'single', endpoints: [rpc.daybreak], reference },
  { name: 'live-daybreak-cross', mode: 'cross', endpoints: [rpc.daybreak, rpc.tenderly, rpc.sentio], reference },
  { name: 'live-healthy-single', mode: 'single', endpoints: [rpc.tenderly], reference },
  { name: 'live-healthy-cross', mode: 'cross', endpoints: [rpc.tenderly, rpc.sentio, rpc.pocket], reference },
];
const fixtureCases = [
  { name: 'fixture-omission-single', mode: 'single', endpoints: fixture('omit-a'), reference },
  { name: 'fixture-omission-cross', mode: 'cross', endpoints: fixture('omit-a', 'good-a', 'good-b'), reference },
  { name: 'fixture-shared-omission', mode: 'cross', endpoints: fixture('omit-a', 'omit-b', 'good-b'), reference },
  { name: 'fixture-equal-count', mode: 'cross', endpoints: fixture('subset-a', 'subset-b', 'good-b'), reference },
  { name: 'fixture-error-single', mode: 'single', endpoints: fixture('http-error'), reference },
  { name: 'fixture-error-cross', mode: 'cross', endpoints: fixture('http-error', 'good-a', 'good-b'), reference },
  { name: 'fixture-gate', mode: 'cross', endpoints: fixture('omit-a', 'good-a', 'rpc-error'), reference },
  { name: 'fixture-gate', mode: 'resume', endpoints: fixture('omit-a', 'good-a', 'good-b'), reference },
];
for (const sample of [...(suite === 'fixture' ? [] : liveCases), ...(suite === 'live' ? [] : fixtureCases)]) {
  const filename = `${sample.name}-${sample.mode}.json`;
  const file = Bun.file(`${output}/${filename}`);
  if (await file.exists()) throw new Error(`Sample already exists: ${filename}`);
  evaluate(`(() => {
    globalThis.phase5Failure = null;
    phase5.run(${JSON.stringify(sample)}).then(async result => {
      const saved = await fetch('/samples/${filename}', { method: 'POST', body: JSON.stringify(result) });
      if (!saved.ok) throw Error('Save failed ' + saved.status);
    }).catch(error => { globalThis.phase5Failure = String(error); });
    return 'started';
  })()`);
  const deadline = Date.now() + 240_000;
  while (!await file.exists()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${filename}`);
    const error = evaluate('globalThis.phase5Failure ?? "in progress"');
    if (error !== 'in progress') throw new Error(`${filename}: ${error}`);
    await Bun.sleep(750);
  }
  const { reachedEnd, initialNext, stop, requestCount, missing, catchUpMs, extra } =
    JSON.parse(await readFile(`${output}/${filename}`, 'utf8'));
  console.log(filename, JSON.stringify({ reachedEnd, initialNext, stop, requestCount, missing: missing.length, catchUpMs, extra: extra.length }));
}
