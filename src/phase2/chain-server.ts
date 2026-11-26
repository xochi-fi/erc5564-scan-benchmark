import { z } from 'zod';
import { RpcError, SyntheticChain, indexFixture } from './chain.ts';
import { startLinkEmulator } from './link.ts';
import { linkProfileSchema, type ChainEndpoints, type ChainStats, type LinkProfile } from './model.ts';

const serverOptionsSchema = z.object({
  fixtureDir: z.string().min(1),
  profile: linkProfileSchema,
}).strict();

const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  method: z.string(),
  params: z.array(z.unknown()).default([]),
}).passthrough();

export interface RunningChain {
  endpoints: ChainEndpoints;
  stop(): Promise<void>;
}

/**
 * Starts the deterministic JSON-RPC server, the link emulator in front of it,
 * and an unshaped control endpoint (stats, head control) that is never on the
 * measured path.
 */
export async function startChain(fixtureDir: string, profile: LinkProfile): Promise<RunningChain> {
  const index = await indexFixture(fixtureDir);
  const chain = new SyntheticChain(index);
  const rpcStats: ChainStats['rpc'] = {};
  const encoder = new TextEncoder();

  function record(method: string, requestBytes: number, responseBytes: number): void {
    const entry = rpcStats[method] ?? { requests: 0, requestBodyBytes: 0, responseBodyBytes: 0 };
    entry.requests += 1;
    entry.requestBodyBytes += requestBytes;
    entry.responseBodyBytes += responseBytes;
    rpcStats[method] = entry;
  }

  const rpc = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const body = await request.text();
      let id: string | number | null = null;
      let method = 'invalid';
      let payload: string;
      try {
        const parsed = rpcRequestSchema.safeParse(JSON.parse(body));
        if (!parsed.success) throw new RpcError(-32600, 'invalid request');
        id = parsed.data.id;
        method = parsed.data.method;
        const result = await chain.call(method, parsed.data.params);
        payload = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${result}}`;
      } catch (error) {
        const code = error instanceof RpcError ? error.code : -32603;
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof RpcError)) console.error('chain server internal error', error);
        payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
      }
      const bytes = encoder.encode(payload);
      record(method, encoder.encode(body).byteLength, bytes.byteLength);
      return new Response(bytes, { headers: { 'content-type': 'application/json' } });
    },
  });
  const rpcPort = rpc.port;
  if (rpcPort === undefined) throw new Error('RPC server did not bind a port');
  const link = startLinkEmulator(rpcPort, profile);

  const control = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/stats') {
        const stats: ChainStats = {
          link: link.counters(),
          rpc: structuredClone(rpcStats),
          head: chain.head,
          rssBytes: process.memoryUsage().rss,
        };
        return Response.json(stats);
      }
      if (request.method === 'POST' && url.pathname === '/head') {
        const parsed = z.object({ head: z.number().int().nullable() }).safeParse(await request.json());
        if (!parsed.success) return new Response('invalid head', { status: 400 });
        const head = parsed.data.head ?? index.lastBlock;
        if (head < index.firstBlock - 1 || head > index.lastBlock) return new Response('head out of range', { status: 400 });
        chain.head = head;
        return Response.json({ head });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    endpoints: {
      rpcUrl: `http://127.0.0.1:${link.port}/`,
      directRpcUrl: `http://127.0.0.1:${rpcPort}/`,
      controlUrl: `http://127.0.0.1:${control.port}/`,
      firstBlock: index.firstBlock,
      lastBlock: index.lastBlock,
      fixtureSha256: index.manifest.fixtureSha256,
      count: index.manifest.count,
      profile,
    },
    async stop() {
      link.stop();
      await rpc.stop(true);
      await control.stop(true);
      await index.file.close();
    },
  };
}

if (import.meta.main) {
  try {
    const argument = Bun.argv[2];
    if (argument === undefined || Bun.argv.length !== 3) throw new Error('Expected one JSON options argument');
    const options = serverOptionsSchema.parse(JSON.parse(argument));
    const running = await startChain(options.fixtureDir, options.profile);
    process.stdout.write(`${JSON.stringify(running.endpoints)}\n`);
    const shutdown = (): void => {
      running.stop().then(() => process.exit(0), (error: unknown) => {
        console.error(error);
        process.exit(1);
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
