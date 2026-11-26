/**
 * Polite keyless HTTP for phase 3: one generic User-Agent, a per-host minimum
 * request interval (default 250 ms = 4 req/s), Retry-After-aware backoff on 429,
 * a hard timeout, byte and latency accounting, and Cloudflare-challenge
 * detection (recorded as "blocked", never worked around).
 */

export const USER_AGENT = 'erc5564-scan-benchmark/phase3 (public keyless log-retrieval study)';

export interface HttpResult {
  url: string;
  status: number;            // 0 = network error / timeout
  ok: boolean;
  ms: number;
  requestBytes: number;
  responseBytes: number;     // body after content decoding
  contentLength: string | null;
  contentEncoding: string | null;
  retryAfter: string | null;
  lastModified: string | null;
  text: string;
  networkError: string | null;
  cloudflareChallenge: boolean;
  rateLimited: boolean;      // final attempt was 429
  attempts: number;
  rateLimitHits: number;     // 429s seen across attempts
}

export interface Transport {
  request(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<HttpResult>;
}

export function isCloudflareChallenge(status: number, headers: Headers | null, text: string): boolean {
  if (headers?.get('cf-mitigated') === 'challenge') return true;
  return (status === 403 || status === 503 || status === 429 || status === 200)
    && /<title>Just a moment\.\.\.<\/title>|challenges\.cloudflare\.com|_cf_chl_opt/.test(text.slice(0, 4000));
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface PoliteOptions {
  minIntervalMs?: number;    // per host
  timeoutMs?: number;
  max429Retries?: number;
  maxBackoffMs?: number;
}

/** Real network transport. Not used by tests. */
export class PoliteHttp implements Transport {
  private readonly nextSlot = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly max429Retries: number;
  private readonly maxBackoffMs: number;

  constructor(options: PoliteOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.max429Retries = options.max429Retries ?? 3;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  private async slot(host: string, extraDelayMs = 0): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot.get(host) ?? 0) + extraDelayMs;
    this.nextSlot.set(host, at + this.minIntervalMs);
    if (at > now) await sleep(at - now);
  }

  async request(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<HttpResult> {
    const host = new URL(url).host;
    let rateLimitHits = 0;
    let backoff = 0;
    for (let attempt = 1; ; attempt++) {
      await this.slot(host, backoff);
      const result = await this.once(url, init);
      result.attempts = attempt;
      if (result.status === 429 && !result.cloudflareChallenge) {
        rateLimitHits++;
        result.rateLimitHits = rateLimitHits;
        if (attempt > this.max429Retries) return result;
        const hinted = parseRetryAfter(result.retryAfter);
        backoff = Math.min(this.maxBackoffMs, hinted ?? 1000 * 2 ** (attempt - 1));
        continue;
      }
      result.rateLimitHits = rateLimitHits;
      return result;
    }
  }

  private async once(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<HttpResult> {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const requestBytes = init.body === undefined ? 0 : new TextEncoder().encode(init.body).byteLength;
    const start = performance.now();
    try {
      const response = await fetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const ms = performance.now() - start;
      const text = new TextDecoder().decode(bytes);
      const challenge = isCloudflareChallenge(response.status, response.headers, text);
      return {
        url, status: response.status, ok: response.ok && !challenge, ms, requestBytes,
        responseBytes: bytes.byteLength,
        contentLength: response.headers.get('content-length'),
        contentEncoding: response.headers.get('content-encoding'),
        retryAfter: response.headers.get('retry-after'),
        lastModified: response.headers.get('last-modified'),
        text, networkError: null, cloudflareChallenge: challenge,
        rateLimited: response.status === 429, attempts: 1, rateLimitHits: 0,
      };
    } catch (error) {
      const ms = performance.now() - start;
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      return {
        url, status: 0, ok: false, ms, requestBytes, responseBytes: 0, contentLength: null,
        contentEncoding: null, retryAfter: null, lastModified: null, text: '',
        networkError: name === 'TimeoutError' ? `timeout after ${this.timeoutMs} ms` : `${name}: ${message}`.slice(0, 300),
        cloudflareChallenge: false, rateLimited: false, attempts: 1, rateLimitHits: 0,
      };
    }
  }
}
