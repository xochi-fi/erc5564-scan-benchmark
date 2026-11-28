// erc5564-feed/1: manifest, page codec and agreement rule. Normative text: docs/feed-format.md.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';

export const FORMAT = 'erc5564-feed/1';
export const PAGE_BLOCKS = 1_000_000;

/** Chains from docs/chain-volume.md, with the Announcer deploy block recorded there. */
export const FEED_CHAINS = [
  { key: 'ethereum', chainId: 1, deployBlock: 20_042_207 },
  { key: 'base', chainId: 8453, deployBlock: 15_502_414 },
  { key: 'arbitrum', chainId: 42161, deployBlock: 219_468_264 },
  { key: 'optimism', chainId: 10, deployBlock: 121_097_390 },
  { key: 'gnosis', chainId: 100, deployBlock: 34_349_356 },
  { key: 'polygon', chainId: 137, deployBlock: 57_888_814 },
  { key: 'sepolia', chainId: 11155111, deployBlock: 5_486_597 },
] as const;
export type FeedChain = (typeof FEED_CHAINS)[number];

/** A decoded announcement. Hashes, topics and data are lowercase 0x hex; topics excludes topic0. */
export interface Row {
  block: number; blockHash: string; txHash: string; logIndex: number; txIndex: number;
  topics: [string, string, string]; data: string;
}

const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
export const pageEntrySchema = z.strictObject({
  from: z.number().int().nonnegative(), to: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const manifestSchema = z.strictObject({
  format: z.literal(FORMAT),
  chainId: z.number().int().positive(),
  contract: z.literal(ANNOUNCER),
  topic0: z.literal(ANNOUNCEMENT_TOPIC),
  deployBlock: z.number().int().nonnegative(),
  pageBlocks: z.number().int().positive(),
  finalized: z.strictObject({ number: z.number().int().nonnegative(), hash: hash32 }),
  pages: z.array(pageEntrySchema),
  producer: z.strictObject({ feed: z.string(), sources: z.array(z.string()), builtAt: z.string(), code: z.string() }),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type PageEntry = z.infer<typeof pageEntrySchema>;

export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const EMPTY_PAGE = '{"r":[]}';
export const EMPTY_SHA256 = sha256(EMPTY_PAGE);
export const pagePath = (entry: Pick<PageEntry, 'sha256'>) => `p/${entry.sha256}.json`;

/** Page ranges for a chain: a fixed grid from the deploy block, cut at the finalized block. */
export function pageRanges(deployBlock: number, finalized: number, pageBlocks = PAGE_BLOCKS) {
  const ranges: { from: number; to: number }[] = [];
  for (let from = deployBlock; from <= finalized; from += pageBlocks) {
    ranges.push({ from, to: Math.min(finalized, from + pageBlocks - 1) });
  }
  return ranges;
}

const bytes = (hex: string) => Buffer.from(hex.slice(2), 'hex');
const b64 = (buffer: Buffer) => buffer.toString('base64');
function trimZeros(buffer: Buffer) {
  let first = 0;
  while (first < buffer.length && buffer[first] === 0) first++;
  return buffer.subarray(first);
}
function unb64(value: unknown, size: number) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw new Error('Invalid base64');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length > size || b64(buffer) !== value) throw new Error('Invalid base64');
  return '0x' + Buffer.concat([Buffer.alloc(size - buffer.length), buffer]).toString('hex');
}

/** Lowercase hex with each maximal run of 3+ zero bytes written as `g<base36 run length>.`. */
export function zrle(data: string) {
  const buffer = bytes(data);
  let out = '';
  for (let i = 0; i < buffer.length;) {
    let run = 0;
    while (i + run < buffer.length && buffer[i + run] === 0) run++;
    if (run >= 3) {
      out += `g${run.toString(36)}.`;
      i += run;
    } else {
      out += buffer.subarray(i, i + 1).toString('hex');
      i++;
    }
  }
  return out;
}
export function unzrle(value: unknown) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2}|g[1-9a-z][0-9a-z]*\.)*$/.test(value)) throw new Error('Invalid data');
  const hex = value.replace(/g([0-9a-z]+)\./g, (_, run: string) => {
    if (parseInt(run, 36) < 3) throw new Error('Invalid data');
    return '00'.repeat(parseInt(run, 36));
  });
  const data = '0x' + hex;
  if (zrle(data) !== value) throw new Error('Non-canonical data');
  return data;
}

export function compareRows(a: Row, b: Row) {
  return a.block - b.block || a.logIndex - b.logIndex;
}

/** Encodes one page. Rows must lie in [from, to]; output is canonical, so equal rows give equal bytes. */
export function encodePage(rows: Row[], from: number, to: number) {
  const sorted = [...rows].sort(compareRows);
  for (const [i, row] of sorted.entries()) {
    if (row.block < from || row.block > to) throw new Error(`Row outside page ${from}-${to}`);
    if (i && compareRows(sorted[i - 1]!, row) === 0) throw new Error('Duplicate row');
  }
  if (!sorted.length) return EMPTY_PAGE;
  let previous = from;
  const columns = [
    sorted.map(row => { const delta = row.block - previous; previous = row.block; return delta; }),
    sorted.map(row => b64(bytes(row.blockHash))),
    sorted.map(row => b64(bytes(row.txHash))),
    sorted.map(row => row.logIndex),
    sorted.map(row => row.txIndex),
    sorted.map(row => row.topics.map(topic => b64(trimZeros(bytes(topic))))),
    sorted.map(row => zrle(row.data)),
  ];
  return JSON.stringify({ r: columns });
}

const uint = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid integer');
  return value as number;
};

/** Decodes and validates one page body; rejects anything encodePage would not produce. */
export function decodePage(body: string, from: number, to: number): Row[] {
  const page = JSON.parse(body) as unknown;
  if (typeof page !== 'object' || page === null || Object.keys(page).join() !== 'r') throw new Error('Invalid page');
  const columns = (page as { r: unknown }).r;
  if (!Array.isArray(columns)) throw new Error('Invalid page');
  if (!columns.length) {
    if (body !== EMPTY_PAGE) throw new Error('Non-canonical page');
    return [];
  }
  const n = (columns[0] as unknown[] | undefined)?.length ?? 0;
  if (columns.length !== 7 || !n || !columns.every(column => Array.isArray(column) && column.length === n)) {
    throw new Error('Invalid columns');
  }
  const [deltas, blockHashes, txHashes, logIndexes, txIndexes, topics, data] = columns as unknown[][];
  let block = from;
  const rows = Array.from({ length: n }, (_, i): Row => {
    block += uint(deltas![i]);
    const t = topics![i];
    if (!Array.isArray(t) || t.length !== 3) throw new Error('Invalid topics');
    return {
      block, blockHash: unb64(blockHashes![i], 32), txHash: unb64(txHashes![i], 32),
      logIndex: uint(logIndexes![i]), txIndex: uint(txIndexes![i]),
      topics: t.map(topic => unb64(topic, 32)) as Row['topics'], data: unzrle(data![i]),
    };
  });
  if (encodePage(rows, from, to) !== body) throw new Error('Non-canonical page');
  return rows;
}

/** RPC log (hex quantities) to a feed row; throws on anything that is not a canonical Announcer log. */
export function rowFromLog(log: {
  address: string; topics: string[]; data: string; blockNumber: string | number; blockHash: string;
  transactionHash: string; logIndex: string | number; transactionIndex: string | number; removed?: boolean | undefined;
}): Row {
  const lower = (value: string) => value.toLowerCase();
  const topics = log.topics.map(lower);
  const number = (value: string | number) => {
    const parsed = typeof value === 'number' ? value : Number(BigInt(value));
    return uint(parsed);
  };
  if (lower(log.address) !== ANNOUNCER || topics[0] !== ANNOUNCEMENT_TOPIC || topics.length !== 4 || log.removed ||
      !topics.every(topic => /^0x[0-9a-f]{64}$/.test(topic)) ||
      ![log.blockHash, log.transactionHash].every(hash => /^0x[0-9a-f]{64}$/i.test(hash)) ||
      !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) throw new Error('Not a canonical Announcer log');
  return {
    block: number(log.blockNumber), blockHash: lower(log.blockHash), txHash: lower(log.transactionHash),
    logIndex: number(log.logIndex), txIndex: number(log.transactionIndex),
    topics: topics.slice(1) as Row['topics'], data: lower(log.data),
  };
}

/** Builds page entries and bodies for rows over the given ranges. */
export function buildPages(rows: Row[], ranges: { from: number; to: number }[]) {
  return ranges.map(({ from, to }) => {
    const page = rows.filter(row => row.block >= from && row.block <= to);
    const body = encodePage(page, from, to);
    return { entry: { from, to, count: page.length, sha256: sha256(body) } satisfies PageEntry, body };
  });
}

/** Structural checks on one manifest (no network). */
export function checkManifest(manifest: Manifest, chainId: number, deployBlock: number) {
  if (manifest.chainId !== chainId || manifest.deployBlock !== deployBlock) throw new Error('Wrong chain or deploy block');
  const expected = pageRanges(deployBlock, manifest.finalized.number, manifest.pageBlocks);
  if (manifest.pages.length !== expected.length ||
      manifest.pages.some((page, i) => page.from !== expected[i]!.from || page.to !== expected[i]!.to)) {
    throw new Error('Pages do not tile deployBlock..finalized');
  }
  for (const page of manifest.pages) {
    if ((page.count === 0) !== (page.sha256 === EMPTY_SHA256)) throw new Error('Empty page mismatch');
  }
}

export type Fetch = (path: string) => Promise<string>;

/**
 * Agreement between two feeds of one chain. Returns the agreed rows and the last agreed block.
 * Equal entries agree on their digest; a pair of entries with the same `from` and different `to`
 * (one feed is behind) agrees on [from, min(to)] when the decoded rows there are equal.
 */
export async function agree(a: Manifest, b: Manifest, fetchA: Fetch, fetchB: Fetch) {
  if (a.chainId !== b.chainId || a.deployBlock !== b.deployBlock || a.pageBlocks !== b.pageBlocks) {
    throw new Error('Feeds describe different chains');
  }
  const rows: Row[] = [];
  let agreedTo = a.deployBlock - 1;
  let disagreement: { from: number; to: number; reason: string } | null = null;
  let gets = 0;
  const fetchPage = async (fetch: Fetch, entry: PageEntry) => {
    if (entry.count === 0) return [];
    gets++;
    const body = await fetch(pagePath(entry));
    if (sha256(body) !== entry.sha256) throw new Error(`Page ${entry.from} digest mismatch`);
    return decodePage(body, entry.from, entry.to);
  };
  for (let i = 0; i < Math.min(a.pages.length, b.pages.length); i++) {
    const [pa, pb] = [a.pages[i]!, b.pages[i]!];
    if (pa.to === pb.to) {
      if (pa.sha256 !== pb.sha256) { disagreement = { from: pa.from, to: pa.to, reason: 'digest' }; break; }
      let page: Row[];
      try {
        page = await fetchPage(fetchA, pa);
      } catch {
        page = await fetchPage(fetchB, pb);
      }
      if (page.length !== pa.count) throw new Error(`Page ${pa.from} count mismatch`);
      rows.push(...page);
      agreedTo = pa.to;
      continue;
    }
    const to = Math.min(pa.to, pb.to);
    const [ra, rb] = await Promise.all([fetchPage(fetchA, pa), fetchPage(fetchB, pb)]);
    const cut = (page: Row[]) => page.filter(row => row.block <= to);
    if (JSON.stringify(cut(ra)) !== JSON.stringify(cut(rb))) { disagreement = { from: pa.from, to, reason: 'rows' }; break; }
    rows.push(...cut(ra));
    agreedTo = to;
    break;
  }
  return { rows, agreedTo, disagreement, gets };
}
