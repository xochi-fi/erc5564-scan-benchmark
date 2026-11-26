/**
 * OPTIONAL, OFF BY DEFAULT. Read-only, fetch-only paging of real ERC-5564
 * Announcer logs from a public mainnet JSON-RPC endpoint. Network cost only:
 * no keys, no accounts, no scanning, no verification. Requires an explicit
 * --rpc URL that needs no credential.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from './chain.ts';
import { decodeAnnouncements, environmentProvenance, rawLogsSchema } from './wallet.ts';

const help = `Optional mainnet fetch-only run (network cost only; off by default)

  --rpc URL            Public JSON-RPC endpoint that needs no API key (required)
  --blocks 50000       How many recent blocks to page through
  --pages 1000,5000    Blocks per eth_getLogs request (sequential, one run per size)
  --output DIR         New output directory
`;

interface PageResult {
  fromBlock: number;
  toBlock: number;
  logs: number;
  fetchMs: number;
  responseBodyBytes: number;
  contentLength: string | null;
  contentEncoding: string | null;
  error: string | null;
}

async function call(url: string, id: number, method: string, params: unknown[]) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const start = performance.now();
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const fetchMs = performance.now() - start;
  const text = new TextDecoder().decode(bytes);
  const envelope = z.object({ result: z.unknown().optional(), error: z.object({ message: z.string() }).passthrough().optional() })
    .passthrough().safeParse(JSON.parse(text));
  return {
    status: response.status,
    fetchMs,
    requestBodyBytes: new TextEncoder().encode(body).byteLength,
    responseBodyBytes: bytes.byteLength,
    contentLength: response.headers.get('content-length'),
    contentEncoding: response.headers.get('content-encoding'),
    result: envelope.success ? envelope.data.result : undefined,
    error: !response.ok ? `HTTP ${response.status}: ${text.slice(0, 200)}` : envelope.success ? envelope.data.error?.message ?? null : 'invalid JSON-RPC envelope',
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      rpc: { type: 'string' },
      blocks: { type: 'string', default: '50000' },
      pages: { type: 'string', default: '1000,5000' },
      output: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || values.rpc === undefined || values.output === undefined) {
    process.stdout.write(help);
    return;
  }
  const rpc = z.string().url().parse(values.rpc);
  if (/[?&](key|apikey|api_key|token)=/i.test(rpc)) throw new Error('refusing an RPC URL that carries a credential');
  const output = resolve(values.output);
  await mkdir(output);
  const blocks = z.coerce.number().int().min(1).max(1_000_000).parse(values.blocks);
  const pageSizes = values.pages.split(',').map(value => z.coerce.number().int().min(1).parse(value));
  let id = 1;
  const head = await call(rpc, id++, 'eth_blockNumber', []);
  if (typeof head.result !== 'string') throw new Error(`eth_blockNumber failed: ${head.error}`);
  const headBlock = Number(BigInt(head.result));
  const fromBlock = headBlock - blocks + 1;
  const runs = [];
  for (const pageBlocks of pageSizes) {
    const pages: PageResult[] = [];
    const runStart = performance.now();
    for (let start = fromBlock; start <= headBlock; start += pageBlocks) {
      const end = Math.min(start + pageBlocks - 1, headBlock);
      const response = await call(rpc, id++, 'eth_getLogs', [{
        address: ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }]);
      let logs = 0;
      let error = response.error;
      if (error === null) {
        const parsed = rawLogsSchema.safeParse(response.result);
        if (parsed.success) logs = decodeAnnouncements(parsed.data).length;
        else error = 'unexpected getLogs result shape';
      }
      pages.push({ fromBlock: start, toBlock: end, logs, fetchMs: response.fetchMs, responseBodyBytes: response.responseBodyBytes, contentLength: response.contentLength, contentEncoding: response.contentEncoding, error });
      console.error(`page ${pageBlocks}: ${start}-${end} ${logs} logs ${response.responseBodyBytes} B ${response.fetchMs.toFixed(0)} ms${error ? ` ERROR ${error}` : ''}`);
    }
    runs.push({
      pageBlocks,
      requests: pages.length,
      errors: pages.filter(page => page.error !== null).length,
      logs: pages.reduce((sum, page) => sum + page.logs, 0),
      totalMs: performance.now() - runStart,
      fetchMsSum: pages.reduce((sum, page) => sum + page.fetchMs, 0),
      responseBodyBytes: pages.reduce((sum, page) => sum + page.responseBodyBytes, 0),
      pages,
    });
  }
  await writeFile(join(output, 'mainnet-fetch.json'), `${JSON.stringify({
    kind: 'phase2-mainnet-fetch-only',
    rpcHost: new URL(rpc).host,
    announcer: ANNOUNCER,
    headBlock,
    fromBlock,
    measuredAt: new Date().toISOString(),
    note: 'Network cost only. Body bytes are after HTTP content decoding; content-length (if sent) is the on-wire body size.',
    environment: await environmentProvenance(),
    runs,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
