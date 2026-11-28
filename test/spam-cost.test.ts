import { describe, expect, test } from 'bun:test';
import { batcherCode, MINIMAL_CALLDATA } from '../src/spam-cost/run.ts';
import { spamCost } from '../src/figures/data.ts';

describe('spam cost', () => {
  test('batcher bytecode jumps land on JUMPDESTs', () => {
    const code = batcherCode(101).slice(2);
    expect(code.length / 2).toBe(57);
    expect(code.slice(9 * 2, 9 * 2 + 2)).toBe('5b');
    expect(code.slice(55 * 2, 55 * 2 + 2)).toBe('5b');
    expect(code.slice(14, 18)).toBe('0065');
  });
  test('minimal announce calldata carries a 33-byte key and 1-byte metadata', () => {
    expect((MINIMAL_CALLDATA.length - 2) / 2).toBe(4 + 32 * 4 + 32 + 64 + 32 + 32);
  });
  test('recorded probes give a batched cost below the direct call on every chain', () => {
    for (const c of spamCost().chains) expect(c.batchedGas).toBeLessThan(c.directGas / 4);
  });
});
