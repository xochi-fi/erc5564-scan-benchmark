import { appendFileSync } from 'node:fs';
import { origin, rpc, scope } from './config.ts';

const [cli, page, referencePath, output, count = '3'] = Bun.argv.slice(2);
const rounds = Number(count);
if (!cli || !page || !referencePath || !output || !Number.isSafeInteger(rounds) || rounds < 1) {
  throw new Error('Usage: bun run browser-discovery ORCA_CLI PAGE REFERENCE_JSON OUTPUT_DIR [ROUNDS]');
}
const { agreed, scope: referenceScope, headHash, identities } = await Bun.file(referencePath).json();
if (!agreed || JSON.stringify(referenceScope) !== JSON.stringify(scope) || !headHash || !identities?.length) {
  throw new Error('Need an agreed reference for this fixed scope');
}
const evalPage = (expression: string) => {
  const result = Bun.spawnSync([cli, 'eval', '--page', page, '--expect-url', `${origin}/`, '--expression', expression, '--json']);
  if (result.exitCode !== 0) throw new Error(result.stdout.toString() || result.stderr.toString());
  return JSON.parse(result.stdout.toString()).result.result;
};
const startedAt = new Date().toISOString();
const controls = JSON.parse(evalPage('discovery.controls("http://127.0.0.1:8765")'));
const controlEvents = await (await fetch(`${origin}/control-events`)).json() as { method: string; path: string }[];
if (controls[0]?.status !== 200 || controls[1]?.error?.kind !== 'fetch-rejection' ||
    !controlEvents.some(event => event.path === '/allow' && event.method === 'OPTIONS') ||
    !controlEvents.some(event => event.path === '/allow' && event.method === 'POST') ||
    !controlEvents.some(event => event.path === '/deny' && event.method === 'OPTIONS') ||
    controlEvents.some(event => event.path === '/deny' && event.method === 'POST')) {
  throw new Error('CORS enforcement control failed');
}
const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
await Bun.write(`${output}/run.json`, JSON.stringify({ startedAt, rounds, origin, scope, rpc, revision, controls, controlEvents }, null, 2));
const suite = Object.entries(rpc);
let incompleteHarness = false;
for (let repetition = 1; repetition <= rounds; repetition++) {
  const offset = (repetition - 1) % suite.length;
  for (const [name, endpoint] of [...suite.slice(offset), ...suite.slice(0, offset)]) {
    for (const mode of repetition % 2 === 1 ? ['fresh', 'resume'] : ['resume', 'fresh']) {
      const sample = `${name}-${mode}-${repetition}.json`;
      const input = JSON.stringify({ mode, repetition, endpoint, reference: { headHash, identities } });
      const expression = `(async () => {
        const fixture = await (await fetch('/fixture')).json();
        const result = await discovery.run({...${input}, fixture});
        const saved = await fetch('/samples/${sample}', { method: 'POST', body: JSON.stringify(result) });
        if (!saved.ok) throw new Error('save failed ' + saved.status);
        return JSON.stringify({ reachedHead: result.reachedHead, failure: result.failure, elapsedMs: result.elapsedMs,
          requests: result.requestCount, exact: result.completeness.exact });
      })()`;
      try {
        console.log(sample, evalPage(expression));
        if (!await Bun.file(`${output}/${sample}`).exists()) throw new Error('Raw sample missing');
      } catch (error) {
        incompleteHarness = true;
        const message = String(error);
        console.error(sample, message);
        appendFileSync(`${output}/harness-errors.jsonl`, JSON.stringify({ sample, message }) + '\n');
      }
    }
  }
}
if (incompleteHarness) process.exitCode = 1;
