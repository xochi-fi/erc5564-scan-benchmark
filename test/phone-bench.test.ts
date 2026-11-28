import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { html, packedFixture } from '../src/phone-bench/build.ts';
import { runScan } from '../src/phone-bench/scan.ts';

describe('phone bench', () => {
  test('both engines find exactly the scheduled matches in the packed fixture', async () => {
    const fixture = await packedFixture(join(await mkdtemp(join(tmpdir(), 'phone-')), 'fx'), 60, 7);
    for (const engine of ['crypto', 'sdk']) {
      const r = await runScan(fixture, engine, 60, 25);
      expect(r.verified).toBe(true);
      expect(r.matches).toEqual([0, 7, 14, 21, 28, 35, 42, 49, 56]);
    }
    const page = html(fixture, 'void 0', 'void 0');
    expect(page).toContain("connect-src 'none'");
    expect(page).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3)/);
  });
});

import { iphoneCandidates, jitGuess, parseUserAgent } from '../src/phone-bench/detect.ts';
describe('phone bench detection', () => {
  test('parses common user agents', () => {
    const ios = parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1');
    expect(ios).toEqual({ os: 'iOS', osVersion: '18.1', browser: 'Safari', browserVersion: '18.1', device: 'iPhone' });
    const android = parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36');
    expect(android).toMatchObject({ os: 'Android', osVersion: '14', browser: 'Chrome', device: 'Pixel 8' });
    expect(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toMatchObject({ os: 'Linux', browser: 'Safari' });
  });
  test('maps iPhone screens in either orientation to models', () => {
    expect(iphoneCandidates(393, 852, 3)[0]).toContain('15 Pro');
    expect(iphoneCandidates(852, 393, 3)).toEqual(iphoneCandidates(393, 852, 3));
    expect(iphoneCandidates(414, 896, 2)[0]).toContain('XR');
    expect(iphoneCandidates(1000, 1000, 1)).toEqual([]);
  });
  test('guesses Lockdown Mode only from missing WebAssembly on iOS', () => {
    expect(jitGuess('iOS', false).jitGuess).toBe('off-lockdown');
    expect(jitGuess('iOS', true).jitGuess).toBe('on');
    expect(jitGuess('Linux', false).jitGuess).toBe('unknown');
  });
});

import { fromIssue, validate } from '../src/phone-bench/record.ts';
import { PAGE_VERSION, PHONE_PACKED_SHA256 } from '../src/phone-bench/build.ts';
describe('phone bench result validation', () => {
  const good = {
    kind: 'phone-bench', pageVersion: PAGE_VERSION, startedAt: '2026-11-28T01:00:00.000Z', device: 'iPhone 15', os: 'iOS 18.1', browser: 'Safari 18.1', jit: 'on', notes: null,
    detected: { os: 'iOS', osVersion: '18.1', browser: 'Safari', browserVersion: '18.1', device: 'iPhone', deviceCandidates: ['iPhone 16, 15, 15 Pro, 14 Pro'], jitGuess: 'on', jitReason: 'x', uaChModel: null, uaChPlatform: null, uaChPlatformVersion: null },
    userAgent: 'Mozilla/5.0 (iPhone)', screen: { width: 393, height: 852, devicePixelRatio: 3 }, hardwareConcurrency: 6, webAssembly: true, secureContext: true, worker: true,
    engine: 'crypto', count: 1000, chunk: 250, seed: 'phone-bench:v1', fixtureSha256: '63ea0c665c7c8a98fe1643ccddc979c2407fc7748aad87e3addd091c8ff50444', packedSha256: PHONE_PACKED_SHA256,
    scanMs: 1500, msPerAnnouncement: 1.5, matches: 1, expectedMatches: 1, verified: true,
  };
  test('accepts a well-formed result and reads it from an issue form body', () => {
    expect(validate(JSON.stringify(good)).ok).toBe(true);
    const body = `### Result JSON\n\n\`\`\`json\n${JSON.stringify(good, null, 2)}\n\`\`\`\n\n### Credit\n\n- [X] Record my GitHub handle with the result`;
    const parsed = fromIssue(body);
    expect(parsed.credit).toBe(true);
    expect(validate(parsed.json).ok).toBe(true);
  });
  test('rejects tampered or implausible results', () => {
    for (const change of [{ verified: false }, { matches: 2 }, { msPerAnnouncement: 0.5 }, { packedSha256: '0'.repeat(64) }, { count: 2000 }, { extra: 1 }]) {
      expect(validate(JSON.stringify({ ...good, ...change })).ok).toBe(false);
    }
  });
});
