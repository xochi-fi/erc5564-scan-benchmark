import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFeedA } from '../src/feed/build-a.ts';
import { buildFeedB } from '../src/feed/build-b.ts';
import { FIXTURE_DIR, FIXTURE_TARGET, FIXTURE_TIME, replay, type Exchange } from '../src/feed/fixture.ts';
import {
  agree, decodePage, EMPTY_PAGE, encodePage, manifestSchema, pagePath, pageRanges, rowFromLog, sha256, unzrle, zrle,
  type Manifest, type Row,
} from '../src/feed/format.ts';
import { SOURCES } from '../src/feed/sources.ts';
import { verifyFeeds } from '../src/feed/verify.ts';

const recorded = JSON.parse(await readFile(`${FIXTURE_DIR}/rpc.json`, 'utf8')) as { exchanges: Exchange[] };
const chainDir = (root: string) => join(root, 'v1', String(FIXTURE_TARGET.chainId));

async function tree(root: string) {
  const dir = chainDir(root);
  const pages = (await readdir(join(dir, 'p'))).sort();
  return {
    manifest: await readFile(join(dir, 'manifest.json'), 'utf8'),
    pages: await Promise.all(pages.map(async name => [name, await readFile(join(dir, 'p', name), 'utf8')])),
  };
}
async function build(feed: 'a' | 'b', out: string, exchanges = recorded.exchanges, seedDir?: string) {
  const { transport, post } = replay(exchanges);
  const common = { chains: [FIXTURE_TARGET], outDir: out, now: () => FIXTURE_TIME, ...(seedDir ? { seedDir } : {}) };
  return feed === 'a'
    ? buildFeedA({ feed: 'a', transport, sources: { gnosis: SOURCES.a.gnosis }, ...common })
    : buildFeedB({ post, sources: { gnosis: SOURCES.b.gnosis }, pause: async () => {}, ...common });
}

const row = (block: number, logIndex: number, data = '0x'): Row => ({
  block, blockHash: '0x' + 'ab'.repeat(32), txHash: '0x' + '0c'.repeat(32), logIndex, txIndex: 2,
  topics: ['0x' + '0'.repeat(63) + '1', '0x' + '0'.repeat(24) + 'f7'.repeat(20), '0x' + '0'.repeat(64)], data,
});

describe('format', () => {
  test('zero-run data encoding round-trips and is canonical', () => {
    for (const data of ['0x', '0x00', '0x0000', '0x000000', '0x0a00000000b0', '0x' + '00'.repeat(40) + 'ff' + '00'.repeat(3)]) {
      expect(unzrle(zrle(data))).toBe(data);
    }
    expect(zrle('0x0a00000000b0')).toBe('0ag4.b0');
    expect(() => unzrle('g2.')).toThrow();
    expect(() => unzrle('g3.g3.')).toThrow();
  });
  test('pages round-trip, reject non-canonical bodies and tile the grid', () => {
    const rows = [row(105, 3, '0x00000001'), row(101, 0), row(105, 1)];
    const body = encodePage(rows, 100, 199);
    expect(decodePage(body, 100, 199)).toEqual([...rows].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex));
    expect(encodePage([], 100, 199)).toBe(EMPTY_PAGE);
    expect(() => decodePage(body.replace('{"r"', '{ "r"'), 100, 199)).toThrow();
    expect(() => encodePage([row(99, 0)], 100, 199)).toThrow();
    expect(() => encodePage([row(101, 0), row(101, 0)], 100, 199)).toThrow();
    expect(pageRanges(10, 34, 10)).toEqual([{ from: 10, to: 19 }, { from: 20, to: 29 }, { from: 30, to: 34 }]);
  });
  test('rejects logs from another contract or event', () => {
    const log = { address: '0x55649e01b5df198d18d95b5cc5051630cfd45564', blockNumber: '0x10', blockHash: '0x' + '1'.repeat(64),
      transactionHash: '0x' + '2'.repeat(64), logIndex: '0x0', transactionIndex: '0x0', data: '0x',
      topics: ['0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7', ...row(1, 0).topics] };
    expect(rowFromLog(log).block).toBe(16);
    expect(() => rowFromLog({ ...log, address: '0x' + '0'.repeat(40) })).toThrow();
    expect(() => rowFromLog({ ...log, topics: log.topics.slice(0, 3) })).toThrow();
  });
});

describe('builders on recorded RPC', () => {
  test('feed A and feed B reproduce the committed fixture byte for byte', async () => {
    const work = await mkdtemp(join(tmpdir(), 'feed-'));
    try {
      for (const feed of ['a', 'b'] as const) {
        const [report] = await build(feed, join(work, feed));
        expect(report!.stop).toBeNull();
        expect(report!.published).toBe(FIXTURE_TARGET.maxBlock);
        expect(await tree(join(work, feed))).toEqual(await tree(join(FIXTURE_DIR, feed)));
      }
      const a = await tree(join(work, 'a'));
      const b = await tree(join(work, 'b'));
      expect(b.pages).toEqual(a.pages);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test('a page the two sources disagree on is not published', async () => {
    const work = await mkdtemp(join(tmpdir(), 'feed-'));
    try {
      // publicnode answers [] where it returned the first announcement: an injected silent omission.
      const tampered = recorded.exchanges.map(exchange => exchange.url === 'https://gnosis-rpc.publicnode.com' &&
        exchange.text.includes('"blockNumber"') ? { ...exchange, text: exchange.text.replace(/"result":\[.*\]/s, '"result":[]') } : exchange);
      const [report] = await build('a', join(work, 'a'), tampered);
      expect(report!.stop).toMatch(/disagree|no new agreed page/);
      expect(report!.published).toBeNull();
      const { exchanges } = recorded;
      const tamperedB = exchanges.map(exchange => exchange.url === 'https://gnosis.oat.farm' &&
        exchange.text.includes('"blockNumber"') ? { ...exchange, text: exchange.text.replace(/"result":\[.*\]/s, '"result":[]') } : exchange);
      const [reportB] = await build('b', join(work, 'b'), tamperedB);
      expect(reportB!.stop).toMatch(/disagree/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test('a rebuild from a seed keeps its whole pages and asks only for the rest', async () => {
    const work = await mkdtemp(join(tmpdir(), 'feed-'));
    try {
      const asked: string[] = [];
      const { transport } = replay(recorded.exchanges);
      const [report] = await buildFeedA({
        feed: 'a', sources: { gnosis: SOURCES.a.gnosis }, chains: [FIXTURE_TARGET], outDir: join(work, 'a'),
        seedDir: join(FIXTURE_DIR, 'a'), now: () => FIXTURE_TIME,
        transport: { request: (url, init) => { asked.push(init.body ?? ''); return transport.request(url, init); } },
      });
      expect(report!.stop).toBeNull();
      // Whole fixture pages are reused, so nothing is fetched: only chain id, finalized and nothing else.
      expect(asked.filter(body => body.includes('eth_getLogs'))).toEqual([]);
      expect(await tree(join(work, 'a'))).toEqual(await tree(join(FIXTURE_DIR, 'a')));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('verifier', () => {
  test('the committed fixture feeds agree', async () => {
    const [result] = await verifyFeeds(join(FIXTURE_DIR, 'a'), join(FIXTURE_DIR, 'b'), [FIXTURE_TARGET]);
    expect(result).toMatchObject({ agreedTo: FIXTURE_TARGET.maxBlock, agreedAnnouncements: 3, announcements: [3, 3], disagreement: null });
  });

  test('a disagreement stops agreement at the last common page; a lagging feed agrees on its prefix', async () => {
    const work = await mkdtemp(join(tmpdir(), 'feed-'));
    try {
      const read = (root: string) => (path: string) => readFile(join(chainDir(root), path), 'utf8');
      const a = manifestSchema.parse(JSON.parse(await readFile(join(chainDir(join(FIXTURE_DIR, 'a')), 'manifest.json'), 'utf8')));
      const last = a.pages.findLastIndex(page => page.count > 0);
      const altered: Manifest = structuredClone(a);
      const page = altered.pages[last]!;
      const body = await read(join(FIXTURE_DIR, 'a'))(pagePath(page));
      const rows = decodePage(body, page.from, page.to);
      rows[0]!.data = rows[0]!.data.slice(0, -2) + (rows[0]!.data.endsWith('00') ? '01' : '00');
      const changed = encodePage(rows, page.from, page.to);
      page.sha256 = sha256(changed);
      await Bun.write(join(chainDir(work), pagePath(page)), changed);
      for (const p of a.pages) await Bun.write(join(chainDir(work), pagePath(p)), await read(join(FIXTURE_DIR, 'a'))(pagePath(p)));
      await writeFile(join(chainDir(work), 'manifest.json'), JSON.stringify(altered));
      const result = await agree(a, altered, read(join(FIXTURE_DIR, 'a')), read(work));
      expect(result.disagreement).toEqual({ from: page.from, to: page.to, reason: 'digest' });
      expect(result.agreedTo).toBe(page.from - 1);

      const behind: Manifest = structuredClone(a);
      behind.pages = behind.pages.slice(0, 2);
      behind.pages[1] = { ...behind.pages[1]!, to: behind.pages[1]!.from + 10 };
      behind.finalized.number = behind.pages[1]!.to;
      const lag = await agree(a, behind, read(join(FIXTURE_DIR, 'a')), read(join(FIXTURE_DIR, 'a')));
      expect(lag.disagreement).toBeNull();
      expect(lag.agreedTo).toBe(behind.pages[1]!.to);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
