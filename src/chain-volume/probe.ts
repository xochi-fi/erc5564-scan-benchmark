import { z } from 'zod';
import type { Transport } from './http.ts';
import { searchMaxRange, type RangeSearchResult } from './range-search.ts';
import { getLogsParams, logKey, quantity, rpc, rpcLogsSchema, type ErrorKind, type RpcCall } from './rpc.ts';
import { percentile } from '../shared/stats.ts';

export interface ErrorSample { kind: ErrorKind; code: number | null; httpStatus: number; message: string; limitHint: number | null; span: number | null }

export interface ArchivePoint { depthBlocks: number; fromBlock: number; toBlock: number; ok: boolean; logs: number; kind: ErrorKind | null; message: string | null }

export interface EndpointProbe {
  url: string;
  host: string;
  chainIdOk: boolean | null;
  head: number | null;
  status: 'usable' | 'unusable';
  unusableReason: string | null;
  range: (Omit<RangeSearchResult, 'steps'> & { steps: Array<{ blocks: number; verdict: string; note: string | null }> }) | null;
  archive: ArchivePoint[];
  /** Oldest depth (blocks behind head) at which a window was served. */
  archiveDepthServed: number | null;
  servesDeployBlock: boolean | null;
  /** For chains with a reference set: whether the first known announcement came back. */
  firstLogReturned: boolean | null;
  latency: { span: number; samples: number; okSamples: number; medianMs: number | null; p95Ms: number | null; maxMs: number | null };
  requests: number;
  responseBytes: number;
  rateLimitHits: number;
  retryAfterSeen: string[];
  errors: ErrorSample[];
  probeMs: number;
}

export interface ProbeContext {
  transport: Transport;
  chainId: number;
  deployBlock: number;
  /** First announcement (block, identity), when a reference set exists. */
  firstLog: { blockNumber: number; identity: string } | null;
  latencySamples?: number;
  log?: (line: string) => void;
}

const TRANSIENT: ErrorKind[] = ['timeout', 'http', 'rate-limit', 'other', 'invalid-response'];

export async function probeEndpoint(url: string, ctx: ProbeContext): Promise<EndpointProbe> {
  const started = performance.now();
  const out: EndpointProbe = {
    url, host: new URL(url).host, chainIdOk: null, head: null, status: 'unusable', unusableReason: null, range: null,
    archive: [], archiveDepthServed: null, servesDeployBlock: null, firstLogReturned: null,
    latency: { span: 0, samples: 0, okSamples: 0, medianMs: null, p95Ms: null, maxMs: null },
    requests: 0, responseBytes: 0, rateLimitHits: 0, retryAfterSeen: [], errors: [], probeMs: 0,
  };
  const seenMessages = new Set<string>();
  const account = <T>(call: RpcCall<T>, span: number | null): RpcCall<T> => {
    out.requests += call.http.attempts;
    out.responseBytes += call.http.responseBytes;
    out.rateLimitHits += call.http.rateLimitHits;
    if (call.http.retryAfter !== null && !out.retryAfterSeen.includes(call.http.retryAfter)) out.retryAfterSeen.push(call.http.retryAfter);
    if (call.error !== null) {
      const key = `${call.error.kind}|${call.error.code}|${call.error.message.replaceAll(/\d+/g, '#')}`;
      if (!seenMessages.has(key) && out.errors.length < 25) {
        seenMessages.add(key);
        out.errors.push({ ...call.error, span });
      }
    }
    return call;
  };
  const finish = (reason: string | null) => {
    out.unusableReason = reason;
    out.status = reason === null ? 'usable' : 'unusable';
    out.probeMs = performance.now() - started;
    return out;
  };

  const chainId = account(await rpc(ctx.transport, url, 'eth_chainId', [], quantity), null);
  if (chainId.error !== null) return finish(`eth_chainId: ${chainId.error.kind}: ${chainId.error.message}`);
  out.chainIdOk = chainId.result === ctx.chainId;
  if (!out.chainIdOk) return finish(`wrong chain id ${chainId.result}`);
  const headCall = account(await rpc(ctx.transport, url, 'eth_blockNumber', [], quantity), null);
  if (headCall.error !== null || headCall.result === null) return finish(`eth_blockNumber: ${headCall.error?.kind}: ${headCall.error?.message}`);
  const head = headCall.result;
  out.head = head;

  const getLogs = async (from: number, to: number) => account(await rpc(ctx.transport, url, 'eth_getLogs', getLogsParams(from, to), rpcLogsSchema), to - from + 1);
  /** Retries transient failures once so a single blip is not recorded as a limit. */
  const getLogsSettled = async (from: number, to: number) => {
    let call = await getLogs(from, to);
    if (call.error !== null && TRANSIENT.includes(call.error.kind)) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      call = await getLogs(from, to);
    }
    return call;
  };

  const small = await getLogsSettled(Math.max(0, head - 9), head);
  if (small.error !== null) return finish(`eth_getLogs (10 recent blocks): ${small.error.kind}: ${small.error.message}`);

  const ceiling = head - ctx.deployBlock + 1;
  const search = await searchMaxRange(async (blocks) => {
    const call = await getLogsSettled(head - blocks + 1, head);
    return call.error === null
      ? { verdict: 'ok', note: `${call.result?.length ?? 0} logs, ${call.http.ms.toFixed(0)} ms` }
      : { verdict: 'fail', note: `${call.error.kind}: ${call.error.message.slice(0, 140)}` };
  }, { start: 1000, ceiling, maxSteps: 32 });
  out.range = search;
  ctx.log?.(`  ${out.host}: max span ${search.unbounded ? `>= ${search.maxOk} (whole history)` : `${search.maxOk} (fails at ${search.minFail})`}`);
  if (search.maxOk === 0) return finish('no eth_getLogs span accepted');

  // Archive depth: a small window at increasing depths, down to the deploy block.
  const window = Math.min(search.maxOk, 1000);
  const depths: number[] = [];
  for (let depth = 10_000; depth < head - ctx.deployBlock; depth *= 10) depths.push(depth);
  depths.push(head - ctx.deployBlock);
  for (const depth of depths) {
    const from = head - depth;
    const call = await getLogsSettled(from, from + window - 1);
    out.archive.push({ depthBlocks: depth, fromBlock: from, toBlock: from + window - 1, ok: call.error === null, logs: call.result?.length ?? 0, kind: call.error?.kind ?? null, message: call.error?.message.slice(0, 160) ?? null });
  }
  const served = out.archive.filter(point => point.ok).map(point => point.depthBlocks);
  out.archiveDepthServed = served.length > 0 ? Math.max(...served) : null;
  out.servesDeployBlock = out.archive.at(-1)?.ok ?? null;
  if (ctx.firstLog !== null) {
    const from = Math.max(ctx.deployBlock, ctx.firstLog.blockNumber - Math.floor(window / 2));
    const call = await getLogsSettled(from, from + window - 1);
    const first = ctx.firstLog;
    out.firstLogReturned = call.error === null ? (call.result ?? []).some(log => logKey(log) === first.identity) : false;
  }

  // Latency: fixed-span windows stepping back from head so responses are not cached.
  const samples = ctx.latencySamples ?? 10;
  const spanForLatency = Math.min(search.maxOk, 1000);
  const timings: number[] = [];
  for (let index = 0; index < samples; index++) {
    const to = head - index * spanForLatency;
    const call = await getLogs(to - spanForLatency + 1, to);
    if (call.error === null) timings.push(call.http.ms);
  }
  out.latency = { span: spanForLatency, samples, okSamples: timings.length, medianMs: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95), maxMs: timings.length ? Math.max(...timings) : null };
  return finish(null);
}

/** Bisects for the first block with code at the Announcer (eth_getCode needs archive state). */
export async function findDeployBlock(
  codeAt: (block: number) => Promise<boolean | null>,
  head: number,
): Promise<{ deployBlock: number | null; requests: number; reason: string | null }> {
  let requests = 0;
  const check = async (block: number) => { requests++; return codeAt(block); };
  if ((await check(head)) !== true) return { deployBlock: null, requests, reason: 'no code at head (or call failed)' };
  let lo = 0;
  let hi = head;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const has = await check(mid);
    if (has === null) return { deployBlock: null, requests, reason: `eth_getCode failed at block ${mid} (no archive state?)` };
    if (has) hi = mid;
    else lo = mid;
  }
  return { deployBlock: hi, requests, reason: null };
}

export const codeSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
