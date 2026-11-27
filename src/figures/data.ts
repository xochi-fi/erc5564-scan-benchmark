// Loads recorded results from data/ for `bun run figures` and `bun run tables`.
// Everything here reads committed files only; nothing touches the network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { median } from '../shared/stats.ts';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const path = (relative: string) => `${ROOT}${relative}`;

export type Row = Record<string, string>;

/** RFC 4180 CSV: quoted fields, doubled quotes, no embedded newlines in this repo's files. */
export function parseCsv(text: string): Row[] {
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cell); cell = ''; }
      else cell += c;
    }
    cells.push(cell);
    return cells;
  };
  const [header, ...lines] = text.split('\n').filter(line => line.length > 0).map(parseLine);
  if (!header) return [];
  return lines.map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ''])));
}

export const readCsv = (relative: string) => parseCsv(readFileSync(path(relative), 'utf8'));
export const readJson = <T = any>(relative: string): T => JSON.parse(readFileSync(path(relative), 'utf8')) as T;

export const num = (value: string | undefined): number | null =>
  value === undefined || value === '' ? null : Number(value);

/** Median, min and max of a non-empty sample list. */
export function spreadOf(values: readonly number[]) {
  if (values.length === 0) throw new Error('empty sample list');
  return { median: median(values)!, min: Math.min(...values), max: Math.max(...values) };
}

// ---- scan cost ----------------------------------------------------------------

export interface ScanHost { host: string; cpu: string; before: number; after: number; million: number }
export function scanCost(): ScanHost[] {
  const rows = readCsv('data/scan-cost/results.csv');
  const hosts = [...new Set(rows.map(r => r.host!))];
  return hosts.map(host => {
    const get = (observation: string) => {
      const row = rows.find(r => r.host === host && r.observation === observation);
      if (!row) throw new Error(`scan-cost: ${host} has no ${observation}`);
      return Number(row.scan_seconds);
    };
    return { host, cpu: rows.find(r => r.host === host)!.cpu!, before: get('control_before'), after: get('control_after'), million: get('million_run') };
  });
}

// ---- paged discovery ----------------------------------------------------------

export const pagedRepeat = () => readCsv('data/paged-discovery/repeat.csv');
export const pagedSingle = () => readCsv('data/paged-discovery/single-run.csv');

// ---- chain volume -------------------------------------------------------------

export const STRATEGIES = ['list-order', 'probe-informed', 'parallel'] as const;
export type Strategy = typeof STRATEGIES[number];
export interface ChainRun { strategy: Strategy; success: boolean; requests: number; seconds: number; count: number }
export interface Chain { chain: string; canonical: number; umbra: number | null; runs: ChainRun[] }

export const CHAIN_LABELS: Record<string, string> = {
  ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum One', optimism: 'OP Mainnet',
  gnosis: 'Gnosis', polygon: 'Polygon PoS', sepolia: 'Sepolia',
};

export function chainVolume(): Chain[] {
  return readCsv('data/chain-volume/summary.csv').map(row => {
    const runs = STRATEGIES.flatMap((strategy): ChainRun[] => row[`${strategy}:requests`] ? [{
      strategy,
      success: row[`${strategy}:success`] === 'true',
      requests: Number(row[`${strategy}:requests`]),
      seconds: Number(row[`${strategy}:seconds`]),
      count: Number(row[`${strategy}:count`]),
    }] : []);
    // The canonical count is the full-history count of a run that reached head.
    const complete = runs.filter(run => run.success);
    if (complete.length === 0) throw new Error(`chain-volume: no complete run for ${row.chain}`);
    const counts = new Set(complete.map(run => run.count));
    if (counts.size !== 1) throw new Error(`chain-volume: complete runs disagree for ${row.chain}`);
    let umbra: number | null = null;
    for (const strategy of ['probe-informed', 'parallel']) {
      try {
        const result = readJson(`data/chain-volume/umbra/retrieve-${row.chain}-${strategy}.json`).result;
        if (result.success) umbra = result.count;
      } catch { /* not run for this strategy */ }
    }
    return { chain: row.chain!, canonical: [...counts][0]!, umbra, runs };
  });
}

// ---- browser discovery --------------------------------------------------------

export const browserSamples = () => readCsv('data/browser-discovery/samples.csv');

// ---- RPC recovery -------------------------------------------------------------

export interface RecoveryRun {
  name: string; mode: string; requests: number; fallbackWindows: number; finalNext: number;
  observed: number; missing: number; committedMissing: number | null; unprocessedExpected: number | null;
  stop: string | null; catchUpMs: number | null; elapsedMs: number;
}
export const recoveryRuns = () => readJson<RecoveryRun[]>('data/rpc-recovery/summary.json');
export const recoveryRun = (name: string, mode: string) => {
  const run = recoveryRuns().find(r => r.name === name && r.mode === mode);
  if (!run) throw new Error(`rpc-recovery: no ${name}/${mode}`);
  return run;
};
export function recoveryReference() {
  const ref = readJson('data/rpc-recovery/reference.json');
  return { windows: ref.windows.length as number, expected: (ref.expected as unknown[]).length, pageBlocks: ref.scope.pageBlocks as number };
}

// ---- shared feed --------------------------------------------------------------

export type FeedKey = 'rpc-cold' | 'rpc-warm' | 'dual-cold' | 'dual-warm';
export interface FeedSummary {
  expected: number[]; observed: number[]; posts: number[]; gets: number[]; requestBytes: number[]; responseBytes: number[];
  fetchMs: number[]; scanMs: number[]; verificationMs: number[]; elapsedMs: number[]; firstSyntheticMatchMs: number[];
}
export const feedSummary = (host = '') =>
  readJson<{ summaries: Record<FeedKey, FeedSummary> }>(`data/shared-feed/${host ? `${host}/` : ''}summary.json`).summaries;
