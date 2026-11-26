import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { generateFixture, loadFixture } from '../src/fixtures.ts';
import type { Engine, LoadedFixture } from '../src/model.ts';
import { announcementIdentity, assertMatches, scanAnnouncements } from '../src/worker.ts';

let directory: string | undefined;
let sparse: LoadedFixture;
let zero: LoadedFixture;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stealth-worker-test-'));
  const sparseDirectory = join(directory, 'sparse');
  const zeroDirectory = join(directory, 'zero');
  await generateFixture(sparseDirectory, { count: 12, seed: 'worker-test-sparse', matchEvery: 3 });
  await generateFixture(zeroDirectory, { count: 12, seed: 'worker-test-zero', matchEvery: 0 });
  sparse = await loadFixture(sparseDirectory);
  zero = await loadFixture(zeroDirectory);
});

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

function expectedMatches(fixture: LoadedFixture): AnnouncementLog[] {
  return fixture.manifest.expectedIndices.map((index) => {
    const announcement = fixture.announcements[index];
    if (announcement === undefined) throw new Error(`Invalid test fixture expected index ${index}`);
    return announcement;
  });
}

function firstTwoMatches(): [AnnouncementLog, AnnouncementLog] {
  const matches = expectedMatches(sparse);
  const first = matches[0];
  const second = matches[1];
  if (first === undefined || second === undefined) throw new Error('Sparse test fixture needs two matches');
  return [first, second];
}

const engines: Engine[] = ['sdk', 'crypto'];
for (const engine of engines) {
  describe(`${engine} scan`, () => {
    for (const batchSize of [0, 1, 5, 100]) {
      test(`preserves sparse sender-known matches with batch size ${batchSize}`, async () => {
        const expected = expectedMatches(sparse);
        const identities = expected.map(announcementIdentity);
        const actual = await scanAnnouncements(sparse.announcements, sparse.manifest.recipient, engine, batchSize);
        expect(() => assertMatches(actual, identities)).not.toThrow();
        expect(actual).toHaveLength(4);
      });

      test(`returns no matches with batch size ${batchSize}`, async () => {
        expect(zero.manifest.expectedIndices).toEqual([]);
        const actual = await scanAnnouncements(zero.announcements, zero.manifest.recipient, engine, batchSize);
        expect(actual).toEqual([]);
        expect(() => assertMatches(actual, [])).not.toThrow();
      });

      test(`preserves duplicate input matches with batch size ${batchSize}`, async () => {
        const [first, second] = firstTwoMatches();
        const announcements = [first, first, second, first];
        const expected = announcements.map(announcementIdentity);
        const actual = await scanAnnouncements(announcements, sparse.manifest.recipient, engine, batchSize);
        expect(() => assertMatches(actual, expected)).not.toThrow();
        expect(actual).toHaveLength(4);
      });
    }

    test('handles empty full and incremental inputs', async () => {
      for (const batchSize of [0, 3]) {
        expect(await scanAnnouncements([], sparse.manifest.recipient, engine, batchSize)).toEqual([]);
      }
    });

    test('rejects invalid batch sizes instead of looping', async () => {
      for (const batchSize of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(scanAnnouncements(sparse.announcements, sparse.manifest.recipient, engine, batchSize))
          .rejects.toThrow('batchSize');
      }
    });
  });
}

describe('exact ordered identity verification', () => {

  test('rejects missing and extra matches', () => {
    const [first, second] = firstTwoMatches();
    expect(() => assertMatches([first], [first, second].map(announcementIdentity))).toThrow('count mismatch');
    expect(() => assertMatches([first, second], [announcementIdentity(first)])).toThrow('count mismatch');
  });

  test('rejects wrong identities and incorrect ordering', () => {
    const [first, second] = firstTwoMatches();
    const wrong = { ...first, logIndex: (first.logIndex ?? 0) + 1 };
    expect(announcementIdentity(wrong)).not.toBe(announcementIdentity(first));
    expect(() => assertMatches([wrong], [announcementIdentity(first)])).toThrow('identity mismatch');
    expect(() => assertMatches([second, first], [first, second].map(announcementIdentity))).toThrow('identity mismatch');
  });

  test('rejects changed duplicate multiplicities even when total count matches', () => {
    const [first, second] = firstTwoMatches();
    expect(() => assertMatches([first, second, second], [first, first, second].map(announcementIdentity)))
      .toThrow('identity mismatch');
  });

  test('detects a silent SDK omission using original expected identities', async () => {
    const [first] = firstTwoMatches();
    const expected = [announcementIdentity(first)];
    const actual = await scanAnnouncements(
      [{ ...first, transactionHash: null }], sparse.manifest.recipient, 'sdk', 0,
    );
    expect(actual).toEqual([]);
    expect(() => assertMatches(actual, expected)).toThrow('count mismatch');
  });
});

describe('crypto error propagation', () => {
  test('does not swallow malformed metadata', async () => {
    const [first] = firstTwoMatches();
    await expect(scanAnnouncements([{ ...first, metadata: '0x' }], sparse.manifest.recipient, 'crypto', 0))
      .rejects.toThrow('Invalid metadata format');
  });

  test('does not swallow malformed curve points or unsupported schemes', async () => {
    const [first] = firstTwoMatches();
    await expect(scanAnnouncements([{ ...first, ephemeralPubKey: '0x00' }], sparse.manifest.recipient, 'crypto', 1))
      .rejects.toThrow();
    await expect(scanAnnouncements([{ ...first, schemeId: 2n }], sparse.manifest.recipient, 'crypto', 1))
      .rejects.toThrow();
  });
});

