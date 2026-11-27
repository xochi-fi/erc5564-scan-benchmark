import { z } from 'zod';
import type { HttpResult, Transport } from './http.ts';

import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';
export { ANNOUNCEMENT_TOPIC, ANNOUNCER };

export type ErrorKind =
  | 'range-limit'      // block range too large
  | 'result-limit'     // too many results / response too big
  | 'rate-limit'       // 429 or rate/quota message
  | 'archive-missing'  // pruned / missing state or historical data
  | 'auth-required'    // key, token or plan required
  | 'unsupported'      // method not available / not whitelisted
  | 'timeout'          // client or server timeout
  | 'blocked'          // Cloudflare or similar challenge
  | 'http'             // other non-2xx
  | 'invalid-response' // not JSON-RPC / wrong shape
  | 'other';

export interface RpcError {
  kind: ErrorKind;
  code: number | null;
  message: string;       // truncated
  httpStatus: number;
  limitHint: number | null; // a number parsed from a range-limit message, if any
}

export interface RpcCall<T> {
  result: T | null;
  error: RpcError | null;
  http: HttpResult;
}

const envelopeSchema = z.object({
  jsonrpc: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional(), data: z.unknown().optional() }).passthrough().optional(),
}).passthrough();

const RANGE_PATTERNS = [
  /block range/i, /range (is )?too (large|wide|big)/i, /exceed(s|ed)? .*range/i, /range.*exceed/i,
  /max(imum)? (block )?range/i, /blocks? range/i, /too many blocks/i, /range limit/i,
  /block range limit/i, /eth_getLogs.*limited to/i, /limited to a \d+ block range/i,
  /query exceeds max block range/i, /fromBlock.*toBlock/i, /block (count|span)/i,
  /up to a \d+ block range/i, /range should work/i, /requested too many blocks/i,
  /logs are limited/i, /exceeds the limit/i, /distance between/i, /requested range is over limit/i, /limited to \d+ blocks/i, /ranges? over \d+ blocks/i, /query spans \d+ blocks/i,
];
const RESULT_PATTERNS = [/too many (results|logs)/i, /more than \d+ (results|logs)/i, /response (size|is too)/i, /result (set|window) too large/i, /query returned more than/i, /max(imum)? results/i, /log response size exceeded/i];
const RATE_PATTERNS = [/rate.?limit/i, /too many requests/i, /request limit/i, /quota/i, /throttl/i, /capacity/i, /exceeded the daily/i, /credits/i];
const ARCHIVE_PATTERNS = [/missing trie node/i, /pruned/i, /historical (state|data|block)/i, /archive/i, /state.*not found/i, /header not found/i, /block not found/i, /unknown block/i, /beyond (the )?(current )?head/i, /no (historical )?data/i, /older than/i];
const AUTH_PATTERNS = [/api.?key/i, /unauthori[sz]ed/i, /forbidden/i, /upgrade/i, /paid/i, /plan/i, /sign.?up/i, /token/i, /authenticat/i, /not allowed/i, /whitelist/i, /premium/i, /unregistered/i, /register/i];
const UNSUPPORTED_PATTERNS = [/method not (found|supported|available)/i, /method .{0,40}(is )?not (available|supported|allowed)/i, /does not exist/i, /not supported/i, /unsupported/i, /is not available/i];
const TIMEOUT_PATTERNS = [/timeout/i, /timed out/i, /deadline/i, /took too long/i, /execution aborted/i];

/** Extracts a block-count hint like "max is 10000" or "limited to a 1000 block range" from an error message. */
export function parseLimitHint(message: string): number | null {
  const patterns = [
    /(\d[\d,_]*)\s*-?\s*block(s)?\s*range/i,
    /range (?:is )?(?:limited to|of|up to|max(?:imum)?(?: is)?|exceeds?)\s*:?\s*(\d[\d,_]*)/i,
    /max(?:imum)?(?: block)?(?: range)?(?: is| of|:)?\s*(\d[\d,_]*)\s*blocks?/i,
    /(?:up to|limited to|maximum of|at most|max)\s+(\d[\d,_]*)\s*blocks?/i,
    /(\d[\d,_]*)\s*blocks? (?:max|limit|maximum)/i,
    /block range(?: is)? (?:too large|exceeds)[^\d]*(\d[\d,_]*)/i,
    /max(?:imum)? block range:?\s*(\d[\d,_]*)/i,
    /limited to a\s+(\d[\d,_]*)\s*range/i,
    /(?:over|exceeds?) (?:the )?limit of\s+(\d[\d,_]*)/i,
    /ranges? over\s+(\d[\d,_]*)\s*blocks/i,
    /but only\s+(\d[\d,_]*)\s*(?:blocks )?(?:are )?(?:allowed|permitted)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    const raw = match?.slice(1).find(group => group !== undefined && /\d/.test(group));
    if (raw !== undefined) {
      const value = Number(raw.replaceAll(/[,_]/g, ''));
      if (Number.isInteger(value) && value > 0 && value < 1e12) return value;
    }
  }
  return null;
}

export function classifyError(message: string, httpStatus: number, opts: { challenge?: boolean; networkError?: boolean } = {}): ErrorKind {
  if (opts.challenge) return 'blocked';
  if (opts.networkError) return /timeout/i.test(message) ? 'timeout' : 'http';
  // Some providers answer an over-wide range with HTTP 429 (e.g. "public eth_getLogs is limited to 1000 blocks").
  if (httpStatus === 429) return RANGE_PATTERNS.some(pattern => pattern.test(message)) && !/rate|too many requests/i.test(message) ? 'range-limit' : 'rate-limit';
  if (/cloudflare-1xxx-errors|error code: 10\d\d/i.test(message)) return 'blocked';
  const test = (patterns: RegExp[]) => patterns.some(pattern => pattern.test(message));
  // A lagging backend is a transient failure.
  if (/beyond (the )?current head|after last accepted|header not found|unknown block/i.test(message)) return 'other';
  // Check range and result limits before rate limits.
  if (test(RESULT_PATTERNS)) return 'result-limit';
  if (test(RANGE_PATTERNS)) return 'range-limit';
  if (test(RATE_PATTERNS)) return 'rate-limit';
  if (test(TIMEOUT_PATTERNS)) return 'timeout';
  // Keyless access limited to the newest N blocks, or archive gated behind a key/token.
  if (/(most recent|latest|last) \(?\d+\)? blocks|only serves recent|archive requests require|historical (queries|archive)|deep historical|pruned history/i.test(message)) return 'archive-missing';
  if (/unregistered|api.?key|paid plan|upgrade/i.test(message)) return 'auth-required';
  if (test(UNSUPPORTED_PATTERNS)) return 'unsupported';
  if (test(ARCHIVE_PATTERNS)) return 'archive-missing';
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403 || test(AUTH_PATTERNS)) return 'auth-required';
  if (httpStatus >= 500 && httpStatus <= 504 && message.length === 0) return 'http';
  if (httpStatus !== 0 && (httpStatus < 200 || httpStatus >= 300)) return 'http';
  return 'other';
}

function makeError(message: string, http: HttpResult, code: number | null): RpcError {
  const text = message.replaceAll(/\s+/g, ' ').trim().slice(0, 300);
  const kind = classifyError(text, http.status, { challenge: http.cloudflareChallenge, networkError: http.networkError !== null });
  return { kind, code, message: text, httpStatus: http.status, limitHint: kind === 'range-limit' ? parseLimitHint(text) : null };
}

/** Interprets one HTTP exchange as a JSON-RPC response. Pure; used by tests with recorded fixtures. */
export function interpretRpc<T>(http: HttpResult, schema: z.ZodType<T>): RpcCall<T> {
  if (http.cloudflareChallenge) return { result: null, error: makeError('Cloudflare challenge page', http, null), http };
  if (http.networkError !== null) return { result: null, error: makeError(http.networkError, http, null), http };
  let json: unknown;
  try {
    json = JSON.parse(http.text);
  } catch {
    return { result: null, error: makeError(http.status === 200 ? `non-JSON body: ${http.text.slice(0, 120)}` : `HTTP ${http.status}: ${http.text.slice(0, 160)}`, http, null), http };
  }
  if (Array.isArray(json)) json = json[0];
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { result: null, error: makeError(`HTTP ${http.status}: invalid JSON-RPC envelope ${http.text.slice(0, 120)}`, http, null), http };
  const { error } = envelope.data;
  if (error !== undefined) {
    const data = typeof error.data === 'string' ? ` (${error.data})` : '';
    return { result: null, error: makeError(`${error.message ?? 'error'}${data}`, http, error.code ?? null), http };
  }
  if (!http.ok) return { result: null, error: makeError(`HTTP ${http.status}: ${http.text.slice(0, 160)}`, http, null), http };
  if (!('result' in envelope.data)) return { result: null, error: makeError('missing result', http, null), http };
  const parsed = schema.safeParse(envelope.data.result);
  if (!parsed.success) {
    const kind = envelope.data.result === null ? 'result is null' : `unexpected result shape: ${JSON.stringify(envelope.data.result).slice(0, 120)}`;
    return { result: null, error: { ...makeError(kind, http, null), kind: 'invalid-response' }, http };
  }
  return { result: parsed.data, error: null, http };
}

let nextId = 1;
export async function rpc<T>(transport: Transport, url: string, method: string, params: unknown[], schema: z.ZodType<T>): Promise<RpcCall<T>> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  const http = await transport.request(url, { method: 'POST', body });
  return interpretRpc(http, schema);
}

export const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
export const quantity = z.string().regex(/^0x[0-9a-fA-F]+$/).transform(value => Number(BigInt(value)));
export const rpcLogSchema = z.object({
  address: hex,
  blockHash: hex,
  blockNumber: quantity,
  data: hex,
  logIndex: quantity,
  removed: z.boolean().optional(),
  topics: z.array(hex),
  transactionHash: hex,
  transactionIndex: quantity,
  blockTimestamp: quantity.optional(),
}).passthrough();
export type RpcLog = z.infer<typeof rpcLogSchema>;
export const rpcLogsSchema = z.array(rpcLogSchema);

export const toHex = (value: number) => `0x${value.toString(16)}`;

export interface LogFilter { address: string; topic0: string }
export const CANONICAL: LogFilter = { address: ANNOUNCER, topic0: ANNOUNCEMENT_TOPIC };
/** Umbra's own contract (same CREATE2 address on each chain it supports) and its pre-ERC-5564 Announcement event. */
export const UMBRA: LogFilter = {
  address: '0xfb2dc580eed955b528407b4d36ffafe3da685401',
  topic0: '0x29877766fa2bfe3b90008d6d92f965eca91cbc5757ed775740e460799fb92219', // Announcement(address,uint256,address,bytes32,bytes32)
};

export function getLogsParams(fromBlock: number, toBlock: number, filter: LogFilter = CANONICAL) {
  return [{ address: filter.address, topics: [filter.topic0], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }];
}

/** Set key used across sources: block number + log index (unique per chain); tx hashes are compared separately. */
export function logKey(log: { blockNumber: number; logIndex: number }): string {
  return `${log.blockNumber}:${log.logIndex}`;
}
