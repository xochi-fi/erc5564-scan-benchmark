import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
// Regenerate recorded RPC error fixtures and review the classifier output.
import { interpretRpc, rpcLogsSchema } from './rpc.ts';
const seen = new Set<string>();
const out: unknown[] = [];
for (const file of readdirSync('data/chain-volume/probe')) {
  const probe = JSON.parse(readFileSync(`data/chain-volume/probe/${file}`, 'utf8'));
  for (const ep of probe.endpoints) for (const e of ep.errors) {
    if (e.message.startsWith('timeout') || e.message.startsWith('TypeError') || e.message.includes('<')) continue;
    const key = `${ep.host}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const body = e.httpStatus === 200
      ? JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: e.code ?? -32000, message: e.message } })
      : e.message.replace(/^HTTP \d+: /, '');
    const http = { url: '', status: e.httpStatus, ok: e.httpStatus === 200, ms: 1, requestBytes: 1, responseBytes: 1, contentLength: null, contentEncoding: null, retryAfter: null, lastModified: null, text: body, networkError: null, cloudflareChallenge: false, rateLimited: false, attempts: 1, rateLimitHits: 0 };
    const call = interpretRpc(http, rpcLogsSchema);
    out.push({ provider: `${probe.chain} ${ep.host}`, httpStatus: e.httpStatus, body, kind: call.error?.kind, limitHint: call.error?.limitHint ?? null });
  }
}
writeFileSync('test/fixtures/chain-volume/rpc-errors.json', JSON.stringify(out, null, 1) + '\n');
console.log(`${out.length} fixtures`);
