import { z } from 'zod';
import type { MemorySnapshot } from '../shared/model.ts';

export const SCHEMA_VERSION = 1;

// A FIFO link per direction models bandwidth and latency with no jitter, loss, TCP slow start, TLS or compression.
export const linkProfileSchema = z.object({
  name: z.string().min(1),
  oneWayLatencyMs: z.number().finite().nonnegative(),
  downlinkBytesPerSecond: z.number().finite().positive().nullable(),
  uplinkBytesPerSecond: z.number().finite().positive().nullable(),
  description: z.string(),
}).strict();
export type LinkProfile = z.infer<typeof linkProfileSchema>;

export const LINK_PROFILES = {
  none: {
    name: 'none',
    oneWayLatencyMs: 0,
    downlinkBytesPerSecond: null,
    uplinkBytesPerSecond: null,
    description: 'Loopback pass-through; bytes are counted, nothing is delayed.',
  },
  lan: {
    name: 'lan',
    oneWayLatencyMs: 0.5,
    downlinkBytesPerSecond: 125_000_000,
    uplinkBytesPerSecond: 125_000_000,
    description: '1 ms RTT, 1 Gbit/s each direction (self-hosted node on the local network).',
  },
  public: {
    name: 'public',
    oneWayLatencyMs: 50,
    downlinkBytesPerSecond: 6_250_000,
    uplinkBytesPerSecond: 2_500_000,
    description: '100 ms RTT, 50 Mbit/s down, 20 Mbit/s up, uncompressed (typical public RPC over home broadband; no provider-side processing delay or rate limits).',
  },
} as const satisfies Record<string, LinkProfile>;
export type LinkProfileName = keyof typeof LINK_PROFILES;
export const LINK_PROFILE_NAMES = Object.keys(LINK_PROFILES) as LinkProfileName[];

export interface LinkCounters {
  connections: number;
  uplinkBytes: number;
  downlinkBytes: number;
}

export interface ChainStats {
  link: LinkCounters;
  rpc: Record<string, { requests: number; requestBodyBytes: number; responseBodyBytes: number }>;
  head: number;
  rssBytes: number;
}

export interface ChainEndpoints {
  rpcUrl: string;
  directRpcUrl: string;
  controlUrl: string;
  firstBlock: number;
  lastBlock: number;
  fixtureSha256: string;
  count: number;
  profile: LinkProfile;
}

export const walletOptionsSchema = z.object({
  rpcUrl: z.string().url(),
  controlUrl: z.string().url(),
  fixtureDir: z.string().min(1),
  expectedPath: z.string().min(1),
  cachePath: z.string().min(1),
  scenario: z.enum(['cold', 'catchup', 'prefix']),
  engine: z.enum(['sdk', 'crypto']),
  pageBlocks: z.number().int().min(1).max(1_000_000),
  startBlock: z.number().int().nonnegative(),
  profile: linkProfileSchema,
  repetition: z.number().int().min(1),
  /** sequential: receipt then balance per candidate. batched: one JSON-RPC batch of every check on a page. */
  verifyMode: z.enum(['sequential', 'batched']).default('sequential'),
}).strict();
export type WalletOptions = z.infer<typeof walletOptionsSchema>;

export const expectedFileSchema = z.object({
  fixtureSha256: z.string().regex(/^[0-9a-f]{64}$/),
  matches: z.array(z.object({
    identity: z.string(),
    blockNumber: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export type ExpectedFile = z.infer<typeof expectedFileSchema>;

export const cacheMatchSchema = z.object({
  identity: z.string(),
  blockNumber: z.number().int().nonnegative(),
  transactionHash: z.string(),
  logIndex: z.number().int().nonnegative(),
  stealthAddress: z.string(),
  amountWei: z.string(),
}).strict();
export type CacheMatch = z.infer<typeof cacheMatchSchema>;

export const scanCacheSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  spendingPublicKey: z.string(),
  startBlock: z.number().int().nonnegative(),
  lastScannedBlock: z.number().int().nonnegative(),
  matches: z.array(cacheMatchSchema),
}).strict();
export type ScanCache = z.infer<typeof scanCacheSchema>;

export interface PageRecord {
  fromBlock: number;
  toBlock: number;
  logs: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  fetchMs: number;
  decodeMs: number;
  scanMs: number;
  matches: number;
  verifyMs: number;
  checkpointMs: number;
}

export interface WalletSample {
  schemaVersion: typeof SCHEMA_VERSION;
  // kept: recorded evidence depends on it
  kind: 'phase2-wallet';
  scenario: WalletOptions['scenario'];
  engine: WalletOptions['engine'];
  pageBlocks: number;
  pageAnnouncements: number;
  profile: LinkProfile;
  repetition: number;
  count: number;
  matchEvery: number;
  seed: string;
  fixtureSha256: string;
  sdkVersion: string;
  sdkCommit: string;
  fromBlock: number;
  headBlock: number;
  blocksScanned: number;
  announcementsScanned: number;
  cachedMatchesAtStart: number;
  newMatches: number;
  totalMatches: number;
  /** Absent in samples recorded before batched verification existed; those are sequential. */
  verifyMode?: WalletOptions['verifyMode'];
  requests: { getLogs: number; blockNumber: number; receipts: number; balances: number; verifyRoundTrips?: number };
  timings: {
    totalMs: number;
    networkMs: number;
    headMs: number;
    getLogsMs: number;
    decodeMs: number;
    scanMs: number;
    verifyMs: number;
    verifyNetworkMs: number;
    verifyLocalMs: number;
    checkpointMs: number;
    otherMs: number;
    firstCandidateMs: number | null;
    firstVerifiedMs: number | null;
    pageFetchMsP50: number | null;
    pageFetchMsP95: number | null;
    pageFetchMsMax: number | null;
  };
  bytes: {
    getLogsRequestBody: number;
    getLogsResponseBody: number;
    verifyRequestBody: number;
    verifyResponseBody: number;
    wireUplink: number;
    wireDownlink: number;
    wireConnections: number;
    maxPageResponseBody: number;
  };
  cpuUserMs: number;
  cpuSystemMs: number;
  memoryBeforeSync: MemorySnapshot;
  memoryAfterSync: MemorySnapshot;
  processLifetimePeakRssBytes: number;
  chainRssBytes: number;
  pages: PageRecord[];
  verified: true;
  environment: Record<string, unknown>;
}
