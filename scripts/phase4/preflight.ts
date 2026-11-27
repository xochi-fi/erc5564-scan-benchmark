import { origin, rpc } from './config.ts';

const file = Bun.argv[2];
if (!file || await Bun.file(file).exists()) throw new Error('Pass a new diagnostic output path');
const rows = await Promise.all(Object.entries(rpc).map(async ([name, endpoint]) => {
  const start = performance.now();
  const requestHeaders = {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  };
  try {
    const response = await fetch(endpoint, {
      method: 'OPTIONS', headers: requestHeaders, redirect: 'manual', signal: AbortSignal.timeout(12_000),
    });
    const headers = Object.fromEntries(response.headers);
    const status = response.status;
    const elapsedMs = performance.now() - start;
    const body = await response.text();
    const allow = (field: string, value: string) => (headers[field] ?? '').toLowerCase().split(',')
      .some(part => [value, '*'].includes(part.trim()));
    const corsPreflightSupported = response.ok &&
      [origin, '*'].includes(headers['access-control-allow-origin'] ?? '') &&
      allow('access-control-allow-methods', 'post') &&
      allow('access-control-allow-headers', 'content-type');
    return { name, endpoint, requestHeaders, status, headers, body, elapsedMs, corsPreflightSupported };
  } catch (error) {
    return { name, endpoint, requestHeaders, elapsedMs: performance.now() - start, error: String(error) };
  }
}));
await Bun.write(file, JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2) + '\n');
