import { generateFixture } from '../../src/fixtures.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { origin, scope } from './config.ts';
import type { Input, RawLog } from './browser.ts';

const output = Bun.argv[2];
if (!output) throw new Error('Pass a local sample directory');
await mkdir(output, { recursive: true });
const dir = `${output}/fixture-source`;
const build = await Bun.build({ entrypoints: ['scripts/phase4/browser.ts'], target: 'browser' });
const [artifact] = build.outputs;
if (!build.success || !artifact) throw new Error(build.logs.join('\n'));
const bundle = await artifact.text();
const fixtureBlocks = [scope.saved + 750, scope.start + 50, scope.saved + 1750, scope.saved + 100];
const manifest = await generateFixture(dir, { seed: 'phase4:base:browser:v1', count: 4, matchEvery: 2 });
const raw = (await Bun.file(`${dir}/announcements.jsonl`).text()).trim().split('\n')
  .map(line => JSON.parse(line) as RawLog);
if (raw.length !== fixtureBlocks.length) throw new Error('Unexpected fixture row count');
const rows = fixtureBlocks.map((block, i) => ({
  block, raw: { ...raw[i]!, blockNumber: `0x${block.toString(16)}` },
  expected: manifest.expectedIndices.includes(i),
}));
const fixture: Input['fixture'] = { recipient: manifest.recipient, rows };
const html = '<!doctype html><meta charset="utf-8"><title>Phase 4 Base benchmark</title><script type="module" src="/browser.js"></script><p>Phase 4 Base benchmark</p>';

const controlEvents: { method: string; path: string; origin: string | null; status: number }[] = [];
Bun.serve({
  hostname: '127.0.0.1', port: 8765,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const allowed = path === '/allow' && request.headers.get('origin') === origin;
    const headers = allowed ? {
      'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
    } : {};
    const status = request.method === 'OPTIONS' ? 204 : 200;
    controlEvents.push({ method: request.method, path, origin: request.headers.get('origin'), status });
    if (status === 204) return new Response(null, { status, headers });
    const { id } = await request.json() as { id: number };
    return Response.json({ jsonrpc: '2.0', id, result: scope.chainId }, { headers });
  },
});
Bun.serve({
  hostname: '127.0.0.1', port: Number(new URL(origin).port),
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const sampleName = /^\/samples\/([a-z0-9-]+\.json)$/.exec(pathname)?.[1];
    if (sampleName && request.method === 'POST') {
      await writeFile(`${output}/${sampleName}`, await request.text(), { flag: 'wx' });
      return new Response(null, { status: 204 });
    }
    switch (pathname) {
      case '/': return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      case '/browser.js': return new Response(bundle, { headers: { 'content-type': 'text/javascript' } });
      case '/fixture': return Response.json(fixture);
      case '/control-events': return Response.json(controlEvents);
      default: return new Response(null, { status: 404 });
    }
  },
});
console.log(origin);
