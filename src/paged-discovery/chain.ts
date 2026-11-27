import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Constants of the fixture format (src/shared/fixtures.ts). */
export const ENTRIES_PER_BLOCK = 128;
export const FIRST_BLOCK = 20_000_000;
import { ANNOUNCEMENT_TOPIC, ANNOUNCER } from '../shared/announcer.ts';
export { ANNOUNCEMENT_TOPIC, ANNOUNCER };
export const SYNTHETIC_CALLER = '0x0000000000000000000000000000000000000001';
export const CHAIN_ID = '0x1';

const manifestSubsetSchema = z.object({
  count: z.number().int().nonnegative(),
  seed: z.string(),
  matchEvery: z.number().int().nonnegative(),
  fixtureSha256: z.string().regex(/^[0-9a-f]{64}$/),
  expectedIndices: z.array(z.number().int().nonnegative()),
  recipient: z.object({ spendingPublicKey: z.string(), viewingPrivateKey: z.string() }),
}).passthrough();
export type ManifestSubset = z.infer<typeof manifestSubsetSchema>;

const indexedLogSchema = z.object({
  blockNumber: z.string(),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  logIndex: z.string(),
  data: z.string(),
  topics: z.array(z.string()).length(4),
}).passthrough();

export async function readManifest(fixtureDir: string): Promise<ManifestSubset> {
  const path = join(fixtureDir, 'manifest.json');
  const parsed = manifestSubsetSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path}: invalid manifest`, { cause: parsed.error });
  return parsed.data;
}

export interface ChainIndex {
  manifest: ManifestSubset;
  firstBlock: number;
  lastBlock: number;
  /** Byte offset of line i; lineOffsets[count] is the file length. */
  lineOffsets: Float64Array;
  txIndex: Map<string, number>;
  stealthIndex: Map<string, number>;
  file: FileHandle;
}

// Verify the fixture digest and block order, then index on-disk log offsets.
export async function indexFixture(fixtureDir: string): Promise<ChainIndex> {
  const manifest = await readManifest(fixtureDir);
  const path = join(fixtureDir, 'announcements.jsonl');
  const lineOffsets = new Float64Array(manifest.count + 1);
  const txIndex = new Map<string, number>();
  const stealthIndex = new Map<string, number>();
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let pendingStart = 0;
  let line = 0;
  let consumedBytes = 0;

  function consume(text: string, offset: number): void {
    if (line >= manifest.count) throw new Error(`${path}: more rows than manifest count`);
    const row = indexedLogSchema.parse(JSON.parse(text));
    const expectedBlock = FIRST_BLOCK + Math.floor(line / ENTRIES_PER_BLOCK);
    if (Number(BigInt(row.blockNumber)) !== expectedBlock || Number(BigInt(row.logIndex)) !== line % ENTRIES_PER_BLOCK) {
      throw new Error(`${path}:${line + 1}: unexpected block ordering`);
    }
    const stealthTopic = row.topics[2];
    if (stealthTopic === undefined) throw new Error(`${path}:${line + 1}: missing stealth address topic`);
    lineOffsets[line] = offset;
    txIndex.set(row.transactionHash.toLowerCase(), line);
    stealthIndex.set(`0x${stealthTopic.slice(26).toLowerCase()}`, line);
    line += 1;
  }

  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    // Track byte offsets exactly: every row is ASCII JSON, so string length equals bytes.
    pending += decoder.decode(bytes, { stream: true });
    let start = 0;
    for (let end = pending.indexOf('\n', start); end !== -1; end = pending.indexOf('\n', start)) {
      consume(pending.slice(start, end), pendingStart + start);
      start = end + 1;
    }
    pendingStart += start;
    pending = pending.slice(start);
    consumedBytes += bytes.byteLength;
  }
  if (pending.length !== 0) throw new Error(`${path}: truncated final row`);
  if (line !== manifest.count) throw new Error(`${path}: expected ${manifest.count} rows, found ${line}`);
  if (pendingStart !== consumedBytes) throw new Error(`${path}: non-ASCII content breaks offset accounting`);
  const digest = hash.digest('hex');
  if (digest !== manifest.fixtureSha256) throw new Error(`${path}: SHA256 ${digest} differs from manifest ${manifest.fixtureSha256}`);
  lineOffsets[manifest.count] = consumedBytes;
  const blocks = Math.ceil(manifest.count / ENTRIES_PER_BLOCK);
  return {
    manifest,
    firstBlock: FIRST_BLOCK,
    lastBlock: FIRST_BLOCK + Math.max(blocks, 1) - 1,
    lineOffsets,
    txIndex,
    stealthIndex,
    file: await open(path, 'r'),
  };
}

async function readLines(index: ChainIndex, startLine: number, endLine: number): Promise<Buffer> {
  const start = index.lineOffsets[startLine];
  const end = index.lineOffsets[endLine];
  if (start === undefined || end === undefined) throw new Error('line range outside fixture');
  const buffer = Buffer.allocUnsafe(end - start);
  let read = 0;
  while (read < buffer.byteLength) {
    const result = await index.file.read(buffer, read, buffer.byteLength - read, start + read);
    if (result.bytesRead === 0) throw new Error('unexpected end of fixture file');
    read += result.bytesRead;
  }
  return buffer;
}

/** JSON array text of raw logs for lines [startLine, endLine): newline separators become commas. */
async function logsArray(index: ChainIndex, startLine: number, endLine: number): Promise<string> {
  if (endLine <= startLine) return '[]';
  const text = (await readLines(index, startLine, endLine)).toString('latin1');
  return `[${text.slice(0, -1).replaceAll('\n', ',')}]`;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function blockParam(value: unknown, head: number, name: string): number {
  if (value === undefined || value === 'latest' || value === 'safe' || value === 'finalized') return head;
  if (value === 'earliest') return 0;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new RpcError(-32602, `invalid ${name}`);
  return Number(BigInt(value));
}

const getLogsFilterSchema = z.object({
  address: z.union([z.string(), z.array(z.string())]).optional(),
  topics: z.array(z.union([z.string(), z.array(z.string()), z.null()])).optional(),
  fromBlock: z.string().optional(),
  toBlock: z.string().optional(),
}).passthrough();

function addressMatches(filter: z.infer<typeof getLogsFilterSchema>): boolean {
  const addresses = filter.address === undefined ? [ANNOUNCER] : [filter.address].flat().map(a => a.toLowerCase());
  if (!addresses.includes(ANNOUNCER)) return false;
  const topic0 = filter.topics?.[0];
  if (topic0 === undefined || topic0 === null) return true;
  return [topic0].flat().map(t => t.toLowerCase()).includes(ANNOUNCEMENT_TOPIC);
}

const toQuantity = (value: number | bigint): string => `0x${value.toString(16)}`;

/** Serves Announcement logs and the receipt/balance follow-up calls from a fixture. */
export class SyntheticChain {
  head: number;

  constructor(readonly index: ChainIndex) {
    this.head = index.lastBlock;
  }

  private lineAtBlockStart(block: number): number {
    const relative = Math.max(0, block - this.index.firstBlock);
    return Math.min(this.index.manifest.count, relative * ENTRIES_PER_BLOCK);
  }

  private async row(line: number): Promise<Record<string, unknown>> {
    const raw = await readLines(this.index, line, line + 1);
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  }

  private blockOfLine(line: number): number {
    return this.index.firstBlock + Math.floor(line / ENTRIES_PER_BLOCK);
  }

  /** Returns the JSON text of `result`. */
  async call(method: string, params: unknown[]): Promise<string> {
    switch (method) {
      case 'eth_chainId':
        return JSON.stringify(CHAIN_ID);
      case 'eth_blockNumber':
        return JSON.stringify(toQuantity(this.head));
      case 'eth_getLogs': {
        const filter = getLogsFilterSchema.safeParse(params[0]);
        if (!filter.success) throw new RpcError(-32602, 'invalid filter');
        if (!addressMatches(filter.data)) return '[]';
        const from = blockParam(filter.data.fromBlock, this.head, 'fromBlock');
        const to = Math.min(blockParam(filter.data.toBlock, this.head, 'toBlock'), this.head);
        if (from > to) return '[]';
        return logsArray(this.index, this.lineAtBlockStart(from), this.lineAtBlockStart(to + 1));
      }
      case 'eth_getTransactionReceipt': {
        const hash = params[0];
        if (typeof hash !== 'string') throw new RpcError(-32602, 'invalid transaction hash');
        const line = this.index.txIndex.get(hash.toLowerCase());
        if (line === undefined || this.blockOfLine(line) > this.head) return 'null';
        const log = await this.row(line);
        return JSON.stringify({
          blockHash: log.blockHash,
          blockNumber: log.blockNumber,
          contractAddress: null,
          cumulativeGasUsed: toQuantity(60_000 * (1 + (line % ENTRIES_PER_BLOCK))),
          effectiveGasPrice: '0x3b9aca00',
          from: SYNTHETIC_CALLER,
          gasUsed: '0xea60',
          logs: [log],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1',
          to: ANNOUNCER,
          transactionHash: log.transactionHash,
          transactionIndex: log.transactionIndex,
          type: '0x2',
        });
      }
      case 'eth_getBalance': {
        const address = params[0];
        if (typeof address !== 'string') throw new RpcError(-32602, 'invalid address');
        blockParam(params[1], this.head, 'block');
        const line = this.index.stealthIndex.get(address.toLowerCase());
        if (line === undefined || this.blockOfLine(line) > this.head) return JSON.stringify('0x0');
        const log = await this.row(line);
        // Synthetic state: the stealth address holds the ETH amount its announcement metadata states.
        return JSON.stringify(toQuantity(metadataAmount(String(log.data))));
      }
      default:
        throw new RpcError(-32601, `method not supported: ${method}`);
    }
  }
}

// Extract the amount from ETH transfer metadata in ABI-encoded Announcement data.
export function metadataAmount(data: string): bigint {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  const metadataOffset = Number(BigInt(`0x${hex.slice(64, 128)}`)) * 2;
  const length = Number(BigInt(`0x${hex.slice(metadataOffset, metadataOffset + 64)}`));
  if (length < 57) throw new Error('metadata too short for an ETH amount');
  const metadata = hex.slice(metadataOffset + 64, metadataOffset + 64 + length * 2);
  return BigInt(`0x${metadata.slice(50, 114)}`);
}
