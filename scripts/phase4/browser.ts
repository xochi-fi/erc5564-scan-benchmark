/// <reference lib="dom" />
import { ERC5564AnnouncerAbi, getAnnouncementsForUser, type AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { decodeEventLog, type Hex } from 'viem';
import { filter, hex, identity, scope, type LogIdentity } from './config.ts';

export type RawLog = LogIdentity & {
  address: Hex;
  topics: [Hex, ...Hex[]];
  data: Hex;
  transactionIndex: string;
  removed?: boolean;
};
export interface Input {
  endpoint: string;
  mode: 'fresh' | 'resume';
  repetition: number;
  fixture: { recipient: Pick<Parameters<typeof getAnnouncementsForUser>[0], 'spendingPublicKey' | 'viewingPrivateKey'>;
    rows: { block: number; raw: RawLog; expected: boolean }[] };
  reference: { headHash: string; identities: string[] };
}
type RequestSample = {
  request: { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };
  elapsedMs: number; status?: number; body?: string; bodyBytes?: number;
  requestBytes: number; error?: { kind: string; message: string };
};
const utf8 = new TextEncoder();
let requestSamples: RequestSample[] = [];

async function call<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const request = { jsonrpc: '2.0' as const, id: requestSamples.length + 1, method, params };
  const payload = JSON.stringify(request);
  const sample: RequestSample = { request, requestBytes: utf8.encode(payload).length, elapsedMs: 0 };
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

function decode(raw: RawLog): AnnouncementLog {
  const { args } = decodeEventLog({
    abi: ERC5564AnnouncerAbi, eventName: 'Announcement', data: raw.data, topics: raw.topics, strict: true,
  });
  return {
    ...raw, ...args, blockHash: raw.blockHash as Hex, transactionHash: raw.transactionHash as Hex,
    blockNumber: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex),
    transactionIndex: Number(raw.transactionIndex), removed: raw.removed ?? false,
  };
}
const matchKey = (announcement: AnnouncementLog) => announcement.transactionHash;
const storageKey = 'phase4-checkpoint';

async function run(input: Input) {
  const { endpoint, mode, reference, fixture, repetition } = input;
  performance.clearResourceTimings();
  requestSamples = [];
  localStorage.removeItem(storageKey);
  if (mode === 'resume') localStorage.setItem(storageKey, String(scope.saved));
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const initialCheckpoint = Number(localStorage.getItem(storageKey) ?? scope.start - 1);
  const fromBlock = initialCheckpoint + 1;
  const pages: { from: number; to: number; logs: number; scanMs: number; fixtureMatches: (string | null)[] }[] = [];
  const realIds: string[] = [];
  const realMatches: (string | null)[] = [];
  const fixtureMatches: (string | null)[] = [];
  let firstFixtureMatchMs: number | null = null;
  let firstRealMatchMs: number | null = null;
  let checkpoint = initialCheckpoint;
  let checkedHead = false;
  let failure: string | null = null;
  try {
    if (await call(endpoint, 'eth_chainId', []) !== scope.chainId) throw new Error('Wrong chain');
    const head = await call<{ hash: string; number: string }>(endpoint, 'eth_getBlockByNumber', [hex(scope.head), false]);
    if (Number(head.number) !== scope.head || head.hash.toLowerCase() !== reference.headHash) throw new Error('Wrong fixed head');
    checkedHead = true;
    for (let from = fromBlock; from <= scope.head; from += scope.pageBlocks) {
      const to = Math.min(from + scope.pageBlocks - 1, scope.head);
      const query = filter(from, to);
      const rows = await call<RawLog[]>(endpoint, 'eth_getLogs', [query]);
      const scanStart = performance.now();
      for (const log of rows) {
        const block = Number(log.blockNumber);
        if (block < from || block > to || log.removed ||
            log.address.toLowerCase() !== query.address || log.topics[0]?.toLowerCase() !== query.topics[0]) {
          throw new Error('Browser log outside filter');
        }
        realIds.push(identity(log));
      }
      const scan = (logs: RawLog[]) => getAnnouncementsForUser({ ...fixture.recipient, announcements: logs.map(decode) });
      const pageReal = (await scan(rows)).map(matchKey);
      if (pageReal.length && firstRealMatchMs === null) firstRealMatchMs = performance.now() - start;
      realMatches.push(...pageReal);
      const controls = fixture.rows.filter(({ block }) => from <= block && block <= to);
      const pageFixtures = (await scan(controls.map(({ raw }) => raw))).map(matchKey);
      if (pageFixtures.length && firstFixtureMatchMs === null) firstFixtureMatchMs = performance.now() - start;
      fixtureMatches.push(...pageFixtures);
      pages.push({ from, to, logs: rows.length, scanMs: performance.now() - scanStart, fixtureMatches: pageFixtures });
      localStorage.setItem(storageKey, String(to));
      checkpoint = to;
    }
  } catch (error) {
    failure = String(error);
  }
  const elapsedMs = performance.now() - start;
  const inRange = (id: string, to: number) => {
    const block = Number(id.split(':', 1)[0]);
    return block >= fromBlock && block <= to;
  };
  const expected = reference.identities.filter(id => inRange(id, scope.head));
  const missing = expected.filter(id => !realIds.includes(id));
  const extra = [...new Set(realIds.filter(id => !expected.includes(id)))];
  const duplicateCount = realIds.length - new Set(realIds).size;
  const fixtureExpected = fixture.rows.filter(({ block, expected }) => expected && block >= fromBlock && block <= checkpoint)
    .map(({ raw }) => raw.transactionHash).sort();
  const fixtureExact = JSON.stringify([...fixtureMatches].sort()) === JSON.stringify(fixtureExpected);
  const reachedHead = checkedHead && checkpoint === scope.head && failure === null;
  return {
    origin: location.origin, userAgent: navigator.userAgent, startedAt, endpoint, mode, repetition,
    initialCheckpoint, fromBlock, head: scope.head, checkedHead, checkpoint, reachedHead, failure,
    elapsedMs, firstFixtureMatchMs, firstRealMatchMs, catchUpMs: reachedHead ? elapsedMs : null,
    requestCount: requestSamples.length,
    networkMs: requestSamples.reduce((sum, sample) => sum + sample.elapsedMs, 0),
    networkResources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
    pages, requests: requestSamples,
    fixtureMatches, fixtureExpected, fixtureExact, realMatches,
    completeness: {
      expected, observed: realIds, missing, extra, duplicateCount,
      expectedInCheckpointedRange: expected.filter(id => inRange(id, checkpoint)),
      exact: reachedHead && missing.length === 0 && extra.length === 0 && duplicateCount === 0,
    },
  };
}

async function controls(url: string) {
  requestSamples = [];
  for (const path of ['allow', 'deny']) {
    try {
      await call(`${url}/${path}`, 'eth_chainId', []);
    } catch {
      // The raw result records the rejection.
    }
  }
  return requestSamples;
}
Object.assign(globalThis, { phase4: { run, controls } });
