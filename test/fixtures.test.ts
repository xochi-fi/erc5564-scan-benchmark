import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPublicKey, getSharedSecret, utils } from '@noble/secp256k1';
import {
  checkStealthAddress,
  computeStealthKey,
  getAnnouncementsForUser,
  getViewTagFromMetadata,
} from '@scopelift/stealth-address-sdk';
import { bytesToHex, hexToBytes, keccak256, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { generateFixture, loadFixture } from '../src/fixtures.ts';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stealth-fixture-test-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function knownTestSpendingKey(seed: string): Hex {
  // Independent reproduction of the documented test-only, domain-separated key derivation.
  for (let attempt = 0; ; attempt += 1) {
    const bytes = createHash('sha256')
      .update(JSON.stringify(['erc5564-scan-benchmark:test-only:v1', seed, 'target:spending', 0, attempt]))
      .digest();
    if (utils.isValidPrivateKey(bytes)) return bytesToHex(bytes);
  }
}

describe('deterministic ERC-5564 fixtures', () => {
  test('identical options produce byte-identical JSONL and manifests with exact byte accounting', async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const options = { count: 17, seed: 'byte-determinism', matchEvery: 4 };
    const manifest = await generateFixture(first, options);
    expect(await generateFixture(second, options)).toEqual(manifest);
    const bytes = await readFile(join(first, 'announcements.jsonl'));
    expect(bytes.equals(await readFile(join(second, 'announcements.jsonl')))).toBe(true);
    expect((await readFile(join(first, 'manifest.json'))).equals(await readFile(join(second, 'manifest.json')))).toBe(true);
    expect(manifest.expectedIndices).toEqual([0, 4, 8, 12, 16]);
    expect(manifest.fixtureSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const rawLogs: unknown[] = bytes.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(manifest.rpcResponseBytes).toBe(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: rawLogs })));
    const loaded = await loadFixture(first);
    expect(loaded.fixtureBytes).toBe(bytes.byteLength);
    expect(loaded.fixtureBytes).not.toBe(manifest.rpcResponseBytes);
    expect(loaded.manifest).toEqual(manifest);
  });

  test('changing the seed changes recipient, ephemeral keys, hashes, and bytes', async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const firstManifest = await generateFixture(first, { count: 3, seed: 'seed-one', matchEvery: 2 });
    const secondManifest = await generateFixture(second, { count: 3, seed: 'seed-two', matchEvery: 2 });
    expect(firstManifest.recipient).not.toEqual(secondManifest.recipient);
    expect(firstManifest.fixtureSha256).not.toBe(secondManifest.fixtureSha256);
    const firstLoaded = await loadFixture(first);
    const secondLoaded = await loadFixture(second);
    expect(firstLoaded.announcements[0]?.ephemeralPubKey).not.toBe(secondLoaded.announcements[0]?.ephemeralPubKey);
  });

  test('sparse fixtures scan to sender-selected identities and derive spendable test-only keys', async () => {
    const directory = await temporaryDirectory();
    const manifest = await generateFixture(directory, { count: 131, seed: 'spending-key-proof', matchEvery: 17 });
    const { announcements } = await loadFixture(directory);
    const expected = manifest.expectedIndices.map((index) => {
      const announcement = announcements[index];
      if (announcement === undefined) throw new Error(`Missing expected fixture announcement ${index}`);
      return announcement;
    });
    const matches = await getAnnouncementsForUser({ announcements, ...manifest.recipient });
    expect(matches).toEqual(expected);
    const cryptoMatches = announcements.filter((announcement) => checkStealthAddress({
      ephemeralPublicKey: announcement.ephemeralPubKey,
      spendingPublicKey: manifest.recipient.spendingPublicKey,
      viewingPrivateKey: manifest.recipient.viewingPrivateKey,
      userStealthAddress: announcement.stealthAddress,
      viewTag: getViewTagFromMetadata(announcement.metadata),
      schemeId: 1,
    }));
    expect(cryptoMatches).toEqual(expected);
    const spendingPrivateKey = knownTestSpendingKey(manifest.seed);
    expect(bytesToHex(getPublicKey(hexToBytes(spendingPrivateKey)))).toBe(manifest.recipient.spendingPublicKey);
    for (const announcement of matches) {
      const stealthPrivateKey = computeStealthKey({
        spendingPrivateKey,
        viewingPrivateKey: manifest.recipient.viewingPrivateKey,
        ephemeralPublicKey: announcement.ephemeralPubKey,
        schemeId: 1,
      });
      expect(privateKeyToAddress(stealthPrivateKey).toLowerCase()).toBe(announcement.stealthAddress.toLowerCase());
    }
    expect(new Set(announcements.map((entry) => `${entry.transactionHash}:${entry.logIndex}`)).size).toBe(announcements.length);
    expect(new Set(announcements.map((entry) => entry.ephemeralPubKey)).size).toBe(announcements.length);
  });

  test('view-tag counts use fresh target ECDH for every announcement, including decoys', async () => {
    const directory = await temporaryDirectory();
    const manifest = await generateFixture(directory, { count: 384, seed: 'fresh-target-view-tags', matchEvery: 13 });
    const { announcements } = await loadFixture(directory);
    let targetHits = 0;
    let decoyHits = 0;
    const intendedTags = new Set<string>();
    announcements.forEach((announcement, index) => {
      const intended = manifest.expectedIndices.includes(index);
      const tag = getViewTagFromMetadata(announcement.metadata);
      const independentlyComputedTag = keccak256(getSharedSecret(
        hexToBytes(manifest.recipient.viewingPrivateKey),
        hexToBytes(announcement.ephemeralPubKey),
      )).slice(0, 4);
      if (intended) intendedTags.add(tag);
      if (independentlyComputedTag === tag) {
        targetHits += 1;
        if (!intended) decoyHits += 1;
      }
    });
    expect(manifest.viewTagHits).toBe(targetHits);
    expect(manifest.nonmatchViewTagHits).toBe(decoyHits);
    expect(manifest.viewTagHits).toBe(manifest.expectedIndices.length + decoyHits);
    expect(intendedTags.size).toBeGreaterThan(1);
  });

  test('matchEvery zero produces no intended or actual matches', async () => {
    const directory = await temporaryDirectory();
    const manifest = await generateFixture(directory, { count: 11, seed: 'no-matches', matchEvery: 0 });
    const { announcements } = await loadFixture(directory);
    expect(manifest.expectedIndices).toEqual([]);
    expect(manifest.viewTagHits).toBe(manifest.nonmatchViewTagHits);
    expect(await getAnnouncementsForUser({ announcements, ...manifest.recipient })).toEqual([]);
  });

  test('empty fixtures retain the SHA256 of exact empty bytes and an empty RPC result', async () => {
    const directory = await temporaryDirectory();
    const manifest = await generateFixture(directory, { count: 0, seed: 'empty', matchEvery: 1 });
    expect(manifest.expectedIndices).toEqual([]);
    expect(manifest.fixtureSha256).toBe(createHash('sha256').digest('hex'));
    expect(manifest.rpcResponseBytes).toBe(Buffer.byteLength('{"jsonrpc":"2.0","id":1,"result":[]}'));
    expect(await loadFixture(directory)).toEqual({ manifest, announcements: [], fixtureBytes: 0 });
  });

  test.each([
    { count: -1, seed: 'invalid', matchEvery: 1 },
    { count: 0.5, seed: 'invalid', matchEvery: 1 },
    { count: 1, seed: 'invalid', matchEvery: -1 },
    { count: 1, seed: '', matchEvery: 1 },
  ])('rejects invalid generation options: %j', async (options) => {
    await expect(generateFixture(await temporaryDirectory(), options)).rejects.toThrow('Fixture options');
  });

  test.each(['truncated-row', 'missing-row', 'invalid-json', 'blank-row', 'hash-mismatch'] as const)(
    'rejects damaged JSONL rather than returning no matches: %s',
    async (damage) => {
      const directory = await temporaryDirectory();
      await generateFixture(directory, { count: 3, seed: 'damaged-jsonl', matchEvery: 2 });
      const path = join(directory, 'announcements.jsonl');
      const source = await readFile(path, 'utf8');
      const firstNewline = source.indexOf('\n');
      const damaged = {
        'truncated-row': source.slice(0, -1),
        'missing-row': source.slice(0, source.lastIndexOf('\n', source.length - 2) + 1),
        'invalid-json': `{invalid}\n${source.slice(firstNewline + 1)}`,
        'blank-row': `${source}\n`,
        'hash-mismatch': ` ${source}`,
      }[damage];
      await writeFile(path, damaged);
      await expect(loadFixture(directory)).rejects.toThrow(/announcements\.jsonl|SHA256/);
    },
  );

  test.each(['removed', 'quantity', 'abi', 'topics', 'duplicate', 'extra-field'] as const)(
    'rejects semantically invalid rows even when their SHA256 is updated: %s',
    async (damage) => {
      const directory = await temporaryDirectory();
      const manifest = await generateFixture(directory, { count: 3, seed: 'invalid-rows', matchEvery: 2 });
      const path = join(directory, 'announcements.jsonl');
      const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const first = rows[0];
      if (!first) throw new Error('Test fixture unexpectedly has no first row');
      switch (damage) {
        case 'removed': first.removed = true; break;
        case 'quantity': first.blockNumber = 20_000_000; break;
        case 'abi': first.data = '0x'; break;
        case 'topics': first.topics = ['0x' + '00'.repeat(32)]; break;
        case 'duplicate': rows[1] = first; break;
        case 'extra-field': first.unexpected = 'not an eth_getLogs field'; break;
      }
      const bytes = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
      await writeFile(path, bytes);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({
        ...manifest,
        fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
        rpcResponseBytes: Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: rows })),
      }));
      await expect(loadFixture(directory)).rejects.toThrow(/announcements\.jsonl:[12]/);
    },
  );

  test.each(['version', 'sdk', 'expected', 'duplicate-index', 'out-of-range', 'counts', 'scalar', 'seed-recipient', 'rpc-bytes'] as const)(
    'rejects invalid manifests instead of accepting an apparent no-match fixture: %s',
    async (damage) => {
      const directory = await temporaryDirectory();
      const manifest = await generateFixture(directory, { count: 3, seed: 'invalid-manifest', matchEvery: 2 });
      const damaged: Record<string, unknown> = { ...manifest };
      switch (damage) {
        case 'version': damaged.schemaVersion = 999; break;
        case 'sdk': damaged.sdkCommit = 'wrong-sdk-commit'; break;
        case 'expected': damaged.expectedIndices = []; break;
        case 'duplicate-index': damaged.expectedIndices = [0, 0]; break;
        case 'out-of-range': damaged.expectedIndices = [0, 3]; break;
        case 'counts': damaged.viewTagHits = 0; break;
        case 'scalar': damaged.recipient = { ...manifest.recipient, viewingPrivateKey: '0x' + '00'.repeat(32) }; break;
        case 'seed-recipient': damaged.seed = 'different-seed'; break;
        case 'rpc-bytes': damaged.rpcResponseBytes = manifest.rpcResponseBytes + 1; break;
      }
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(damaged));
      await expect(loadFixture(directory)).rejects.toThrow(/manifest\.json|byte count/);
    },
  );

});
