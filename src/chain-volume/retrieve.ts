// Advance the checkpoint only after a successful window.
import type { Transport } from './http.ts';
import { CANONICAL, getLogsParams, logKey, rpc, rpcLogsSchema, type ErrorKind, type LogFilter, type RpcLog } from './rpc.ts';

export interface RetrieveOptions {
  endpoints: string[];
  filter?: LogFilter;
  fromBlock: number;
  toBlock: number;
  initialSpan: number;
  maxSpan?: number;
  minSpan?: number;
  retriesPerWindow?: number;     // per endpoint, for transient errors
  growAfter?: number;            // successes before doubling the span
  /** An endpoint whose learned span is below this goes to the back of the list (default 1000). */
  preferSpan?: number;
  maxRequests?: number;          // hard budget
  maxMs?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onCheckpoint?: (nextBlock: number, logs: number, progress: RetrieveResult) => void;
  /** Resume from a saved checkpoint: logs already fetched below `checkpoint` and the counters so far. */
  resume?: { checkpoint: number; logs: RpcLog[]; requests: number; okRequests: number; responseBytes: number; requestBytes: number; fetchMs: number; elapsedMs: number };
  log?: (line: string) => void;
}

export interface EndpointUse { url: string; requests: number; ok: number; errors: Partial<Record<ErrorKind, number>>; errorSamples: Partial<Record<ErrorKind, string>>; learnedMaxSpan: number | null; abandonedAt: number | null; abandonReason: string | null; deprioritizedAt: number | null }

export interface RetrieveResult {
  success: boolean;
  failure: string | null;
  fromBlock: number;
  toBlock: number;
  checkpoint: number;          // next block that still needs fetching
  logs: RpcLog[];
  requests: number;
  okRequests: number;
  responseBytes: number;
  requestBytes: number;
  totalMs: number;
  fetchMs: number;
  endpointSwitches: number;
  spanHistogram: Record<string, number>;
  endpoints: EndpointUse[];
}

const SHRINK: ErrorKind[] = ['range-limit', 'result-limit', 'timeout'];
const RETRY: ErrorKind[] = ['rate-limit', 'http', 'other', 'invalid-response', 'timeout'];

export async function retrieveHistory(transport: Transport, options: RetrieveOptions): Promise<RetrieveResult> {
  const started = performance.now() - (options.resume?.elapsedMs ?? 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const minSpan = options.minSpan ?? 1;
  const maxSpan = options.maxSpan ?? Number.MAX_SAFE_INTEGER;
  const retries = options.retriesPerWindow ?? 2;
  const growAfter = options.growAfter ?? 4;
  const maxRequests = options.maxRequests ?? 50_000;
  const maxMs = options.maxMs ?? 3 * 3600_000;
  const backoffMs = options.backoffMs ?? 1000;
  const uses: EndpointUse[] = options.endpoints.map(url => ({ url, requests: 0, ok: 0, errors: {}, errorSamples: {}, learnedMaxSpan: null, abandonedAt: null, abandonReason: null, deprioritizedAt: null }));
  const preferSpan = options.preferSpan ?? 1000;
  const result: RetrieveResult = {
    success: false, failure: null, fromBlock: options.fromBlock, toBlock: options.toBlock, checkpoint: options.fromBlock,
    logs: [], requests: 0, okRequests: 0, responseBytes: 0, requestBytes: 0, totalMs: 0, fetchMs: 0, endpointSwitches: 0,
    spanHistogram: {}, endpoints: uses,
  };
  const seen = new Set<string>();
  let endpointIndex = 0;
  let span = Math.min(options.initialSpan, maxSpan);
  let streak = 0;
  let cursor = options.fromBlock;
  if (options.resume !== undefined) {
    const r = options.resume;
    cursor = Math.max(options.fromBlock, r.checkpoint);
    result.checkpoint = cursor;
    for (const log of r.logs) { const id = logKey(log); if (!seen.has(id)) { seen.add(id); result.logs.push(log); } }
    Object.assign(result, { requests: r.requests, okRequests: r.okRequests, responseBytes: r.responseBytes, requestBytes: r.requestBytes, fetchMs: r.fetchMs });
  }

  const nextEndpoint = (reason: string, abandon = true): boolean => {
    const current = uses[endpointIndex];
    if (current !== undefined) {
      if (abandon) { current.abandonedAt = cursor; current.abandonReason = reason; } else current.deprioritizedAt = cursor;
    }
    // Prefer endpoints not yet deprioritized; fall back to deprioritized ones (slow but working).
    const order = [...uses.keys()].map(step => (endpointIndex + 1 + step) % uses.length);
    const pick = order.find(i => uses[i]?.abandonedAt === null && uses[i]?.deprioritizedAt === null)
      ?? order.find(i => uses[i]?.abandonedAt === null && i !== endpointIndex);
    for (const candidate of pick === undefined ? [] : [pick]) {
      if (uses[candidate]?.abandonedAt === null) {
        endpointIndex = candidate;
        result.endpointSwitches++;
        const learned = uses[candidate]?.learnedMaxSpan;
        span = Math.min(options.initialSpan, maxSpan, learned ?? Number.MAX_SAFE_INTEGER);
        streak = 0;
        options.log?.(`  switch -> ${uses[candidate]?.url} at block ${cursor} (${reason})`);
        return true;
      }
    }
    return false;
  };

  let attemptsHere = 0;
  while (cursor <= options.toBlock) {
    if (result.requests >= maxRequests) { result.failure = `request budget ${maxRequests} exhausted at block ${cursor}`; break; }
    if (performance.now() - started > maxMs) { result.failure = `time budget exhausted at block ${cursor}`; break; }
    const use = uses[endpointIndex];
    if (use === undefined || use.abandonedAt !== null) { result.failure = `all endpoints abandoned at block ${cursor}`; break; }
    const to = Math.min(options.toBlock, cursor + span - 1);
    const call = await rpc(transport, use.url, 'eth_getLogs', getLogsParams(cursor, to, options.filter ?? CANONICAL), rpcLogsSchema);
    result.requests += call.http.attempts;
    use.requests += call.http.attempts;
    result.responseBytes += call.http.responseBytes;
    result.requestBytes += call.http.requestBytes;
    result.fetchMs += call.http.ms;
    if (call.error === null && call.result !== null) {
      for (const log of call.result) {
        const id = logKey(log);
        if (!seen.has(id)) { seen.add(id); result.logs.push(log); }
      }
      result.okRequests++;
      use.ok++;
      const bucket = String(2 ** Math.floor(Math.log2(to - cursor + 1)));
      result.spanHistogram[bucket] = (result.spanHistogram[bucket] ?? 0) + 1;
      cursor = to + 1;
      result.checkpoint = cursor;
      result.totalMs = performance.now() - started;
      options.onCheckpoint?.(cursor, result.logs.length, result);
      attemptsHere = 0;
      if (++streak >= growAfter) {
        const cap = Math.min(maxSpan, use.learnedMaxSpan ?? Number.MAX_SAFE_INTEGER);
        span = Math.min(cap, span * 2);
        streak = 0;
      }
      continue;
    }
    const kind = call.error?.kind ?? 'other';
    use.errors[kind] = (use.errors[kind] ?? 0) + 1;
    use.errorSamples[kind] ??= `[${to - cursor + 1} blocks] ${call.error?.message.slice(0, 160) ?? ''}`;
    streak = 0;
    if (SHRINK.includes(kind) && to - cursor + 1 > minSpan) {
      const tried = to - cursor + 1;
      const hint = call.error?.limitHint ?? null;
      // Prefer a limit the server told us about; otherwise halve.
      span = Math.max(minSpan, hint !== null && hint < tried ? hint : Math.floor(tried / 2));
      if (kind !== 'timeout') use.learnedMaxSpan = Math.min(use.learnedMaxSpan ?? Number.MAX_SAFE_INTEGER, Math.max(minSpan, tried - 1, span));
      if (kind !== 'timeout' && hint !== null && hint < tried) use.learnedMaxSpan = hint;
      if (use.learnedMaxSpan !== null && use.learnedMaxSpan < preferSpan && use.deprioritizedAt === null
        && uses.some((other, i) => i !== endpointIndex && other.abandonedAt === null && other.deprioritizedAt === null)) {
        nextEndpoint(`learned span ${use.learnedMaxSpan} < ${preferSpan}`, false);
      }
      continue;
    }
    if (RETRY.includes(kind) && attemptsHere < retries) {
      attemptsHere++;
      await sleep(backoffMs * 2 ** (attemptsHere - 1));
      continue;
    }
    attemptsHere = 0;
    if (!nextEndpoint(`${kind}: ${call.error?.message.slice(0, 120) ?? ''}`)) {
      result.failure = `all endpoints failed at block ${cursor}; last error ${kind}: ${call.error?.message.slice(0, 160)}`;
      break;
    }
  }
  result.success = result.failure === null && cursor > options.toBlock;
  result.totalMs = performance.now() - started;
  result.logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return result;
}

export interface KeyedLog { key: string; tx: string }

export interface SetComparison {
  reference: number; candidate: number; matched: number;
  missing: string[]; extra: string[];
  txMismatch: string[];      // same block:logIndex, different tx hash
  referenceTxMissing: number; // reference rows without a tx hash (not comparable on tx)
  exact: boolean;            // same block:logIndex set and every comparable tx hash equal
  exactOnTxHash: boolean;    // exact, and every reference row carried a tx hash
}

/** Compares two log sets on block:logIndex, then checks tx hashes where both sides have one. */
export function compareSets(reference: KeyedLog[], candidate: KeyedLog[]): SetComparison {
  const ref = new Map(reference.map(entry => [entry.key, entry.tx.toLowerCase()]));
  const cand = new Map(candidate.map(entry => [entry.key, entry.tx.toLowerCase()]));
  const missing = [...ref.keys()].filter(key => !cand.has(key));
  const extra = [...cand.keys()].filter(key => !ref.has(key));
  const txMismatch: string[] = [];
  let referenceTxMissing = 0;
  for (const [key, tx] of ref) {
    const other = cand.get(key);
    if (other === undefined) continue;
    if (tx === '' ) { referenceTxMissing++; continue; }
    if (other !== '' && other !== tx) txMismatch.push(key);
  }
  const exact = missing.length === 0 && extra.length === 0 && txMismatch.length === 0;
  return {
    reference: ref.size, candidate: cand.size, matched: ref.size - missing.length,
    missing: missing.slice(0, 20), extra: extra.slice(0, 20), txMismatch: txMismatch.slice(0, 20), referenceTxMissing,
    exact, exactOnTxHash: exact && referenceTxMissing === 0,
  };
}

export function parseKeyed(row: string): KeyedLog & { blockNumber: number } {
  const [block, index, tx] = row.split(':');
  return { key: `${block}:${index}`, tx: tx ?? '', blockNumber: Number(block) };
}
export const formatKeyed = (log: { blockNumber: number; logIndex: number; transactionHash: string }) => `${log.blockNumber}:${log.logIndex}:${log.transactionHash.toLowerCase()}`;
