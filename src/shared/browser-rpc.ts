/// <reference lib="dom" />
// Bundled into the browser harnesses. Keep it free of Node and zod imports.

export type RequestSample = {
  request: { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };
  endpoint?: string; elapsedMs: number; status?: number; body?: string; bodyBytes?: number;
  requestBytes: number; error?: { kind: string; message: string };
};

/**
 * JSON-RPC over browser fetch that records every request, response body and failure kind.
 * `recordEndpoint` adds the endpoint to each sample, for harnesses that use several providers.
 */
export function rpcRecorder({ recordEndpoint = false } = {}) {
  const utf8 = new TextEncoder();
  let samples: RequestSample[] = [];

  async function call<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
    const request = { jsonrpc: '2.0' as const, id: samples.length + 1, method, params };
    const payload = JSON.stringify(request);
    const sample: RequestSample = {
      request, ...(recordEndpoint ? { endpoint } : {}), requestBytes: utf8.encode(payload).length, elapsedMs: 0,
    };
    samples.push(sample);
    const start = performance.now();
    const signal = AbortSignal.timeout(12_000);
    let kind = 'fetch-rejection';
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        mode: 'cors', credentials: 'omit', cache: 'no-store', signal, body: payload,
      });
      sample.status = response.status;
      kind = 'body-read-error';
      const bytes = await response.arrayBuffer();
      sample.elapsedMs = performance.now() - start;
      sample.bodyBytes = bytes.byteLength;
      sample.body = new TextDecoder().decode(bytes);
      kind = 'http-error';
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      kind = 'invalid-response';
      const json = JSON.parse(sample.body);
      if (json.jsonrpc !== '2.0' || json.id !== request.id) throw new Error('Invalid JSON-RPC envelope');
      if (json.error) {
        kind = 'rpc-error';
        throw new Error(JSON.stringify(json.error));
      }
      if (!Object.hasOwn(json, 'result')) throw new Error('Missing result');
      return json.result;
    } catch (error) {
      if (sample.elapsedMs === 0) sample.elapsedMs = performance.now() - start;
      sample.error = { kind: signal.aborted ? 'timeout' : kind, message: String(error) };
      throw new Error(sample.error.message);
    }
  }

  /** CORS controls: one call each to the local `allow` and `deny` routes. Raw samples keep the rejection. */
  async function controls(url: string): Promise<RequestSample[]> {
    samples = [];
    for (const path of ['allow', 'deny']) {
      try {
        await call(`${url}/${path}`, 'eth_chainId', []);
      } catch {
        // Recorded in the sample.
      }
    }
    return samples;
  }

  return {
    call, controls,
    reset() { samples = []; },
    get samples() { return samples; },
  };
}
