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

/** One request's outcome. Codes and kinds as in rpc.ts; no addresses or bodies beyond a trimmed message. */
export interface CallOutcome { ok: boolean; kind: string | null; code: number | null; httpStatus: number; rateLimitHits: number }

/** Same checks from every vantage: 10 recent blocks, then the span the 2026-11-26 probe found (whole history from the deploy block). */
export interface EndpointCheck {
  chain: string; host: string;
  recent: CallOutcome;
  span: { blocks: number | 'whole history'; outcome: CallOutcome } | null;
}

export interface RefreshSnapshot {
  kind: 'chain-volume-refresh';
  version: 1;
  date: string;
  measuredAt: string;
  runner: string;
  /** Where the requests came from, e.g. "residential, Europe" or "GitHub-hosted runner, Azure eastus". Never an IP address. */
  vantage: string;
  userAgent: string;
  chains: Record<string, RefreshChain>;
  silent: SilentCheck[];
  endpoints: EndpointCheck[];
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

// ---- vantage comparison -------------------------------------------------------

export const outcomeLabel = (o: CallOutcome) =>
  `${o.ok ? 'OK' : `${o.kind ?? 'error'}${o.code !== null ? ` ${o.code}` : ''}${o.httpStatus !== 200 && o.httpStatus !== 0 ? ` (HTTP ${o.httpStatus})` : ''}`}${o.rateLimitHits > 0 ? `, ${o.rateLimitHits}× 429` : ''}`;

export interface VantageRow { chain: string; host: string; measure: string; cells: string[] }

/**
 * The newest snapshot per vantage, oldest vantage first, and the checks whose results differ between them.
 * Fewer than two vantages: no rows.
 */
export function vantageComparison(snapshots: RefreshSnapshot[]): { columns: Array<{ vantage: string; date: string }>; rows: VantageRow[] } {
  const latest = new Map<string, RefreshSnapshot>();
  for (const snapshot of [...snapshots].sort((a, b) => a.date.localeCompare(b.date))) if (snapshot.vantage && snapshot.endpoints) latest.set(snapshot.vantage, snapshot);
  const picked = [...latest.values()];
  const columns = picked.map(s => ({ vantage: s.vantage, date: s.date }));
  if (picked.length < 2) return { columns, rows: [] };
  const cells = new Map<string, { chain: string; host: string; measure: string; cells: string[] }>();
  const put = (i: number, chain: string, host: string, measure: string, value: string) => {
    const key = `${chain}\u0000${host}\u0000${measure}`;
    const row = cells.get(key) ?? { chain, host, measure, cells: picked.map(() => 'not checked') };
    row.cells[i] = value;
    cells.set(key, row);
  };
  picked.forEach((snapshot, i) => {
    for (const e of snapshot.endpoints) {
      put(i, e.chain, e.host, 'getLogs, 10 recent blocks', outcomeLabel(e.recent));
      if (e.span) put(i, e.chain, e.host, `getLogs, recorded span (${typeof e.span.blocks === 'number' ? e.span.blocks.toLocaleString('en-US') : e.span.blocks})`, outcomeLabel(e.span.outcome));
    }
    for (const c of snapshot.silent) put(i, c.chain, c.host, 'silent recheck', c.verdict);
  });
  const rows = [...cells.values()].filter(row => new Set(row.cells).size > 1);
  return { columns, rows };
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
