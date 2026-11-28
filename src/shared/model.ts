import type { AnnouncementLog } from '@scopelift/stealth-address-sdk';
import type { Hex } from 'viem';

export const SDK_VERSION = '1.0.0-beta.5';
export const SDK_COMMIT = '88bcc27c3b6163080ee18f330dfd6336dc8bd2e2';
export const FIXTURE_VERSION = 1;

export interface Recipient {
  spendingPublicKey: Hex;
  viewingPrivateKey: Hex;
}

export interface FixtureOptions {
  count: number;
  seed: string;
  matchEvery: number;
}

export interface FixtureManifest extends FixtureOptions {
  schemaVersion: typeof FIXTURE_VERSION;
  sdkVersion: typeof SDK_VERSION;
  sdkCommit: typeof SDK_COMMIT;
  recipient: Recipient;
  expectedIndices: number[];
  viewTagHits: number;
  nonmatchViewTagHits: number;
  fixtureSha256: string;
  rpcResponseBytes: number;
}

export interface LoadedFixture {
  manifest: FixtureManifest;
  announcements: AnnouncementLog[];
  fixtureBytes: number;
}

export type Engine = 'sdk' | 'crypto' | 'noble' | 'wasm' | 'native';

export interface WorkerOptions {
  fixtureDir: string;
  engine: Engine;
  batchSize: number;
  warmupCount: number;
  repetition: number;
  /** Bun worker threads for a fast engine; 1 scans in the main thread. */
  threads?: number;
}

export interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
}

export interface BenchmarkSample {
  schemaVersion: 1;
  sdkVersion: string;
  sdkCommit: string;
  fixtureSha256: string;
  seed: string;
  count: number;
  matchEvery: number;
  matches: number;
  viewTagHits: number;
  nonmatchViewTagHits: number;
  fixtureBytes: number;
  syntheticRpcResponseBytes: number;
  engine: Engine;
  mode: 'full' | 'incremental';
  batchSize: number;
  threads: number;
  /** Starting the threads and copying their slices, outside scanMs. */
  threadSetupMs: number;
  warmupCount: number;
  repetition: number;
  scanMs: number;
  announcementsPerSecond: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  memoryBeforeLoad: MemorySnapshot;
  memoryAfterLoad: MemorySnapshot;
  memoryBeforeScan: MemorySnapshot;
  memoryAfterScan: MemorySnapshot;
  processLifetimePeakRssBytes: number;
  verified: true;
  environment: {
    bun: string;
    node: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    lockfileSha256: string;
    dependencies: Record<string, string>;
  };
}
