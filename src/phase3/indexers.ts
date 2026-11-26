/**
 * Keyless indexer clients: Blockscout API v2 address logs (cursor paging),
 * and the etherscan-compatible `module=logs&action=getLogs` (Blockscout and
 * Routescan), paged by advancing fromBlock. Every response is accounted for.
 */
import { z } from 'zod';
import type { HttpResult, Transport } from './http.ts';
import { CANONICAL, type LogFilter } from './rpc.ts';

/** `identity` is block:logIndex (unique per chain); transactionHash may be '' (Blockscout v2 omits it for many logs). */
export interface IndexedLog { blockNumber: number; logIndex: number; transactionHash: string; timestamp: number | null; identity: string }

export const keyOf = (blockNumber: number, logIndex: number) => `${blockNumber}:${logIndex}`;

/** Retries 5xx, timeouts and network errors (429s are already retried by the transport). */
async function getWithRetry(transport: Transport, url: string, tries = 3): Promise<HttpResult> {
  let http = await transport.request(url, { method: 'GET' });
  for (let attempt = 1; attempt < tries; attempt++) {
    const transient = !http.cloudflareChallenge && (http.networkError !== null || http.status >= 500);
    if (!transient) break;
    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    const again = await transport.request(url, { method: 'GET' });
    again.attempts += http.attempts;
    http = again;
  }
  return http;
}

export interface IndexerRun {
  source: string;
  base: string;
  ok: boolean;
  blocked: boolean;          // Cloudflare challenge or similar
  failure: string | null;
  logs: IndexedLog[];
  pages: number;
  pageSizeObserved: number | null; // largest page returned
  requests: number;
  responseBytes: number;
  totalMs: number;
  latencyMs: number[];
  indexedHead: number | null;
  finalUrl: string | null;   // after redirects, if different
  rateLimitHits: number;
}

function emptyRun(source: string, base: string): IndexerRun {
  return { source, base, ok: false, blocked: false, failure: null, logs: [], pages: 0, pageSizeObserved: null, requests: 0, responseBytes: 0, totalMs: 0, latencyMs: [], indexedHead: null, finalUrl: null, rateLimitHits: 0 };
}

function account(run: IndexerRun, http: HttpResult): void {
  run.requests += http.attempts;
  run.responseBytes += http.responseBytes;
  run.latencyMs.push(http.ms);
  run.rateLimitHits += http.rateLimitHits;
}

function httpFailure(http: HttpResult): string | null {
  if (http.cloudflareChallenge) return 'blocked: Cloudflare challenge';
  if (http.networkError !== null) return http.networkError;
  if (!http.ok) return `HTTP ${http.status}: ${http.text.replaceAll(/\s+/g, ' ').slice(0, 160)}`;
  return null;
}

const v2ItemSchema = z.object({
  block_number: z.number(),
  index: z.number(),
  transaction_hash: z.string(),
  block_timestamp: z.string().nullable().optional(),
  topics: z.array(z.string().nullable()),
}).passthrough();
const v2PageSchema = z.object({ items: z.array(v2ItemSchema), next_page_params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable() }).passthrough();

export function parseV2Page(text: string, filter: LogFilter = CANONICAL) {
  const page = v2PageSchema.parse(JSON.parse(text));
  const logs: IndexedLog[] = page.items
    .filter(item => (item.topics[0] ?? '').toLowerCase() === filter.topic0)
    .map(item => ({
      blockNumber: item.block_number,
      logIndex: item.index,
      transactionHash: item.transaction_hash.toLowerCase(),
      timestamp: item.block_timestamp ? Math.floor(Date.parse(item.block_timestamp) / 1000) : null,
      identity: keyOf(item.block_number, item.index),
    }));
  return { logs, itemCount: page.items.length, next: page.next_page_params };
}

export async function blockscoutV2Logs(transport: Transport, base: string, filter: LogFilter = CANONICAL, maxPages = 400): Promise<IndexerRun> {
  const run = emptyRun('blockscout-v2', base);
  const started = performance.now();
  let next: Record<string, string | number | null> | null = {};
  const seen = new Set<string>();
  while (next !== null && run.pages < maxPages) {
    const query = new URLSearchParams(Object.entries(next).filter(([, v]) => v !== null).map(([k, v]): [string, string] => [k, String(v)]));
    const url = `${base}/api/v2/addresses/${filter.address}/logs${query.size ? `?${query}` : ''}`;
    const http = await getWithRetry(transport, url);
    account(run, http);
    const failure = httpFailure(http);
    if (failure !== null) { run.failure = failure; run.blocked = http.cloudflareChallenge; break; }
    try {
      const page = parseV2Page(http.text, filter);
      run.pages++;
      run.pageSizeObserved = Math.max(run.pageSizeObserved ?? 0, page.itemCount);
      for (const log of page.logs) if (!seen.has(log.identity)) { seen.add(log.identity); run.logs.push(log); }
      next = page.next;
    } catch (error) {
      run.failure = `unexpected v2 body: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
      break;
    }
  }
  if (run.failure === null && next !== null) run.failure = `stopped after ${maxPages} pages`;
  run.ok = run.failure === null;
  run.totalMs = performance.now() - started;
  run.logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return run;
}

const etherscanSchema = z.object({ status: z.string(), message: z.string(), result: z.unknown() }).passthrough();
const etherscanLogSchema = z.object({ blockNumber: z.string(), logIndex: z.string(), transactionHash: z.string(), timeStamp: z.string().optional(), topics: z.array(z.string().nullable()) }).passthrough();

const num = (value: string) => (value === '0x' ? 0 : value.startsWith('0x') ? Number(BigInt(value)) : Number(value));

export function parseEtherscanLogs(text: string, filter: LogFilter = CANONICAL): { logs: IndexedLog[]; raw: number; message: string; status: string } {
  const body = etherscanSchema.parse(JSON.parse(text));
  if (!Array.isArray(body.result)) {
    if (body.message === 'No records found' || (body.status === '0' && Array.isArray(body.result))) return { logs: [], raw: 0, message: body.message, status: body.status };
    throw new Error(`${body.message}: ${JSON.stringify(body.result).slice(0, 160)}`);
  }
  const items = z.array(etherscanLogSchema).parse(body.result);
  const logs = items
    .filter(item => (item.topics[0] ?? '').toLowerCase() === filter.topic0)
    .map(item => {
      const logIndex = num(item.logIndex);
      const blockNumber = num(item.blockNumber);
      return { blockNumber, logIndex, transactionHash: item.transactionHash.toLowerCase(), timestamp: item.timeStamp ? num(item.timeStamp) : null, identity: keyOf(blockNumber, logIndex) };
    });
  return { logs, raw: items.length, message: body.message, status: body.status };
}

/**
 * Pages an etherscan-compatible getLogs from fromBlock to toBlock. When a page
 * comes back full (the server's per-call result cap), the next call restarts at
 * the last block seen (deduplicating), so a block cut in half is re-read.
 */
export async function etherscanLogs(transport: Transport, source: string, base: string, fromBlock: number, toBlock: number, filter: LogFilter = CANONICAL, maxPages = 200): Promise<IndexerRun> {
  const run = emptyRun(source, base);
  const started = performance.now();
  const seen = new Set<string>();
  let cursor = fromBlock;
  let cap: number | null = null;
  while (run.pages < maxPages) {
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${sep}module=logs&action=getLogs&fromBlock=${cursor}&toBlock=${toBlock}&address=${filter.address}&topic0=${filter.topic0}`;
    const http = await getWithRetry(transport, url);
    account(run, http);
    if (http.url !== url && run.finalUrl === null) run.finalUrl = http.url;
    const failure = httpFailure(http);
    if (failure !== null) { run.failure = failure; run.blocked = http.cloudflareChallenge; break; }
    let page: ReturnType<typeof parseEtherscanLogs>;
    try {
      page = parseEtherscanLogs(http.text, filter);
    } catch (error) {
      run.failure = `${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
      break;
    }
    run.pages++;
    run.pageSizeObserved = Math.max(run.pageSizeObserved ?? 0, page.raw);
    let added = 0;
    for (const log of page.logs) if (!seen.has(log.identity)) { seen.add(log.identity); run.logs.push(log); added++; }
    // The per-call result cap differs by service (Routescan 100, Blockscout 1000) and is
    // not announced, so keep paging from the last block seen until a page adds nothing.
    if (page.raw === 0 || added === 0) {
      if (page.raw > 0 && cap !== null && page.raw >= cap && page.logs.every(log => log.blockNumber === cursor)) {
        run.failure = `page cap ${page.raw} reached inside one block ${cursor}; cannot page further`;
      }
      break;
    }
    cap = Math.max(cap ?? 0, page.raw);
    cursor = Math.max(...page.logs.map(log => log.blockNumber));
  }
  if (run.failure === null && run.pages >= maxPages) run.failure = `stopped after ${maxPages} pages`;
  run.ok = run.failure === null;
  run.totalMs = performance.now() - started;
  run.logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return run;
}

const v2BlocksSchema = z.object({ items: z.array(z.object({ height: z.number() }).passthrough()) }).passthrough();

export async function blockscoutHead(transport: Transport, base: string): Promise<{ head: number | null; failure: string | null; http: HttpResult }> {
  const http = await transport.request(`${base}/api/v2/blocks?type=block`, { method: 'GET' });
  const failure = httpFailure(http);
  if (failure !== null) return { head: null, failure, http };
  try {
    return { head: v2BlocksSchema.parse(JSON.parse(http.text)).items[0]?.height ?? null, failure: null, http };
  } catch (error) {
    return { head: null, failure: String(error).slice(0, 160), http };
  }
}

export async function etherscanHead(transport: Transport, base: string): Promise<{ head: number | null; failure: string | null; http: HttpResult }> {
  const sep = base.includes('?') ? '&' : '?';
  const http = await transport.request(`${base}${sep}module=proxy&action=eth_blockNumber`, { method: 'GET' });
  const failure = httpFailure(http);
  if (failure !== null) return { head: null, failure, http };
  try {
    const body = z.object({ result: z.string() }).passthrough().parse(JSON.parse(http.text));
    return { head: /^0x[0-9a-f]+$/i.test(body.result) ? Number(BigInt(body.result)) : null, failure: /^0x/.test(body.result) ? null : body.result.slice(0, 160), http };
  } catch (error) {
    return { head: null, failure: `${String(error).slice(0, 80)} ${http.text.slice(0, 80)}`, http };
  }
}

const addressSchema = z.object({ creation_transaction_hash: z.string().nullable().optional(), creator_address_hash: z.string().nullable().optional() }).passthrough();
const txSchema = z.object({ block_number: z.number(), timestamp: z.string().nullable().optional() }).passthrough();

/** Deploy block from Blockscout: the address's creation transaction, then that transaction's block. */
export async function blockscoutDeploy(transport: Transport, base: string, address: string): Promise<{ deployBlock: number | null; creationTx: string | null; failure: string | null }> {
  const http = await transport.request(`${base}/api/v2/addresses/${address}`, { method: 'GET' });
  const failure = httpFailure(http);
  if (failure !== null) return { deployBlock: null, creationTx: null, failure };
  const tx = addressSchema.parse(JSON.parse(http.text)).creation_transaction_hash ?? null;
  if (tx === null) return { deployBlock: null, creationTx: null, failure: 'no creation transaction' };
  const txHttp = await transport.request(`${base}/api/v2/transactions/${tx}`, { method: 'GET' });
  const txFailure = httpFailure(txHttp);
  if (txFailure !== null) return { deployBlock: null, creationTx: tx, failure: txFailure };
  return { deployBlock: txSchema.parse(JSON.parse(txHttp.text)).block_number, creationTx: tx, failure: null };
}
