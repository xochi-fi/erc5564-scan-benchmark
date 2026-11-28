// Hybrid sync: finalized feed pages advance the checkpoint; a keyless RPC tail from the last finalized
// block to head shows newer announcements as pending. Pending entries carry their block hash. A tail whose
// blocks change hash (a reorg) replaces the pending set; the checkpoint never moves on tail data.

export interface TailLog { blockNumber: number; blockHash: string; transactionHash: string; logIndex: number }
export interface HybridState {
  /** Last block covered by finalized feed pages and scanned. Only feed data moves it. */
  checkpoint: number;
  /** Tail matches newer than the checkpoint, not yet final. */
  pending: TailLog[];
  /** Block hash per tail block seen in the last poll, for reorg detection. */
  tailHashes: Record<number, string>;
}

export const id = (l: TailLog) => `${l.blockNumber}:${l.blockHash.toLowerCase()}:${l.transactionHash.toLowerCase()}:${l.logIndex}`;

/** Apply finalized feed data up to `finalized`: pending entries at or below it leave the pending set. */
export function applyFinalized(state: HybridState, finalized: number): HybridState {
  if (finalized < state.checkpoint) throw new Error('finalized moved backwards');
  const tailHashes = Object.fromEntries(Object.entries(state.tailHashes).filter(([n]) => Number(n) > finalized));
  return { checkpoint: finalized, pending: state.pending.filter(l => l.blockNumber > finalized), tailHashes };
}

/**
 * Apply one tail poll covering (checkpoint, head]: `matches` are this wallet's matches in that range and
 * `hashes` the block hash of every tail block the poll saw. Returns the new state, the pending entries the
 * poll no longer shows, and the tail blocks whose hash changed.
 */
export function applyTail(state: HybridState, matches: TailLog[], hashes: Record<number, string>): { state: HybridState; dropped: string[]; changedBlocks: number[] } {
  if (matches.some(l => l.blockNumber <= state.checkpoint)) throw new Error('tail match at or below the checkpoint');
  for (const l of matches) {
    const seen = hashes[l.blockNumber];
    if (seen === undefined || seen.toLowerCase() !== l.blockHash.toLowerCase()) throw new Error(`tail match in block ${l.blockNumber} without a matching header`);
  }
  const changed = Object.entries(state.tailHashes)
    .filter(([n, h]) => hashes[Number(n)] !== undefined && hashes[Number(n)]!.toLowerCase() !== h.toLowerCase())
    .map(([n]) => Number(n));
  const next = new Set(matches.map(id));
  const dropped = state.pending.map(id).filter(k => !next.has(k));
  return { state: { checkpoint: state.checkpoint, pending: [...matches], tailHashes: { ...hashes } }, dropped, changedBlocks: changed };
}
