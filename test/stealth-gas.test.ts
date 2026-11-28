import { describe, expect, test } from 'bun:test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { FAKE_PAYMASTER_CODE, mapSlot, STEALTH } from '../src/stealth-gas/run.ts';
import { stealthGas, stealthSpends } from '../src/figures/data.ts';

describe('stealth gas', () => {
  test('fake paymaster returns (bytes "", uint256 0) as 96 bytes', () => {
    // PUSH1 0x40 PUSH1 0 MSTORE PUSH1 0x60 PUSH1 0 RETURN
    expect(FAKE_PAYMASTER_CODE).toBe('0x604060005260606000f3');
  });
  test('mapping slot is keccak(key, slot)', () => {
    expect(mapSlot(STEALTH, 9n)).toBe(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [STEALTH, 9n])));
  });
  test('every option costs more than paying the transfer directly, and a first 7702 spend carries the authorization', () => {
    for (const c of stealthGas()) {
      for (const option of ['umbra', 'permit', 'aaSponsored', 'aaTokenFee'] as const) expect(c.extra[option].gas).toBeGreaterThan(0);
      // EIP-7702: 25,000 per authorization of an empty account, less the 2,500 saved by the authority being warm.
      if (c.chain !== 'sepolia') expect(c.extra.aaSponsored.gas - c.extra.aaSponsoredLater.gas).toBe(22_500);
    }
  });
  test('recorded spends parse and every link names a heuristic', () => {
    const rows = stealthSpends();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect([null, 'registrant', 'same sender', 'payer submits', 'gas funder']).toContain(r.link);
  });
});
