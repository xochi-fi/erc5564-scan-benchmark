import { createHash } from 'node:crypto';
import { filter, hex, identity, rpc, scope, type Window } from '../rpc-recovery/config.ts';
import { rawLogsSchema, type RawLog } from '../paged-discovery/wallet.ts';

export const pageWindows = 4;
export const warmPage = 8;
export const referencePath = 'data/rpc-recovery/reference.json';
export const endpoint = rpc.tenderly;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Row = [number, string, string, number, number, string[], string];
type Reference = {
  agreed: boolean; scope: typeof scope; headHash: string; windows: Window[]; identities: string[];
  captures: { url: string; headHash: string; logs: RawLog[] }[];
};

export function compact(logs: RawLog[], windows: Window[]): Row[] {
  const query = filter(0, 0);
  const ids = new Set<string>();
  return rawLogsSchema.parse(logs).map((log): Row => {
    const block = Number(log.blockNumber);
    const index = Number(log.logIndex);
    const txIndex = Number(log.transactionIndex);
    if (![block, index, txIndex].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !windows.some(({ from, to }) => from <= block && block <= to) || log.removed ||
        log.address.toLowerCase() !== query.address || log.topics[0]?.toLowerCase() !== query.topics[0] ||
        log.topics.length !== 4 || !log.topics.every(topic => /^0x[\da-f]{64}$/i.test(topic)) ||
        ![log.blockHash, log.transactionHash].every(hash => /^0x[\da-f]{64}$/i.test(hash)) ||
        !/^0x(?:[\da-f]{2})*$/i.test(log.data)) throw new Error('Invalid log');
    const id = identity(log);
    if (ids.has(id)) throw new Error('Duplicate log');
    ids.add(id);
    return [block, log.blockHash.toLowerCase(), log.transactionHash.toLowerCase(), index, txIndex,
      log.topics.slice(1).map(topic => topic.toLowerCase()), log.data.toLowerCase()];
  }).sort((a, b) => a[0] - b[0] || a[3] - b[3] || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function expand(rows: Row[]): RawLog[] {
  if (!Array.isArray(rows)) throw new Error('Invalid rows');
  const query = filter(0, 0);
  return rows.map(([block, blockHash, transactionHash, index, txIndex, topics, data]) => ({
    blockNumber: hex(block), blockHash, transactionHash, logIndex: hex(index), transactionIndex: hex(txIndex),
    address: query.address, topics: [query.topics[0]!, ...topics], data,
  }));
}

export async function loadReference() {
  const reference = await Bun.file(referencePath).json() as Reference;
  const { captures, windows, headHash, identities } = reference;
  const [a, b] = captures;
  if (!reference.agreed || digest(reference.scope) !== digest(scope) || windows.length !== 68 ||
      !a || !b || a.url !== rpc.tenderly || b.url !== rpc.sentio || a.headHash !== headHash ||
      b.headHash !== headHash || identities.length !== 48) throw new Error('Unexpected RPC-recovery reference');
  const pages = Array.from({ length: Math.ceil(windows.length / pageWindows) }, (_, index) =>
    windows.slice(index * pageWindows, (index + 1) * pageWindows));
  const manifest = { version: 1, chainId: scope.chainId, head: scope.head, headHash, pages };
  const id = digest(manifest);
  function encode(logs: RawLog[]) {
    const checked = compact(logs, windows);
    if (digest(expand(checked).map(identity).sort()) !== digest([...identities].sort())) {
      throw new Error('Capture identities differ from the RPC-recovery reference');
    }
    return pages.map((windows, index) => ({
      id, index, rows: checked.filter(([block]) => windows.some(({ from, to }) => from <= block && block <= to)),
    }));
  }
  const primary = encode(a.logs);
  const secondary = encode(b.logs);
  if (digest(primary) !== digest(secondary)) throw new Error('Capture payloads disagree');
  return { id, manifest, primary, secondary };
}

export type Feed = Awaited<ReturnType<typeof loadReference>>;
