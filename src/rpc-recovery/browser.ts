import { filter, hex, identity, scope, type LogIdentity, type Window } from './config.ts';

export type RawLog = LogIdentity & {
  address: string;
  topics: string[];
  data: string;
  transactionIndex: string;
  removed?: boolean;
};
type RequestSample = {
  request: { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };
  endpoint: string; elapsedMs: number; status?: number; body?: string; bodyBytes?: number;
  requestBytes: number; error?: { kind: string; message: string };
};
const utf8 = new TextEncoder();
let requestSamples: RequestSample[] = [];

async function call<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const request = { jsonrpc: '2.0' as const, id: requestSamples.length + 1, method, params };
  const payload = JSON.stringify(request);
  const sample: RequestSample = { request, endpoint, requestBytes: utf8.encode(payload).length, elapsedMs: 0 };
  requestSamples.push(sample);
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

type Mode = 'probe' | 'single' | 'cross' | 'resume';
interface Input {
  name: string;
  mode: Mode;
  reference: { windows: Window[]; identities: string[]; headHash: string };
  endpoints: string[];
}
interface Checkpoint {
  next: number;
  observed: string[];
}
type Vote = { endpoint: string; ids: string[]; error?: undefined } |
  { endpoint: string; ids?: undefined; error: string };

async function controls(url: string) {
  requestSamples = [];
  for (const path of ['allow', 'deny']) {
    try {
      await call(`${url}/${path}`, 'eth_chainId', []);
    } catch {
      // Raw samples preserve the rejection.
    }
  }
  return requestSamples;
}

async function run({ name, mode, reference, endpoints }: Input) {
  requestSamples = [];
  performance.clearResourceTimings();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const key = `rpc-recovery:${name}`;
  if (mode !== 'resume') localStorage.removeItem(key);
  const checkpoint: Checkpoint = JSON.parse(localStorage.getItem(key) ?? '{"next":0,"observed":[]}');
  const initialNext = checkpoint.next;
  const lastStarts = new Map<string, number>();
  const invoke = async <T>(endpoint: string, method: string, params: unknown[]) => {
    // Pace public hosts only.
    if (!endpoint.startsWith('http://127.0.0.1:')) {
      const delay = (lastStarts.get(endpoint) ?? 0) + 270 - performance.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
    lastStarts.set(endpoint, performance.now());
    return call<T>(endpoint, method, params);
  };
  const healthy = new Map<string, boolean>();
  const initialization = await Promise.all(endpoints.map(async endpoint => {
    try {
      if (await invoke(endpoint, 'eth_chainId', []) !== scope.chainId) throw new Error('Wrong chain');
      const head = await invoke<{ hash: string; number: string }>(
        endpoint, 'eth_getBlockByNumber', [hex(scope.head), false]);
      if (Number(head.number) !== scope.head || head.hash.toLowerCase() !== reference.headHash) {
        throw new Error('Pinned head mismatch');
      }
      healthy.set(endpoint, true);
      return { endpoint, error: null };
    } catch (error) {
      return { endpoint, error: String(error) };
    }
  }));

  const vote = async (endpoint: string, window: Window): Promise<Vote> => {
    try {
      if (!healthy.get(endpoint)) throw new Error('Source initialization failed');
      const query = filter(window.from, window.to);
      const raw = await invoke<RawLog[]>(endpoint, 'eth_getLogs', [query]);
      const ids = raw.map(log => {
        const block = Number(log.blockNumber);
        if (!Number.isSafeInteger(block) || block < window.from || block > window.to || log.removed ||
            log.address.toLowerCase() !== query.address || log.topics[0]?.toLowerCase() !== query.topics[0] ||
            !/^0x[0-9a-f]{64}$/i.test(log.blockHash) || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash) ||
            !/^0x[0-9a-f]+$/i.test(log.logIndex) || !Number.isSafeInteger(Number(log.logIndex))) {
          throw new Error('Invalid log identity or filter mismatch');
        }
        return identity(log);
      }).sort();
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate log identity');
      return { endpoint, ids };
    } catch (error) {
      return { endpoint, error: String(error) };
    }
  };
  const windows = [];
  const probeObserved: string[] = [];
  let stop: string | null = null;
  for (let index = initialNext; index < reference.windows.length; index++) {
    const window = reference.windows[index]!;
    const before = checkpoint.next;
    const first = endpoints.slice(0, mode === 'single' || mode === 'probe' ? 1 : 2);
    const votes = await Promise.all(first.map(endpoint => vote(endpoint, window)));
    const agree = () => votes.find((a, index) => a.ids && votes.slice(index + 1)
      .some(b => b.ids && JSON.stringify(a.ids) === JSON.stringify(b.ids)))?.ids;
    const initial = first.length === 1 ? (votes[0]?.error ? 'error' : 'single') :
      votes.some(vote => vote.error) ? 'error' : agree() ? 'agreement' : 'mismatch';
    if (first.length === 2 && initial !== 'agreement' && endpoints[2]) {
      votes.push(await vote(endpoints[2], window));
    }
    const accepted = first.length === 1 ? votes[0]?.ids : agree();
    if (mode === 'probe') {
      probeObserved.push(...(accepted ?? []));
    } else if (accepted) {
      checkpoint.observed.push(...accepted);
      checkpoint.next = index + 1;
      localStorage.setItem(key, JSON.stringify(checkpoint));
    } else {
      stop = first.length === 1 ? 'primary error' : 'no agreeing successful pair';
    }
    windows.push({ ...window, index, before, after: checkpoint.next, initial, votes, accepted, stop });
    if (stop) break;
  }
  const elapsedMs = performance.now() - start;
  const reachedEnd = checkpoint.next === reference.windows.length && !stop;
  const observed = mode === 'probe' ? probeObserved : checkpoint.observed;
  const observedSet = new Set(observed);
  const expected = new Set(reference.identities);
  return {
    name, mode, startedAt, userAgent: navigator.userAgent, endpoints, initialization,
    initialNext, checkpoint, stop, reachedEnd, elapsedMs, catchUpMs: reachedEnd ? elapsedMs : null,
    requestCount: requestSamples.length, windows, requests: requestSamples,
    resourceTimings: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
    observed, missing: [...expected].filter(id => !observedSet.has(id)),
    extra: [...observedSet].filter(id => !expected.has(id)), duplicates: observed.length - observedSet.size,
  };
}
Object.assign(globalThis, { recovery: { run, controls } });
