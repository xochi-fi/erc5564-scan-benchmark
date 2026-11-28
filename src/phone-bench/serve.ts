// `bun run phone-bench:serve [--host IP] [--port N] [--dir DIR]`: serves the built phone bench site and
// nothing else, reading each file on every request. Default 127.0.0.1; never binds every interface.
// Logs method, path, status, bytes and user agent to stdout.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8790' }, dir: { type: 'string' } } });
if (values.host === '0.0.0.0' || values.host === '::') throw new Error('refusing to bind every interface; pass a loopback or Tailscale IP');
const dir = values.dir ?? new URL('../../work/phone-bench/', import.meta.url).pathname;
const FILES: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html',
  '/app.js': 'app.js', '/worker.js': 'worker.js', '/fixture.js': 'fixture.js',
  '/worker-wasm.js': 'worker-wasm.js', '/wasm-bytes.js': 'wasm-bytes.js',
};
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8' };
const server = Bun.serve({
  hostname: values.host, port: Number(values.port),
  async fetch(request) {
    const url = new URL(request.url);
    const name = request.method === 'GET' ? FILES[url.pathname] : undefined;
    const body = name ? new Uint8Array(await Bun.file(`${dir}${name}`).arrayBuffer()) : null;
    console.log(`${new Date().toISOString()} ${request.method} ${url.pathname}${url.search} ${body ? 200 : 404} ${body?.byteLength ?? 0} ${request.headers.get('user-agent') ?? ''}`);
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { headers: { 'content-type': TYPES[name!.split('.').pop()!]!, 'cache-control': 'no-store' } });
  },
});
console.log(`serving ${dir} at http://${server.hostname}:${server.port}/`);
