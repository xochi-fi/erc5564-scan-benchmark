// `bun run phone-bench:serve [--host IP] [--port N]`: serves work/phone-bench/index.html and nothing else.
// Default 127.0.0.1. On the tailnet pass Bazzite's Tailscale IP; never bind 0.0.0.0. Logs no requests.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8790' } } });
if (values.host === '0.0.0.0' || values.host === '::') throw new Error('refusing to bind every interface; pass a loopback or Tailscale IP');
const page = Bun.file(new URL('../../work/phone-bench/index.html', import.meta.url));
if (!(await page.exists())) throw new Error('run bun run phone-bench:build first');
const server = Bun.serve({
  hostname: values.host, port: Number(values.port),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' || (path !== '/' && path !== '/index.html')) return new Response('not found', { status: 404 });
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  },
});
console.log(`serving http://${server.hostname}:${server.port}/`);
