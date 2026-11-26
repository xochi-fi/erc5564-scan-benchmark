import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { control, filter, hex, origin, scope, type Window } from './config.ts';
import type { RawLog } from './browser.ts';

const [referencePath, output] = Bun.argv.slice(2);
if (!referencePath || !output) throw new Error('Usage: bun scripts/phase5/serve.ts REFERENCE_JSON OUTPUT_DIR');
const reference = await Bun.file(referencePath).json() as {
  agreed: boolean; headHash: string; windows: Window[]; logs: RawLog[];
};
if (!reference.agreed) throw new Error('Need a corroborated reference');
await mkdir(output, { recursive: true });
const build = await Bun.build({ entrypoints: ['scripts/phase5/browser.ts'], target: 'browser' });
const [artifact] = build.outputs;
if (!build.success || !artifact) throw new Error(build.logs.join('\n'));
const bundle = await artifact.text();

const firstPositive = reference.windows.find(window => reference.logs.some(log =>
  Number(log.blockNumber) >= window.from && Number(log.blockNumber) <= window.to))!;
const controlEvents: { method: string; path: string; origin: string | null }[] = [];
Bun.serve({
  hostname: '127.0.0.1', port: Number(new URL(control).port),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const requestOrigin = request.headers.get('origin');
    const headers = path === '/deny' || requestOrigin !== origin ? {} : {
      'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
    };
    controlEvents.push({ method: request.method, path, origin: requestOrigin });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const { id, method, params } = await request.json() as {
      id: number; method: string; params: Array<string | { fromBlock?: string; toBlock?: string }>;
    };
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result }, { headers });
    if (path === '/allow' || method === 'eth_chainId') return reply(scope.chainId);
    if (method === 'eth_getBlockByNumber' && params[0] === hex(scope.head)) {
      return reply({ number: hex(scope.head), hash: reference.headHash });
    }
    const [, fixture, variant] = path.split('/');
    const query = typeof params[0] === 'object' ? params[0] : undefined;
    const from = Number(query?.fromBlock);
    const to = Number(query?.toBlock);
    const validWindow = reference.windows.some(window => window.from === from && window.to === to);
    if (method !== 'eth_getLogs' || fixture !== 'fixture' || !validWindow ||
        JSON.stringify(query) !== JSON.stringify(filter(from, to))) {
      return new Response('non-fixture request', { status: 400, headers });
    }
    const genuine = reference.logs.filter(log => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to);
    if (from === firstPositive.from && (variant === 'http-error' || variant === 'rpc-error')) {
      const error = { code: -32000, message: 'Injected Phase 5 fixture error' };
      return Response.json({ jsonrpc: '2.0', id, error }, { headers, status: variant === 'http-error' ? 503 : 200 });
    }
    if (variant === 'omit-a' || variant === 'omit-b') return reply([]);
    if (variant === 'subset-a' && genuine.length > 1) return reply(genuine.slice(0, 1));
    if (variant === 'subset-b' && genuine.length > 1) return reply(genuine.slice(1, 2));
    if (variant === 'subset-a' || variant === 'subset-b') return reply(genuine);
    if (variant === 'good-a' || variant === 'good-b') return reply(genuine);
    if (variant === 'http-error' || variant === 'rpc-error') return reply(genuine);
    return new Response('unknown fixture variant', { status: 400, headers });
  },
});

Bun.serve({
  hostname: '127.0.0.1', port: Number(new URL(origin).port),
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const sample = /^\/samples\/([a-z0-9-]+\.json)$/.exec(pathname)?.[1];
    if (sample && request.method === 'POST') {
      const temporary = `${output}/.${sample}.${crypto.randomUUID()}`;
      await writeFile(temporary, await request.text(), { flag: 'wx' });
      try {
        await link(temporary, `${output}/${sample}`);
      } finally {
        await unlink(temporary);
      }
      return new Response(null, { status: 204 });
    }
    switch (pathname) {
      case '/': return new Response('<!doctype html><meta charset="utf-8"><title>Phase 5 Base replay</title><script type="module" src="/browser.js"></script>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      case '/browser.js': return new Response(bundle, { headers: { 'content-type': 'text/javascript' } });
      case '/control-events': return Response.json(controlEvents);
      default: return new Response(null, { status: 404 });
    }
  },
});
console.log(origin);
