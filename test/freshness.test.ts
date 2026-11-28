import { describe, expect, test } from 'bun:test';
import { applyFinalized, applyTail, type HybridState, type TailLog } from '../src/freshness/hybrid.ts';

const log = (n: number, hash: string, i = 0): TailLog => ({ blockNumber: n, blockHash: hash, transactionHash: `0xt${n}${hash}`, logIndex: i });

describe('hybrid feed plus RPC tail', () => {
  const start: HybridState = { checkpoint: 100, pending: [], tailHashes: {} };

  test('a tail match is pending and leaves the checkpoint alone', () => {
    const { state } = applyTail(start, [log(105, '0xa')], { 101: '0x1', 105: '0xa', 110: '0xz' });
    expect(state.checkpoint).toBe(100);
    expect(state.pending).toHaveLength(1);
  });

  test('a reorg in the tail drops the pending match and keeps the checkpoint', () => {
    const first = applyTail(start, [log(105, '0xa')], { 105: '0xa', 106: '0xb' }).state;
    const second = applyTail(first, [], { 105: '0xA2', 106: '0xb2' });
    expect(second.state.checkpoint).toBe(100);
    expect(second.state.pending).toHaveLength(0);
    expect(second.dropped).toHaveLength(1);
    expect(second.changedBlocks).toEqual([105, 106]);
  });

  test('the same match on the new branch is re-added under its new hash', () => {
    const first = applyTail(start, [log(105, '0xa')], { 105: '0xa' }).state;
    const second = applyTail(first, [log(106, '0xc')], { 105: '0xa2', 106: '0xc' });
    expect(second.state.pending.map(l => l.blockNumber)).toEqual([106]);
    expect(second.dropped).toHaveLength(1);
  });

  test('finalized feed data moves the checkpoint and retires pending matches', () => {
    const tail = applyTail(start, [log(105, '0xa'), log(120, '0xb')], { 105: '0xa', 120: '0xb' }).state;
    const final = applyFinalized(tail, 110);
    expect(final.checkpoint).toBe(110);
    expect(final.pending.map(l => l.blockNumber)).toEqual([120]);
    expect(() => applyFinalized(final, 109)).toThrow();
  });

  test('a match without a header of the same hash is rejected', () => {
    expect(() => applyTail(start, [log(105, '0xa')], { 105: '0xb' })).toThrow();
    expect(() => applyTail(start, [log(100, '0xa')], { 100: '0xa' })).toThrow();
  });
});
