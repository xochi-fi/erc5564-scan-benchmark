import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { html, packedFixture } from '../src/phone-bench/build.ts';
import { runScan } from '../src/phone-bench/page.ts';

describe('phone bench', () => {
  test('both engines find exactly the scheduled matches in the packed fixture', async () => {
    const fixture = await packedFixture(join(await mkdtemp(join(tmpdir(), 'phone-')), 'fx'), 60, 7);
    for (const engine of ['crypto', 'sdk']) {
      const r = await runScan(fixture, engine, 60, 25);
      expect(r.verified).toBe(true);
      expect(r.matches).toEqual([0, 7, 14, 21, 28, 35, 42, 49, 56]);
    }
    const page = html(fixture, 'void 0');
    expect(page).toContain("connect-src 'none'");
    expect(page).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3)/);
  });
});
