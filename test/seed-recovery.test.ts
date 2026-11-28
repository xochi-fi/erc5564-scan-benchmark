import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { derive } from '../src/seed-recovery/derive.ts';

describe('seed recovery', () => {
  test('recorded key derivations recompute offline', async () => {
    const recorded = JSON.parse(readFileSync(new URL('../data/seed-recovery/derive.json', import.meta.url), 'utf8'));
    expect(await derive()).toEqual(recorded);
  });
});
