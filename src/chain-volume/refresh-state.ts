// Weekly refresh snapshots (data/chain-volume/refresh/<date>.json) and the per-chain state they add up to.
// Pure: callers load the files. The 2026-11-26 recordings stay the baseline; each snapshot adds only the
// announcements two disjoint provider sets agreed on since the previous agreed block.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKeyed } from './retrieve.ts';

export type RefreshStatus = 'agreed' | 'disagree' | 'failed';

export interface RefreshSet { endpoints: string[]; head: number | null; success: boolean; failure: string | null; requests: number; count: number | null }

export interface RefreshChain {
  status: RefreshStatus;
  reason: string | null;
  fromBlock: number;
  toBlock: number | null;
  /** Timestamp of toBlock. */
  throughTime: string | null;
  /** Timestamp of the baseline's last checked block, fetched once so recent rates have a start. */
  baselineThroughTime: string | null;
  sets: RefreshSet[];
  comparison: { missing: string[]; extra: string[]; txMismatch: string[] } | null;
  /** New announcements, `block:logIndex:tx`; empty unless the sets agreed. */
  identities: string[];
  /** Timestamp of the last new announcement. */
  lastTime: string | null;
}

export type SilentVerdict = 'still silent' | 'returns all' | 'errors' | 'inconclusive';

export interface SilentCheck {
  chain: string; host: string; url: string; window: number;
  control: string | null;
  checks: Array<{ target: string; attempt: number; outcome: string; control: string; message: string | null }>;
  returned: number; empty: number; errors: number;
  verdict: SilentVerdict;
}

export interface RefreshSnapshot {
  kind: 'chain-volume-refresh';
  version: 1;
  date: string;
  measuredAt: string;
  runner: string;
  userAgent: string;
  chains: Record<string, RefreshChain>;
  silent: SilentCheck[];
}

export interface Baseline {
  chain: string; toBlock: number; count: number; identities: string[];
  firstBlock: number; firstTime: string; lastBlock: number; lastTime: string; measuredAt: string;
}

export interface ChainState {
  chain: string;
  count: number;
  throughBlock: number;
  throughTime: string | null;
  firstTime: string;
  lastBlock: number;
  lastTime: string;
  newSinceBaseline: number;
  baselineThroughTime: string | null;
  /** The newest snapshot's entry for this chain, agreed or not. */
  latest: (RefreshChain & { date: string }) | null;
}

const MONTH_MS = 30.44 * 86400_000;

/** Baseline plus every agreed increment, in date order. A gap or overlap between increments is an error. */
export function chainState(baseline: Baseline, snapshots: RefreshSnapshot[]): ChainState {
  const keys = new Set(baseline.identities.map(row => parseKeyed(row).key));
  const state: ChainState = {
    chain: baseline.chain, count: baseline.count, throughBlock: baseline.toBlock, throughTime: null,
    firstTime: baseline.firstTime, lastBlock: baseline.lastBlock, lastTime: baseline.lastTime,
    newSinceBaseline: 0, baselineThroughTime: null, latest: null,
  };
  for (const snapshot of [...snapshots].sort((a, b) => a.date.localeCompare(b.date))) {
    const entry = snapshot.chains[baseline.chain];
    if (entry === undefined) continue;
    state.latest = { ...entry, date: snapshot.date };
    state.baselineThroughTime ??= entry.baselineThroughTime;
    if (entry.status !== 'agreed' || entry.toBlock === null) continue;
    if (entry.fromBlock !== state.throughBlock + 1) {
      throw new Error(`refresh ${snapshot.date} ${baseline.chain}: starts at ${entry.fromBlock}, expected ${state.throughBlock + 1}`);
    }
    for (const row of entry.identities) {
      const parsed = parseKeyed(row);
      if (parsed.blockNumber < entry.fromBlock || parsed.blockNumber > entry.toBlock) throw new Error(`refresh ${snapshot.date} ${baseline.chain}: ${row} outside its range`);
      if (keys.has(parsed.key)) continue;
      keys.add(parsed.key);
      state.count++;
      state.newSinceBaseline++;
      state.lastBlock = parsed.blockNumber;
      if (entry.lastTime !== null) state.lastTime = entry.lastTime;
    }
    state.throughBlock = entry.toBlock;
    state.throughTime = entry.throughTime;
  }
  return state;
}

/** Announcements per 30.44-day month, first announcement to the last checked block. */
export const statePerMonth = (state: ChainState): number | null =>
  state.throughTime === null ? null : state.count / ((Date.parse(state.throughTime) - Date.parse(state.firstTime)) / MONTH_MS);

/** Announcements per day since the baseline's last checked block. */
export function stateSinceBaseline(state: ChainState): { days: number; perDay: number } | null {
  if (state.throughTime === null || state.baselineThroughTime === null) return null;
  const days = (Date.parse(state.throughTime) - Date.parse(state.baselineThroughTime)) / 86400_000;
  return days > 0 ? { days, perDay: state.newSinceBaseline / days } : null;
}

/** One operator behind several hostnames (gateway.tenderly.co and base.gateway.tenderly.co) counts once. */
export function providerKey(host: string): string {
  return host.split('.').slice(-2).join('.');
}

/** Two endpoint sets with no provider in common, alternating down a preference-ordered list. */
export function disjointSets(hosts: Array<{ url: string; host: string }>, perSet: number): [string[], string[]] {
  const providers = [...new Set(hosts.map(entry => providerKey(entry.host)))];
  const sets: [string[], string[]] = [[], []];
  providers.forEach((provider, i) => {
    const target = sets[i % 2]!;
    for (const entry of hosts) if (providerKey(entry.host) === provider && target.length < perSet) target.push(entry.url);
  });
  return sets;
}

/** Verdict for one silent host: compare its answer per target with a control endpoint's answer for the same window. */
export function silentVerdict(checks: SilentCheck['checks']): SilentVerdict {
  const comparable = checks.filter(check => check.control === 'returned');
  if (comparable.length === 0) return 'inconclusive';
  if (comparable.some(check => check.outcome === 'empty')) return 'still silent';
  if (comparable.every(check => check.outcome === 'returned')) return 'returns all';
  return 'errors';
}

// ---- loading ------------------------------------------------------------------

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** The recorded full-history retrieval a chain's count comes from: parallel where it reached head, else probe-informed. */
export function loadBaseline(dir: string, chain: string): Baseline {
  const path = (strategy: string) => join(dir, 'canonical', `retrieve-${chain}-${strategy}.json`);
  const parallel = existsSync(path('parallel')) ? readJson(path('parallel')) : null;
  const file = parallel?.result.success ? parallel : readJson(path('probe-informed'));
  const r = file.result;
  return {
    chain, toBlock: r.toBlock, count: r.count, identities: file.identities, firstBlock: r.firstBlock, firstTime: r.firstTime,
    lastBlock: r.lastBlock, lastTime: r.lastTime, measuredAt: file.measuredAt,
  };
}

export const REFRESH_DIR = 'refresh';

/** Dated snapshots, oldest first; `before` (YYYY-MM-DD) drops that date and later. */
export function loadSnapshots(dir: string, before?: string): RefreshSnapshot[] {
  const folder = join(dir, REFRESH_DIR);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()
    .filter(name => before === undefined || name.slice(0, 10) < before)
    .map(name => readJson(join(folder, name)) as RefreshSnapshot);
}
