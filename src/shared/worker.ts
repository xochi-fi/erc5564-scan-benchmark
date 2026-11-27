import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import {
  checkStealthAddress,
  getAnnouncementsForUser,
  getViewTagFromMetadata,
  type AnnouncementLog,
} from '@scopelift/stealth-address-sdk';
import { z } from 'zod';
import { loadFixture } from './fixtures.ts';
import {
  SDK_COMMIT,
  SDK_VERSION,
  type BenchmarkSample,
  type Engine,
  type MemorySnapshot,
  type Recipient,
  type WorkerOptions,
} from './model.ts';

const workerOptionsSchema = z.object({
  fixtureDir: z.string().min(1),
  engine: z.enum(['sdk', 'crypto']),
  batchSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  warmupCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  repetition: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export function announcementIdentity(log: AnnouncementLog): string {
  return JSON.stringify([log.blockHash, log.transactionHash, log.logIndex]);
}

export function assertMatches(
  actual: AnnouncementLog[],
  expectedIdentities: string[],
): void {
  if (actual.length !== expectedIdentities.length) {
    throw new Error(
      `Match count mismatch: expected ${expectedIdentities.length}, received ${actual.length}`,
    );
  }

  for (let index = 0; index < actual.length; index += 1) {
    const log = actual[index];
    if (log === undefined) throw new Error(`Missing match at position ${index}`);
    const identity = announcementIdentity(log);
    if (identity !== expectedIdentities[index]) {
      throw new Error(
        `Match identity mismatch at position ${index}: expected ${expectedIdentities[index]}, received ${identity}`,
      );
    }
  }
}

function scanCryptoRange(
  announcements: AnnouncementLog[],
  recipient: Recipient,
  start: number,
  end: number,
  matches: AnnouncementLog[],
): void {
  for (let index = start; index < end; index += 1) {
    const announcement = announcements[index];
    if (announcement === undefined) throw new Error(`Missing announcement at index ${index}`);
    if (checkStealthAddress({
      ephemeralPublicKey: announcement.ephemeralPubKey,
      schemeId: Number(announcement.schemeId),
      spendingPublicKey: recipient.spendingPublicKey,
      userStealthAddress: announcement.stealthAddress,
      viewingPrivateKey: recipient.viewingPrivateKey,
      viewTag: getViewTagFromMetadata(announcement.metadata),
    })) {
      matches.push(announcement);
    }
  }
}

export async function scanAnnouncements(
  announcements: AnnouncementLog[],
  recipient: Recipient,
  engine: Engine,
  batchSize: number,
): Promise<AnnouncementLog[]> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 0) {
    throw new Error('batchSize must be a nonnegative safe integer');
  }

  if (engine === 'sdk' && batchSize === 0) {
    return getAnnouncementsForUser({ announcements, ...recipient });
  }

  const matches: AnnouncementLog[] = [];
  const step = batchSize === 0 ? announcements.length : batchSize;
  if (engine === 'crypto') {
    for (let start = 0; start < announcements.length; start += step) {
      scanCryptoRange(
        announcements, recipient, start, Math.min(start + step, announcements.length), matches,
      );
    }
    return matches;
  }

  if (engine !== 'sdk') throw new Error(`Unsupported scan engine: ${String(engine)}`);
  for (let start = 0; start < announcements.length; start += step) {
    const batchMatches = await getAnnouncementsForUser({
      announcements: announcements.slice(start, start + step),
      ...recipient,
    });
    for (const announcement of batchMatches) matches.push(announcement);
  }
  return matches;
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
  };
}

async function environmentProvenance(): Promise<BenchmarkSample['environment']> {
  const dependencyNames = [
    '@scopelift/stealth-address-sdk',
    '@noble/secp256k1',
    'viem',
    'graphql-request',
  ];
  const dependencies: Record<string, string> = {};
  const packageSchema = z.object({ name: z.string(), version: z.string().min(1) });
  for (const name of dependencyNames) {
    const packageUrl = new URL(`../../node_modules/${name}/package.json`, import.meta.url);
    const parsed = packageSchema.safeParse(JSON.parse(await readFile(packageUrl, 'utf8')));
    if (!parsed.success) throw new Error(`Invalid installed package metadata for ${name}`, { cause: parsed.error });
    if (parsed.data.name !== name) throw new Error(`Installed package name mismatch for ${name}`);
    dependencies[name] = parsed.data.version;
  }
  if (dependencies['@scopelift/stealth-address-sdk'] !== SDK_VERSION) {
    throw new Error(`Installed SDK version must be ${SDK_VERSION}, received ${dependencies['@scopelift/stealth-address-sdk']}`);
  }

  const lockfile = await readFile(new URL('../../bun.lock', import.meta.url));
  const processors = cpus();
  const processor = processors[0];
  if (processor === undefined) throw new Error('CPU model is unavailable from the operating system');
  return {
    bun: Bun.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: processor.model,
    logicalCpus: processors.length,
    totalMemoryBytes: totalmem(),
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    dependencies,
  };
}

export async function runWorker(options: WorkerOptions): Promise<BenchmarkSample> {
  const validated = workerOptionsSchema.safeParse(options);
  if (!validated.success) throw new Error('Invalid worker options', { cause: validated.error });
  const environment = await environmentProvenance();

  Bun.gc(true);
  const memoryBeforeLoad = memorySnapshot();
  const { announcements, manifest, fixtureBytes } = await loadFixture(options.fixtureDir);
  Bun.gc(true);
  const memoryAfterLoad = memorySnapshot();

  const expectedIdentities = manifest.expectedIndices.map((index) => {
    const announcement = announcements[index];
    if (announcement === undefined) throw new Error(`Expected match index ${index} is outside the fixture`);
    return announcementIdentity(announcement);
  });
  const warmupCount = Math.min(announcements.length, options.warmupCount);
  if (warmupCount > 0) {
    await scanAnnouncements(
      announcements.slice(0, warmupCount), manifest.recipient, options.engine, options.batchSize,
    );
  }

  Bun.gc(true);
  const memoryBeforeScan = memorySnapshot();
  const cpuStart = process.cpuUsage();
  const scanStart = performance.now();
  const actual = await scanAnnouncements(
    announcements, manifest.recipient, options.engine, options.batchSize,
  );
  const scanMs = performance.now() - scanStart;
  const cpu = process.cpuUsage(cpuStart);
  const processLifetimePeakRssBytes = process.resourceUsage().maxRSS * 1024;
  const memoryAfterScan = memorySnapshot();

  assertMatches(actual, expectedIdentities);
  return {
    schemaVersion: 1,
    sdkVersion: SDK_VERSION,
    sdkCommit: SDK_COMMIT,
    fixtureSha256: manifest.fixtureSha256,
    seed: manifest.seed,
    count: manifest.count,
    matchEvery: manifest.matchEvery,
    matches: actual.length,
    viewTagHits: manifest.viewTagHits,
    nonmatchViewTagHits: manifest.nonmatchViewTagHits,
    fixtureBytes,
    syntheticRpcResponseBytes: manifest.rpcResponseBytes,
    engine: options.engine,
    mode: options.batchSize === 0 ? 'full' : 'incremental',
    batchSize: options.batchSize,
    warmupCount,
    repetition: options.repetition,
    scanMs,
    announcementsPerSecond: announcements.length === 0 ? 0 : announcements.length * 1000 / scanMs,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    memoryBeforeLoad,
    memoryAfterLoad,
    memoryBeforeScan,
    memoryAfterScan,
    processLifetimePeakRssBytes,
    verified: true,
    environment,
  };
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3) throw new Error('Expected exactly one JSON worker-options argument');
    const argument = Bun.argv[2];
    if (argument === undefined) throw new Error('Missing worker-options argument');
    const validated = workerOptionsSchema.safeParse(JSON.parse(argument));
    if (!validated.success) throw new Error('Invalid worker options', { cause: validated.error });
    const sample = await runWorker(validated.data);
    process.stdout.write(`${JSON.stringify(sample)}\n`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
