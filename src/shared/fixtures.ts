import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import { CURVE, ProjectivePoint, getPublicKey, getSharedSecret, utils } from '@noble/secp256k1';
import {
  ERC5564AnnouncerAbi,
  buildMetadataForETH,
  generateStealthAddress,
  getHashedSharedSecret,
  getViewTag,
  type AnnouncementLog,
  type GenerateStealthAddressReturnType,
} from '@scopelift/stealth-address-sdk';
import {
  bytesToHex,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  hexToBytes,
  toHex,
  type Hex,
} from 'viem';
import { z } from 'zod';
import {
  FIXTURE_VERSION,
  SDK_COMMIT,
  SDK_VERSION,
  type FixtureManifest,
  type FixtureOptions,
  type LoadedFixture,
} from './model.ts';

// Public, deterministic test-only keys. Never fund these addresses or use them for actual transfers.
const KEY_DOMAIN = 'erc5564-scan-benchmark:test-only:v1';
const ENTRIES_PER_BLOCK = 128;
const FIRST_BLOCK = 20_000_000n;
const ANNOUNCER = '0x55649e01b5df198d18d95b5cc5051630cfD45564' as const;
const CALLER = '0x0000000000000000000000000000000000000001' as const;
const TEST_AMOUNT_WEI = 1_000_000_000_000_000n;
const RPC_PREFIX = '{"jsonrpc":"2.0","id":1,"result":[';
const RPC_SUFFIX = ']}';
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform((value): Hex => value as Hex);
const hashHex = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value): Hex => value as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value): Hex => value as Hex);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).transform((value): Hex => value as Hex);
const privateKey = hex.refine((value) => value.length === 66 && utils.isValidPrivateKey(value.slice(2)), 'Invalid secp256k1 private scalar');
const publicKey = hex.refine((value) => {
  if (!/^0x0[23][0-9a-fA-F]{64}$/.test(value)) return false;
  try {
    ProjectivePoint.fromHex(value.slice(2));
    return true;
  } catch (cause) {
    if (cause instanceof Error) return false;
    throw cause;
  }
}, 'Invalid compressed secp256k1 public key');
const optionsSchema = z.object({
  count: safeInteger,
  seed: z.string().min(1),
  matchEvery: safeInteger,
}).strict();
const manifestSchema = optionsSchema.extend({
  schemaVersion: z.literal(FIXTURE_VERSION),
  sdkVersion: z.literal(SDK_VERSION),
  sdkCommit: z.literal(SDK_COMMIT),
  recipient: z.object({ spendingPublicKey: publicKey, viewingPrivateKey: privateKey }).strict(),
  expectedIndices: z.array(safeInteger),
  viewTagHits: safeInteger,
  nonmatchViewTagHits: safeInteger,
  fixtureSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rpcResponseBytes: safeInteger,
}).strict().superRefine((manifest, context) => {
  const intendedCount = manifest.count === 0 || manifest.matchEvery === 0
    ? 0
    : Math.floor((manifest.count - 1) / manifest.matchEvery) + 1;
  if (manifest.expectedIndices.length !== intendedCount ||
      manifest.expectedIndices.some((index, position) => index !== position * manifest.matchEvery)) {
    context.addIssue({ code: 'custom', path: ['expectedIndices'], message: 'Expected indices must exactly match the destination schedule, without duplicates or out-of-range entries' });
  }
  if (manifest.viewTagHits !== intendedCount + manifest.nonmatchViewTagHits || manifest.viewTagHits > manifest.count) {
    context.addIssue({ code: 'custom', path: ['viewTagHits'], message: 'View-tag counts disagree with intended match counts' });
  }
});
const rawLogSchema = z.object({
  address,
  blockHash: hashHex,
  blockNumber: quantity,
  data: hex,
  logIndex: quantity,
  removed: z.literal(false),
  topics: z.tuple([hashHex, hashHex, hashHex, hashHex]),
  transactionHash: hashHex,
  transactionIndex: quantity,
}).strict();

type RawLog = z.infer<typeof rawLogSchema>;

function validate<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${context}: ${result.error.message}`);
  return result.data;
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${context}: invalid JSON`, { cause });
  }
}

function domainHash(seed: string, domain: string, index: number, attempt = 0): Buffer {
  return createHash('sha256').update(JSON.stringify([KEY_DOMAIN, seed, domain, index, attempt])).digest();
}

function deriveScalar(seed: string, domain: string, index = 0, used?: Set<string>): Uint8Array {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = domainHash(seed, domain, index, attempt);
    const scalar = BigInt(bytesToHex(candidate));
    const identity = candidate.toString('hex');
    if (scalar > 0n && scalar < CURVE.n && utils.isValidPrivateKey(candidate) && !used?.has(identity)) {
      used?.add(identity);
      return candidate;
    }
  }
}

function deriveRecipient(seed: string, role: 'target' | 'decoy') {
  const spendingPrivateKey = deriveScalar(seed, `${role}:spending`);
  const viewingPrivateKey = deriveScalar(seed, `${role}:viewing`);
  const spendingPublicKey = bytesToHex(getPublicKey(spendingPrivateKey));
  const viewingPublicKey = bytesToHex(getPublicKey(viewingPrivateKey));
  return {
    recipient: { spendingPublicKey, viewingPrivateKey: bytesToHex(viewingPrivateKey) },
    stealthMetaAddressURI: `st:eth:${spendingPublicKey}${viewingPublicKey.slice(2)}`,
  };
}

function isIntendedMatch(index: number, matchEvery: number): boolean {
  return matchEvery !== 0 && index % matchEvery === 0;
}

function targetViewTag(viewingPrivateKey: Hex, ephemeralPublicKey: Hex): Hex {
  const sharedSecret = getSharedSecret(hexToBytes(viewingPrivateKey), hexToBytes(ephemeralPublicKey));
  const hashedSharedSecret = getHashedSharedSecret({ sharedSecret, schemeId: 1 });
  return getViewTag({ hashedSharedSecret, schemeId: 1 });
}

function createRawLog(seed: string, index: number, generated: GenerateStealthAddressReturnType): RawLog {
  const blockOffset = Math.floor(index / ENTRIES_PER_BLOCK);
  const topics = encodeEventTopics({
    abi: ERC5564AnnouncerAbi,
    eventName: 'Announcement',
    args: { schemeId: 1n, stealthAddress: generated.stealthAddress, caller: CALLER },
  });
  const data = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [
    generated.ephemeralPublicKey,
    buildMetadataForETH({ viewTag: generated.viewTag, amount: TEST_AMOUNT_WEI }),
  ]);
  return validate(rawLogSchema, {
    address: ANNOUNCER,
    blockHash: bytesToHex(domainHash(seed, 'block', blockOffset)),
    blockNumber: toHex(FIRST_BLOCK + BigInt(blockOffset)),
    data,
    logIndex: toHex(index % ENTRIES_PER_BLOCK),
    removed: false,
    topics,
    transactionHash: bytesToHex(domainHash(seed, 'transaction', index)),
    transactionIndex: toHex(index % ENTRIES_PER_BLOCK),
  }, `Generated announcement ${index}`);
}

export async function generateFixture(directory: string, options: FixtureOptions): Promise<FixtureManifest> {
  const validatedOptions = validate(optionsSchema, options, 'Fixture options');
  const target = deriveRecipient(validatedOptions.seed, 'target');
  const decoy = deriveRecipient(validatedOptions.seed, 'decoy');
  const expectedIndices: number[] = [];
  const usedEphemeralKeys = new Set<string>();
  const hash = createHash('sha256');
  let viewTagHits = 0;
  let nonmatchViewTagHits = 0;
  let rpcResponseBytes = Buffer.byteLength(RPC_PREFIX + RPC_SUFFIX);
  await mkdir(directory, { recursive: true });

  function* rows(): Generator<Buffer> {
    for (let index = 0; index < validatedOptions.count; index += 1) {
      const intended = isIntendedMatch(index, validatedOptions.matchEvery);
      const destination = intended ? target : decoy;
      const ephemeralPrivateKey = deriveScalar(validatedOptions.seed, 'ephemeral', index, usedEphemeralKeys);
      const generated = generateStealthAddress({
        stealthMetaAddressURI: destination.stealthMetaAddressURI,
        ephemeralPrivateKey,
        schemeId: 1,
      });
      if (intended) expectedIndices.push(index);
      if (targetViewTag(target.recipient.viewingPrivateKey, generated.ephemeralPublicKey) === generated.viewTag) {
        viewTagHits += 1;
        if (!intended) nonmatchViewTagHits += 1;
      }
      const serialized = JSON.stringify(createRawLog(validatedOptions.seed, index, generated));
      rpcResponseBytes += Buffer.byteLength(serialized) + (index === 0 ? 0 : 1);
      const bytes = Buffer.from(`${serialized}\n`);
      hash.update(bytes);
      yield bytes;
    }
  }

  try {
    await pipeline(Readable.from(rows()), createWriteStream(join(directory, 'announcements.jsonl'), { flags: 'wx' }));
    const manifest: FixtureManifest = {
      ...validatedOptions,
      schemaVersion: FIXTURE_VERSION,
      sdkVersion: SDK_VERSION,
      sdkCommit: SDK_COMMIT,
      recipient: target.recipient,
      expectedIndices,
      viewTagHits,
      nonmatchViewTagHits,
      fixtureSha256: hash.digest('hex'),
      rpcResponseBytes,
    };
    validate(manifestSchema, manifest, 'Generated fixture manifest');
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
  } catch (cause) {
    throw new Error(`Failed to generate fixture in ${directory}`, { cause });
  }
}

function safeQuantityNumber(value: Hex, context: string): number {
  const integer = BigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${context}: quantity exceeds the safe integer range`);
  return Number(integer);
}

function decodeAnnouncement(row: RawLog, context: string): AnnouncementLog {
  try {
    const decoded = decodeEventLog({ abi: ERC5564AnnouncerAbi, eventName: 'Announcement', data: row.data, topics: row.topics, strict: true });
    const { caller, ephemeralPubKey, metadata, schemeId, stealthAddress } = decoded.args;
    if (schemeId !== 1n) throw new Error('Only ERC-5564 scheme 1 is supported');
    validate(publicKey, ephemeralPubKey, 'Announcement ephemeralPubKey');
    if (!/^0x[0-9a-fA-F]{114}$/.test(metadata)) throw new Error('Expected 57-byte ETH metadata');
    const tag = metadata.slice(0, 4) as Hex;
    if (metadata.toLowerCase() !== buildMetadataForETH({ viewTag: tag, amount: TEST_AMOUNT_WEI }).toLowerCase()) {
      throw new Error('ETH metadata does not match the fixed synthetic transfer amount');
    }
    if (row.address.toLowerCase() !== ANNOUNCER.toLowerCase() || caller.toLowerCase() !== CALLER.toLowerCase()) {
      throw new Error('Unexpected synthetic announcer or caller');
    }
    return {
      ...row,
      blockNumber: BigInt(row.blockNumber),
      logIndex: safeQuantityNumber(row.logIndex, 'logIndex'),
      transactionIndex: safeQuantityNumber(row.transactionIndex, 'transactionIndex'),
      caller,
      ephemeralPubKey,
      metadata,
      schemeId,
      stealthAddress,
    };
  } catch (cause) {
    throw new Error(`${context}: invalid ERC-5564 Announcement (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
}

export async function loadFixture(directory: string): Promise<LoadedFixture> {
  const manifestPath = join(directory, 'manifest.json');
  const manifest = validate(manifestSchema, parseJson(await readFile(manifestPath, 'utf8'), manifestPath), manifestPath);
  const expectedRecipient = deriveRecipient(manifest.seed, 'target').recipient;
  if (manifest.recipient.spendingPublicKey !== expectedRecipient.spendingPublicKey || manifest.recipient.viewingPrivateKey !== expectedRecipient.viewingPrivateKey) {
    throw new Error(`${manifestPath}: recipient does not match deterministic test-only seed derivation`);
  }
  const logPath = join(directory, 'announcements.jsonl');
  const announcements: AnnouncementLog[] = [];
  const identities = new Set<string>();
  const ephemeralKeys = new Set<string>();
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let fixtureBytes = 0;
  let rpcResponseBytes = Buffer.byteLength(RPC_PREFIX + RPC_SUFFIX);
  let pending = '';

  function consumeLine(line: string): void {
    const index = announcements.length;
    const context = `${logPath}:${index + 1}`;
    if (index >= manifest.count) throw new Error(`${context}: more rows than manifest count`);
    const row = validate(rawLogSchema, parseJson(line, context), context);
    const announcement = decodeAnnouncement(row, context);
    const identity = `${row.transactionHash.toLowerCase()}:${row.logIndex.toLowerCase()}`;
    if (identities.has(identity)) throw new Error(`${context}: duplicate announcement identity`);
    identities.add(identity);
    const ephemeralKey = announcement.ephemeralPubKey.toLowerCase();
    if (ephemeralKeys.has(ephemeralKey)) throw new Error(`${context}: duplicate ephemeral public key`);
    ephemeralKeys.add(ephemeralKey);
    if (announcement.blockNumber !== FIRST_BLOCK + BigInt(Math.floor(index / ENTRIES_PER_BLOCK)) ||
        announcement.logIndex !== index % ENTRIES_PER_BLOCK || announcement.transactionIndex !== index % ENTRIES_PER_BLOCK ||
        row.blockHash !== bytesToHex(domainHash(manifest.seed, 'block', Math.floor(index / ENTRIES_PER_BLOCK))) ||
        row.transactionHash !== bytesToHex(domainHash(manifest.seed, 'transaction', index))) {
      throw new Error(`${context}: identity or block ordering does not match the deterministic fixture`);
    }
    rpcResponseBytes += Buffer.byteLength(JSON.stringify(row)) + (index === 0 ? 0 : 1);
    announcements.push(announcement);
  }

  try {
    for await (const chunk of createReadStream(logPath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fixtureBytes += bytes.byteLength;
      hash.update(bytes);
      pending += decoder.decode(bytes, { stream: true });
      let start = 0;
      for (let end = pending.indexOf('\n', start); end !== -1; end = pending.indexOf('\n', start)) {
        consumeLine(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    pending += decoder.decode();
    if (pending.length !== 0) throw new Error(`${logPath}:${announcements.length + 1}: truncated JSONL row (missing final newline)`);
    if (announcements.length !== manifest.count) throw new Error(`${logPath}: expected ${manifest.count} rows, received ${announcements.length}`);
    if (hash.digest('hex') !== manifest.fixtureSha256) throw new Error(`${logPath}: SHA256 differs from manifest`);
    if (rpcResponseBytes !== manifest.rpcResponseBytes) throw new Error(`${logPath}: synthetic JSON-RPC response byte count differs from manifest`);
    return { manifest, announcements, fixtureBytes };
  } catch (cause) {
    throw new Error(`Failed to load fixture in ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
