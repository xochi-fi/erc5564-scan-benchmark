import { describe, expect, test } from 'bun:test';
import {
  chainState, disjointSets, providerKey, silentVerdict, statePerMonth, stateSinceBaseline,
  type Baseline, type RefreshChain, type RefreshSnapshot,
} from '../src/chain-volume/refresh-state.ts';

const baseline: Baseline = {
  chain: 'base', toBlock: 100, count: 2, identities: ['10:0:0xa', '50:1:0xb'], firstBlock: 10, firstTime: '2026-01-01T00:00:00.000Z',
  lastBlock: 50, lastTime: '2026-06-01T00:00:00.000Z', measuredAt: '2026-11-26T00:00:00.000Z',
};
const entry = (over: Partial<RefreshChain>): RefreshChain => ({
  status: 'agreed', reason: null, fromBlock: 101, toBlock: 200, throughTime: '2026-12-01T00:00:00.000Z', baselineThroughTime: '2026-11-26T00:00:00.000Z',
  sets: [], comparison: null, identities: [], lastTime: null, ...over,
});
const snap = (date: string, chain: RefreshChain): RefreshSnapshot => ({
  kind: 'chain-volume-refresh', version: 1, date, measuredAt: `${date}T00:00:00.000Z`, runner: 'test', userAgent: 'test', chains: { base: chain }, silent: [],
});

describe('weekly refresh state', () => {
  test('no snapshot: the baseline', () => {
    const state = chainState(baseline, []);
    expect(state.count).toBe(2);
    expect(state.throughBlock).toBe(100);
    expect(statePerMonth(state)).toBeNull();
  });

  test('agreed increments add up; a disagreeing run holds the count', () => {
    const state = chainState(baseline, [
      snap('2026-12-07', entry({ fromBlock: 201, toBlock: 300, identities: ['250:0:0xd'], lastTime: '2026-12-06T00:00:00.000Z', throughTime: '2026-12-07T00:00:00.000Z', baselineThroughTime: null })),
      snap('2026-12-01', entry({ identities: ['150:0:0xc'], lastTime: '2026-11-30T00:00:00.000Z' })),
      snap('2026-12-14', entry({ status: 'disagree', fromBlock: 301, toBlock: null, reason: 'x' })),
    ]);
    expect(state.count).toBe(4);
    expect(state.newSinceBaseline).toBe(2);
    expect(state.throughBlock).toBe(300);
    expect(state.lastBlock).toBe(250);
    expect(state.lastTime).toBe('2026-12-06T00:00:00.000Z');
    expect(state.latest?.status).toBe('disagree');
    expect(stateSinceBaseline(state)).toEqual({ days: 11, perDay: 2 / 11 });
  });

  test('a gap between increments is an error', () => {
    expect(() => chainState(baseline, [snap('2026-12-01', entry({ fromBlock: 102 }))])).toThrow(/expected 101/);
  });

  test('an identity outside its range is an error', () => {
    expect(() => chainState(baseline, [snap('2026-12-01', entry({ identities: ['99:0:0xz'] }))])).toThrow(/outside/);
  });
});

describe('endpoint sets', () => {
  test('provider key folds hostnames of one operator', () => {
    expect(providerKey('base.gateway.tenderly.co')).toBe(providerKey('gateway.tenderly.co'));
  });
  test('sets share no provider', () => {
    const hosts = ['base.api.pocket.network', 'base.gateway.tenderly.co', 'gateway.tenderly.co', '8453.rpc.thirdweb.com', 'base.rpc.sentio.xyz']
      .map(host => ({ host, url: `https://${host}` }));
    const [a, b] = disjointSets(hosts, 4);
    const providers = (urls: string[]) => new Set(urls.map(url => providerKey(new URL(url).host)));
    expect([...providers(a)].some(p => providers(b).has(p))).toBe(false);
    expect(a).toEqual(['https://base.api.pocket.network', 'https://8453.rpc.thirdweb.com']);
    expect(b).toEqual(['https://base.gateway.tenderly.co', 'https://gateway.tenderly.co', 'https://base.rpc.sentio.xyz']);
  });
});

describe('silent recheck verdict', () => {
  const check = (outcome: string, control: string) => ({ target: '1:0', attempt: 1, outcome, control, message: null });
  test('empty where the control returned: still silent', () => {
    expect(silentVerdict([check('returned', 'returned'), check('empty', 'returned')])).toBe('still silent');
  });
  test('all returned: returns all', () => expect(silentVerdict([check('returned', 'returned')])).toBe('returns all'));
  test('errors only: errors', () => expect(silentVerdict([check('error: http', 'returned')])).toBe('errors'));
  test('control failed: inconclusive', () => expect(silentVerdict([check('empty', 'error: timeout')])).toBe('inconclusive'));
});
