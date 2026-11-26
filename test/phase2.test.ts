import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { generateFixture, loadFixture } from '../src/fixtures.ts';
import type { Engine, LoadedFixture, Recipient } from '../src/model.ts';
import { announcementIdentity } from '../src/worker.ts';
import { FIRST_BLOCK, indexFixture, metadataAmount } from '../src/phase2/chain.ts';
import { startChain, type RunningChain } from '../src/phase2/chain-server.ts';
import { startLinkEmulator } from '../src/phase2/link.ts';
import { LINK_PROFILES, type ExpectedFile, type LinkProfile } from '../src/phase2/model.ts';
import { expectedIdentities, summaryRow, toCsv } from '../src/phase2/sweep.ts';
import { buildPlan, matrixSettings, spread, type Setting } from '../src/phase2/repeat.ts';
import {
  RpcClient,
  assertMatchIdentities,
  decodeAnnouncements,
  rawLogsSchema,
  readCache,
  syncWallet,
  verifyCandidate,
} from '../src/phase2/wallet.ts';
import { z } from 'zod';

// 300 announcements = 3 blocks (128, 128, 44); matches at 0, 7, 14, ... (43 matches).
const COUNT = 300;
const MATCH_EVERY = 7;
let directory = '';
let fixtureDir = '';
let zeroDir = '';
let fixture: LoadedFixture;
let expected: ExpectedFile;
let recipient: Recipient;
let chain: RunningChain;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'phase2-test-'));
  fixtureDir = join(directory, 'sparse');
  zeroDir = join(directory, 'zero');
  await generateFixture(fixtureDir, { count: COUNT, seed: 'phase2-test', matchEvery: MATCH_EVERY });
  await generateFixture(zeroDir, { count: 130, seed: 'phase2-test-zero', matchEvery: 0 });
  fixture = await loadFixture(fixtureDir);
  expected = await expectedIdentities(fixtureDir);
  recipient = fixture.manifest.recipient;
  chain = await startChain(fixtureDir, LINK_PROFILES.none);
});

afterAll(async () => {
  await chain?.stop();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

function expectedFromLoader(): string[] {
  return fixture.manifest.expectedIndices.map((index) => {
    const announcement = fixture.announcements[index];
    if (announcement === undefined) throw new Error('bad index');
    return announcementIdentity(announcement);
  });
}

async function setHead(head: number | null): Promise<void> {
  const response = await fetch(new URL('head', chain.endpoints.controlUrl), { method: 'POST', body: JSON.stringify({ head }) });
  expect(response.ok).toBe(true);
}

describe('expected-identity oracle', () => {
  test('matches identities from the phase-1 loader', () => {
    expect(expected.matches.map(match => match.identity)).toEqual(expectedFromLoader());
    expect(expected.matches).toHaveLength(Math.floor((COUNT - 1) / MATCH_EVERY) + 1);
  });
});

describe('synthetic chain', () => {
  test('rejects a fixture whose bytes differ from the manifest', async () => {
    const corrupt = join(directory, 'corrupt');
    await mkdir(corrupt);
    await copyFile(join(fixtureDir, 'manifest.json'), join(corrupt, 'manifest.json'));
    await copyFile(join(fixtureDir, 'announcements.jsonl'), join(corrupt, 'announcements.jsonl'));
    await appendFile(join(corrupt, 'announcements.jsonl'), ' ');
    await expect(indexFixture(corrupt)).rejects.toThrow();
  });

  test('eth_getLogs returns exactly the fixture logs of the requested block range', async () => {
    const client = new RpcClient(chain.endpoints.rpcUrl);
    const all = await client.call('eth_getLogs', [{ fromBlock: `0x${FIRST_BLOCK.toString(16)}`, toBlock: 'latest' }], rawLogsSchema);
    const decoded = decodeAnnouncements(all.result);
    expect(decoded.map(announcementIdentity)).toEqual(fixture.announcements.map(announcementIdentity));
    expect(decoded.map(a => a.ephemeralPubKey)).toEqual(fixture.announcements.map(a => a.ephemeralPubKey));
    const second = await client.call('eth_getLogs', [{ fromBlock: `0x${(FIRST_BLOCK + 1).toString(16)}`, toBlock: `0x${(FIRST_BLOCK + 1).toString(16)}` }], rawLogsSchema);
    expect(second.result).toHaveLength(128);
    expect(Number(BigInt(second.result[0]?.blockNumber ?? '0x0'))).toBe(FIRST_BLOCK + 1);
    const last = await client.call('eth_getLogs', [{ fromBlock: `0x${(FIRST_BLOCK + 2).toString(16)}`, toBlock: `0x${(FIRST_BLOCK + 9).toString(16)}` }], rawLogsSchema);
    expect(last.result).toHaveLength(COUNT - 256);
  });

  test('filters by announcer address and topic, and respects the head', async () => {
    const client = new RpcClient(chain.endpoints.rpcUrl);
    const other = await client.call('eth_getLogs', [{ address: '0x0000000000000000000000000000000000000002', fromBlock: '0x0', toBlock: 'latest' }], rawLogsSchema);
    expect(other.result).toEqual([]);
    await setHead(FIRST_BLOCK);
    try {
      const head = await client.call('eth_blockNumber', [], z.string());
      expect(Number(BigInt(head.result))).toBe(FIRST_BLOCK);
      const capped = await client.call('eth_getLogs', [{ fromBlock: '0x0', toBlock: `0x${(FIRST_BLOCK + 2).toString(16)}` }], rawLogsSchema);
      expect(capped.result).toHaveLength(128);
    } finally {
      await setHead(null);
    }
  });

  test('reports metadata amounts and unknown hashes', async () => {
    const first = fixture.announcements[0];
    if (first === undefined) throw new Error('empty fixture');
    expect(metadataAmount(first.data)).toBe(1_000_000_000_000_000n);
    const client = new RpcClient(chain.endpoints.rpcUrl);
    const missing = await client.call('eth_getTransactionReceipt', [`0x${'ab'.repeat(32)}`], z.null());
    expect(missing.result).toBeNull();
    await expect(client.call('eth_sendRawTransaction', ['0x00'], z.unknown())).rejects.toThrow('method not supported');
  });
});

describe('candidate verification', () => {
  test('confirms receipt inclusion and balance for a real match', async () => {
    const match = fixture.announcements[MATCH_EVERY];
    if (match === undefined) throw new Error('missing match');
    const result = await verifyCandidate(new RpcClient(chain.endpoints.rpcUrl), match);
    expect(result.match.identity).toBe(announcementIdentity(match));
    expect(result.match.amountWei).toBe('1000000000000000');
    expect(result.requestBodyBytes).toBeGreaterThan(0);
  });

  test('rejects candidates the chain does not confirm', async () => {
    const match = fixture.announcements[0];
    if (match === undefined) throw new Error('missing match');
    const client = new RpcClient(chain.endpoints.rpcUrl);
    await expect(verifyCandidate(client, { ...match, transactionHash: `0x${'cd'.repeat(32)}` as Hex })).rejects.toThrow('no receipt');
    await expect(verifyCandidate(client, { ...match, logIndex: 99 })).rejects.toThrow('not found in receipt');
    await expect(verifyCandidate(client, { ...match, blockHash: `0x${'00'.repeat(32)}` as Hex })).rejects.toThrow('reorg');
    await expect(verifyCandidate(client, { ...match, stealthAddress: '0x000000000000000000000000000000000000dEaD' })).rejects.toThrow('holds 0');
  });
});

const engines: Engine[] = ['sdk', 'crypto'];
describe('paged wallet sync', () => {
  for (const engine of engines) {
    for (const pageBlocks of [1, 2, 5]) {
      test(`${engine} cold sync with ${pageBlocks}-block pages finds every payment`, async () => {
        const cachePath = join(directory, `cold-${engine}-${pageBlocks}.json`);
        const result = await syncWallet({ client: new RpcClient(chain.endpoints.rpcUrl), recipient, engine, pageBlocks, startBlock: FIRST_BLOCK, cachePath, cache: null });
        assertMatchIdentities(result.cache.matches, expectedFromLoader());
        expect(result.pages).toHaveLength(Math.ceil(3 / pageBlocks));
        expect(result.pages.reduce((sum, page) => sum + page.logs, 0)).toBe(COUNT);
        expect(result.requests.receipts).toBe(expected.matches.length);
        expect(result.timings.firstVerifiedMs).not.toBeNull();
        expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.networkMs + result.timings.scanMs + result.timings.verifyMs);
        const persisted = await readCache(cachePath);
        expect(persisted?.lastScannedBlock).toBe(FIRST_BLOCK + 2);
        assertMatchIdentities(persisted?.matches ?? [], expectedFromLoader());
      });
    }
  }

  test('catch-up from a checkpoint scans only new blocks and ends with every payment', async () => {
    const cachePath = join(directory, 'catchup.json');
    const client = new RpcClient(chain.endpoints.rpcUrl);
    await setHead(FIRST_BLOCK);
    let prefix;
    try {
      prefix = await syncWallet({ client, recipient, engine: 'sdk', pageBlocks: 1, startBlock: FIRST_BLOCK, cachePath, cache: null });
    } finally {
      await setHead(null);
    }
    const prefixExpected = expected.matches.filter(m => m.blockNumber <= FIRST_BLOCK).map(m => m.identity);
    assertMatchIdentities(prefix.cache.matches, prefixExpected);
    const cache = await readCache(cachePath);
    const caughtUp = await syncWallet({ client, recipient, engine: 'crypto', pageBlocks: 1, startBlock: FIRST_BLOCK, cachePath, cache });
    expect(caughtUp.fromBlock).toBe(FIRST_BLOCK + 1);
    expect(caughtUp.pages.reduce((sum, page) => sum + page.logs, 0)).toBe(COUNT - 128);
    assertMatchIdentities(caughtUp.newMatches, expected.matches.filter(m => m.blockNumber > FIRST_BLOCK).map(m => m.identity));
    assertMatchIdentities(caughtUp.cache.matches, expectedFromLoader());
  });

  test('rejects a cache that belongs to another recipient', async () => {
    const cachePath = join(directory, 'foreign.json');
    await expect(syncWallet({
      client: new RpcClient(chain.endpoints.rpcUrl), recipient, engine: 'sdk', pageBlocks: 1, startBlock: FIRST_BLOCK, cachePath,
      cache: { schemaVersion: 1, spendingPublicKey: '0x02', startBlock: FIRST_BLOCK, lastScannedBlock: FIRST_BLOCK, matches: [] },
    })).rejects.toThrow('different recipient');
  });

  test('zero-match fixture returns no candidates and no verification calls', async () => {
    const zeroChain = await startChain(zeroDir, LINK_PROFILES.none);
    try {
      const zero = await loadFixture(zeroDir);
      const result = await syncWallet({ client: new RpcClient(zeroChain.endpoints.rpcUrl), recipient: zero.manifest.recipient, engine: 'sdk', pageBlocks: 1, startBlock: FIRST_BLOCK, cachePath: join(directory, 'zero.json'), cache: null });
      expect(result.cache.matches).toEqual([]);
      expect(result.requests.receipts).toBe(0);
      expect(result.timings.firstVerifiedMs).toBeNull();
    } finally {
      await zeroChain.stop();
    }
  });

  test('identity verification rejects a missing payment', () => {
    const identities = expectedFromLoader();
    expect(() => assertMatchIdentities([], identities)).toThrow('count mismatch');
  });
});

describe('link emulator', () => {
  async function timedCall(profile: LinkProfile, responseBytes: number) {
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x'.repeat(responseBytes)) });
    const link = startLinkEmulator(upstream.port ?? 0, profile);
    try {
      const url = `http://127.0.0.1:${link.port}/`;
      await (await fetch(url)).text(); // establish the connection
      const before = link.counters();
      const start = performance.now();
      const body = await (await fetch(url)).text();
      const elapsed = performance.now() - start;
      expect(body).toHaveLength(responseBytes);
      const after = link.counters();
      return { elapsed, down: after.downlinkBytes - before.downlinkBytes, up: after.uplinkBytes - before.uplinkBytes };
    } finally {
      link.stop();
      await upstream.stop(true);
    }
  }

  test('passes traffic through and counts payload bytes including headers', async () => {
    const result = await timedCall(LINK_PROFILES.none, 10_000);
    expect(result.down).toBeGreaterThan(10_000);
    expect(result.up).toBeGreaterThan(0);
  });

  test('adds round-trip latency', async () => {
    const result = await timedCall({ ...LINK_PROFILES.none, name: 'rtt', oneWayLatencyMs: 40 }, 100);
    expect(result.elapsed).toBeGreaterThanOrEqual(78);
  });

  test('limits downlink bandwidth', async () => {
    const result = await timedCall({ ...LINK_PROFILES.none, name: 'slow', downlinkBytesPerSecond: 1_000_000 }, 300_000);
    expect(result.elapsed).toBeGreaterThanOrEqual(290);
  });
});

describe('summary output', () => {
  test('renders a CSV row per sample', async () => {
    const client = new RpcClient(chain.endpoints.rpcUrl);
    const result = await syncWallet({ client, recipient, engine: 'crypto', pageBlocks: 3, startBlock: FIRST_BLOCK, cachePath: join(directory, 'csv.json'), cache: null });
    const row = summaryRow({
      schemaVersion: 1, kind: 'phase2-wallet', scenario: 'cold', engine: 'crypto', pageBlocks: 3, pageAnnouncements: 384,
      profile: LINK_PROFILES.none, repetition: 1, count: COUNT, matchEvery: MATCH_EVERY, seed: 'phase2-test', fixtureSha256: expected.fixtureSha256,
      sdkVersion: 'x', sdkCommit: 'x', fromBlock: result.fromBlock, headBlock: result.headBlock, blocksScanned: 3, announcementsScanned: COUNT,
      cachedMatchesAtStart: 0, newMatches: result.newMatches.length, totalMatches: result.cache.matches.length, requests: result.requests,
      timings: { ...result.timings, pageFetchMsP50: 1, pageFetchMsP95: 1, pageFetchMsMax: 1 },
      bytes: { ...result.bytes, wireUplink: 0, wireDownlink: 0, wireConnections: 0 },
      cpuUserMs: 0, cpuSystemMs: 0,
      memoryBeforeSync: { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0 }, memoryAfterSync: { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0 },
      processLifetimePeakRssBytes: 0, chainRssBytes: 0, pages: result.pages, verified: true, environment: {},
    });
    expect(row.matches).toBe(expected.matches.length);
    const csv = toCsv([row]);
    expect(csv.split('\n')[0]).toContain('networkS');
    expect(csv.trim().split('\n')).toHaveLength(2);
  });
});

describe('repeat plan', () => {
  const settings: Setting[] = matrixSettings({
    entries: [
      { fixture: '100000-sparse', profiles: ['none', 'public'], scenarios: ['cold'], pages: [1, 16] },
      { fixture: '100000-sparse', profiles: ['none'], scenarios: ['cold', 'catchup'], pages: [1] },
    ],
  }, '/fixtures');

  test('matrix expands to distinct settings with fixtures resolved against the root', () => {
    expect(settings).toHaveLength(5);
    expect(new Set(settings.map(s => s.fixtureDir))).toEqual(new Set(['/fixtures/100000-sparse']));
  });

  test('shuffled order is a seeded permutation per repetition block', () => {
    const plan = buildPlan(settings, { repetitions: 3, firstRepetition: 2, order: 'shuffled', seed: 'x' });
    expect(plan).toHaveLength(15);
    expect(plan.map(p => p.order)).toEqual([...Array(15).keys()]);
    const key = (s: Setting): string => `${s.profile}|${s.scenario}|${s.pageBlocks}`;
    for (const repetition of [2, 3, 4]) {
      const block = plan.filter(p => p.repetition === repetition);
      expect(block.map(key).sort()).toEqual(settings.map(key).sort());
    }
    expect(buildPlan(settings, { repetitions: 3, firstRepetition: 2, order: 'shuffled', seed: 'x' })).toEqual(plan);
    const grouped = buildPlan(settings, { repetitions: 1, firstRepetition: 1, order: 'grouped', seed: 'x' });
    expect(grouped.map(key)).toEqual(settings.map(key));
  });

  test('spread reports median, min and max and ignores missing values', () => {
    expect(spread([3, 1, 2])).toEqual({ n: 3, median: 2, min: 1, max: 3 });
    expect(spread([4, null, 1, 2, 3])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 });
    expect(spread([null])).toEqual({ n: 0, median: null, min: null, max: null });
  });
});
