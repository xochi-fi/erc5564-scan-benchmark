// `bun run tables`: regenerates result tables from data/ and writes them between
// `<!-- generated:NAME -->` and `<!-- /generated:NAME -->` markers in docs/*.md and README.md.
// Pass --check to fail instead of writing when a file would change.
import { readFileSync, writeFileSync } from 'node:fs';
import { scope as browserScope } from '../browser-discovery/config.ts';
import {
  CHAIN_LABELS, ROOT, browserSamples, chainVolume, feedSummary, num, pagedRepeat, pagedSingle, readJson,
  recoveryReference, recoveryRun, scanCost, spreadOf, type FeedKey, type FeedSummary, type Row,
} from './data.ts';
import { median } from '../shared/stats.ts';

// ---- formatting ---------------------------------------------------------------

/** `toFixed` rounding (on the binary value) with thousands separators. */
const fixed = (value: number, digits: number) => {
  const [whole, fraction] = value.toFixed(digits).split('.') as [string, string | undefined];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};
/** Shared-feed style: whole milliseconds from 1,000 up, one decimal below. */
const ms = (value: number) => fixed(value, value >= 1000 ? 0 : 1);
const range = (low: string, high: string, dash = '-') => `${low}${dash}${high}`;
const spread = (values: number[], digits: number, dash = '-') => {
  const s = spreadOf(values);
  return `${fixed(s.median, digits)} [${range(fixed(s.min, digits), fixed(s.max, digits), dash)}]`;
};

function table(header: string[], align: ('l' | 'r')[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${align.map(a => (a === 'r' ? '---:' : '---')).join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

// ---- scan cost ----------------------------------------------------------------

const SCAN_HOST_LABELS: Record<string, string> = {
  Bazzite: 'Bazzite, P-core threads 0,2,4,6',
  'Turing Pi': 'Turing node 1, Cortex-A76 cores 4–7',
};
function scanCostTable() {
  return table(['Host', '100k before/after controls, s', '1M, s', '1M / 100k'], ['l', 'l', 'l', 'l'],
    scanCost().map(h => {
      const low = Math.min(h.before, h.after);
      const high = Math.max(h.before, h.after);
      return [SCAN_HOST_LABELS[h.host] ?? h.host, range(h.before.toFixed(3), h.after.toFixed(3), '–'), h.million.toFixed(3),
        range((h.million / high).toFixed(2), (h.million / low).toFixed(2), '–')];
    }));
}

// ---- paged discovery ----------------------------------------------------------

const PAGED_HOST_LABELS: Record<string, string> = { bazzite: 'Bazzite i7-13700K', turing: 'Turing RK1 A76 (nodes 1-3)' };
const SINGLE_HOST: Record<string, string> = { bazzite: 'bazzite', turing: 'turing-node-1' };
const repeatSpread = (row: Row, metric: string, digits: number) => {
  const median = num(row[`${metric}Median`]);
  if (median === null) return '-';
  return `${fixed(median, digits)} [${fixed(num(row[`${metric}Min`])!, digits)}-${fixed(num(row[`${metric}Max`])!, digits)}]`;
};
function singleTotal(row: Row, digits: number) {
  const matches = pagedSingle().filter(s => s.host === SINGLE_HOST[row.host!] && s.count === row.count
    && s.scenario === row.scenario && s.profile === row.profile && s.pageBlocks === row.pageBlocks);
  if (matches.length !== 1) throw new Error(`paged-discovery: ${matches.length} single-run rows for ${JSON.stringify(row)}`);
  return fixed(Number(matches[0]!.totalS), digits);
}
function pagedColdTable() {
  const rows = pagedRepeat().filter(r => r.scenario === 'cold');
  return table(
    ['Host', 'Size', 'Profile', 'Page blocks', 'Network s', 'Scan s', 'Verify s', 'Total s', 'First match s', 'Wallet peak RSS MiB', 'Single-run total s'],
    ['l', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    rows.map(r => [
      PAGED_HOST_LABELS[r.host!]!, `${fixed(Number(r.count), 0)}${r.matches === '0' ? ' (zero-match)' : ''}`, r.profile!, r.pageBlocks!,
      repeatSpread(r, 'networkS', 1), repeatSpread(r, 'scanS', 1), repeatSpread(r, 'verifyS', 2), repeatSpread(r, 'totalS', 1),
      repeatSpread(r, 'firstMatchS', 2), repeatSpread(r, 'peakRssMiB', 0), singleTotal(r, 1),
    ]));
}
function pagedCatchupTable() {
  const rows = pagedRepeat().filter(r => r.scenario === 'catchup');
  return table(['Host', 'History', 'Profile', 'Page blocks', 'Total s', 'Verify s', 'Single-run total s'],
    ['l', 'r', 'l', 'r', 'r', 'r', 'r'],
    rows.map(r => [PAGED_HOST_LABELS[r.host!]!, fixed(Number(r.count), 0), r.profile!, r.pageBlocks!,
      repeatSpread(r, 'totalS', 2), repeatSpread(r, 'verifyS', 2), singleTotal(r, 2)]));
}

// ---- browser discovery --------------------------------------------------------

const BROWSER_ENDPOINTS: [string, string, string][] = [
  // [samples.csv endpoint, label, where a failing endpoint stopped]
  ['pocket', 'Pocket', ''],
  ['blockpi', 'BlockPI', ''],
  ['sentio', 'Sentio', ''],
  ['base', 'Base public RPC', 'on the first log page'],
  ['drpc', 'dRPC', 'on the first log page. The body reported a 100-block free-plan limit.'],
  ['blockscout', 'Blockscout RPC', 'on chain ID'],
];
function browserTable() {
  const samples = browserSamples();
  return table(['Endpoint', 'Completed', 'First fixture match (s)', 'Catch-up (s)', 'Browser fetch (s)', 'RPC calls', 'Real completeness'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'l'],
    BROWSER_ENDPOINTS.map(([endpoint, label, where]) => {
      const rows = samples.filter(s => s.endpoint === endpoint);
      const complete = rows.filter(s => s.reachedHead === 'True' && s.exact === 'True');
      const pair = (field: string, digits: number) => {
        const values = (['fresh', 'resume'] as const).map(mode =>
          median(rows.filter(s => s.mode === mode).map(s => num(s[field])).filter((v): v is number => v !== null)));
        return values.some(v => v === null) ? '—' : values.map(v => (digits ? (v! / 1000).toFixed(digits) : String(v))).join(' / ');
      };
      const expected = rows[0]!.realExpected!;
      const failures = new Set(rows.filter(s => s.errorStatus).map(s => `HTTP ${s.errorStatus}`));
      const completeness = complete.length === rows.length
        ? `Exact ${expected}/${expected} in every run`
        : `${Math.max(...rows.map(s => Number(s.realObserved)))}/${expected} seen before ${[...failures].join(', ')} ${where}`;
      return [label, `${complete.length}/${rows.length}`, pair('firstFixtureMatchMs', 3), pair('catchUpMs', 3),
        pair('networkMs', 3), pair('requests', 0), completeness];
    }));
}

// ---- RPC recovery -------------------------------------------------------------

const LIVE_RECOVERY: [string, string, string][] = [
  ['live-original-probe', 'probe', 'Daybreak, original-width diagnostic'],
  ['live-daybreak-single', 'single', 'Daybreak single'],
  ['live-daybreak-cross', 'cross', 'Daybreak + Tenderly, Sentio fallback'],
  ['live-healthy-single', 'single', 'Tenderly single'],
  ['live-healthy-cross', 'cross', 'Tenderly + Sentio, Pocket on standby'],
];
function recoveryLiveTable() {
  const { expected } = recoveryReference();
  return table(['Live strategy', 'Accepted / expected logs', 'RPC POSTs', 'Third-provider pages', 'Wall time'],
    ['l', 'r', 'r', 'r', 'r'],
    LIVE_RECOVERY.map(([name, mode, label]) => {
      const run = recoveryRun(name, mode);
      const seconds = `${(run.elapsedMs / 1000).toFixed(2)} s`;
      if (mode === 'probe') {
        const pages = readJson(`data/rpc-recovery/${name}-${mode}.json`).windows.length;
        return [label, `${run.observed} / ${expected} observed`, String(run.requests), String(run.fallbackWindows), `${seconds} to probe ${pages} pages`];
      }
      return [label, `${run.observed} / ${expected}`, String(run.requests), String(run.fallbackWindows), seconds];
    }));
}
const FAULTS: [string, string, string][] = [
  ['fixture-omission-single', 'single', 'Silent omission, single'],
  ['fixture-omission-cross', 'cross', 'Silent omission, cross-check'],
  ['fixture-shared-omission', 'cross', 'Shared silent omission, cross-check'],
  ['fixture-equal-count', 'cross', 'Equal counts with different identities'],
  ['fixture-error-single', 'single', 'HTTP 503, single'],
  ['fixture-error-cross', 'cross', 'HTTP 503, cross-check'],
  ['fixture-gate', 'cross', 'Mismatch with JSON-RPC error on fallback'],
  ['fixture-gate', 'resume', 'Resume after fallback recovers'],
];
function recoveryFaultTable() {
  return table(['Fixture', 'Committed windows', 'Missed in committed windows', 'Expected in pending windows', 'RPC POSTs', 'Third-provider pages', 'Elapsed'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    FAULTS.map(([name, mode, label]) => {
      const run = recoveryRun(name, mode);
      const suffix = run.stop ? ' to stop' : mode === 'resume' ? ' after resume' : '';
      return [label, String(run.finalNext), String(run.committedMissing), String(run.unprocessedExpected), String(run.requests),
        String(run.fallbackWindows), `${run.elapsedMs.toFixed(1)} ms${suffix}`];
    }));
}

// ---- shared feed --------------------------------------------------------------

const FEED_PATH: Record<string, string> = { rpc: 'Live RPC', dual: 'Dual feed, loopback' };
const MODE: Record<string, string> = { cold: 'Cold', warm: 'Warm' };
const one = (values: number[], what: string) => {
  if (new Set(values).size !== 1) throw new Error(`shared-feed: ${what} varies across samples: ${values}`);
  return values[0]!;
};
const feedMedian = (values: number[]) => ms(median(values)!);
const feedCatchUp = (s: FeedSummary) => {
  const { median, min, max } = spreadOf(s.elapsedMs);
  return `${ms(median)} [${ms(min)}–${ms(max)}]`;
};
function feedTable() {
  const summaries = feedSummary();
  const keys: FeedKey[] = ['rpc-cold', 'dual-cold', 'rpc-warm', 'dual-warm'];
  return table(['Path', 'Mode', 'Exact logs in sampled range', 'POST / GET', 'Request / response body bytes', 'Fetch (ms)', 'Scan (ms)',
    'Page verification (ms)', 'First synthetic match (ms)', 'Catch-up (ms), median [min–max]'],
  ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
  keys.map(key => {
    const s = summaries[key];
    const [path, mode] = key.split('-') as [string, string];
    return [FEED_PATH[path]!, MODE[mode]!, `${one(s.observed, 'observed')}/${one(s.expected, 'expected')}`,
      `${one(s.posts, 'posts')} / ${one(s.gets, 'gets')}`,
      `${fixed(one(s.requestBytes, 'request bytes'), 0)} / ${fixed(one(s.responseBytes, 'response bytes'), 0)}`,
      feedMedian(s.fetchMs), feedMedian(s.scanMs), feedMedian(s.verificationMs), feedMedian(s.firstSyntheticMatchMs), feedCatchUp(s)];
  }));
}
function feedHostsTable() {
  const hosts: [string, string][] = [['', 'Bazzite'], ['turing-node-1', 'node 1'], ['turing-node-2', 'node 2'], ['turing-node-3', 'node 3']];
  const byHost = hosts.map(([dir, label]) => [label, feedSummary(dir)] as const);
  const rows: string[][] = [];
  for (const mode of ['cold', 'warm']) {
    for (const path of ['rpc', 'dual']) {
      for (const [label, summaries] of byHost) {
        const s = summaries[`${path}-${mode}` as FeedKey];
        rows.push([FEED_PATH[path]!, MODE[mode]!, label, feedMedian(s.fetchMs), feedMedian(s.scanMs), feedMedian(s.verificationMs),
          feedMedian(s.firstSyntheticMatchMs), feedCatchUp(s)]);
      }
    }
  }
  return table(['Path', 'Mode', 'Host', 'Fetch (ms)', 'Scan (ms)', 'Page verification (ms)', 'First synthetic match (ms)', 'Catch-up (ms), median [min–max]'],
    ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r'], rows);
}

// ---- README summary tables ----------------------------------------------------

function recoveryMatrix() {
  const { windows, pageBlocks, expected } = recoveryReference();
  const scope = `Base, ${windows} pinned windows × ${fixed(pageBlocks, 0)} blocks`;
  const feed = feedSummary();
  const controls = readJson('data/shared-feed/summary.json').controls;
  const live = (name: string, mode: string) => recoveryRun(name, mode);
  const s = (value: number) => `${(value / 1000).toFixed(2)} s`;
  const rows: string[][] = [
    ['Daybreak alone', '[RPC recovery](docs/rpc-recovery.md)', `${scope}, live, browser`,
      `${live('live-daybreak-single', 'single').observed}/${expected} ✗`, `${live('live-daybreak-single', 'single').requests} POST`, s(live('live-daybreak-single', 'single').elapsedMs)],
    ['Daybreak cross-checked with Tenderly, Sentio as tiebreaker', '[RPC recovery](docs/rpc-recovery.md)', `${scope}, live, browser`,
      `${live('live-daybreak-cross', 'cross').observed}/${expected} ✓`, `${live('live-daybreak-cross', 'cross').requests} POST`, s(live('live-daybreak-cross', 'cross').elapsedMs)],
    ['Tenderly alone', '[RPC recovery](docs/rpc-recovery.md)', `${scope}, live, browser`,
      `${live('live-healthy-single', 'single').observed}/${expected} ✓`, `${live('live-healthy-single', 'single').requests} POST`, s(live('live-healthy-single', 'single').elapsedMs)],
    ['Live RPC, Bun client', '[Shared feed](docs/shared-feed.md)', `${scope}, live`,
      `${one(feed['rpc-cold'].observed, 'observed')}/${expected} ✓`, `${one(feed['rpc-cold'].posts, 'posts')} POST`, `${s(median(feed['rpc-cold'].elapsedMs)!)} (median of 3)`],
    ['Two independent static feeds', '[Shared feed](docs/shared-feed.md)', `${scope}, **loopback**`,
      `${one(feed['dual-cold'].observed, 'observed')}/${expected} ✓`, `${one(feed['dual-cold'].gets, 'gets')} GET`, `${ms(median(feed['dual-cold'].elapsedMs)!)} ms (median of 3, loopback)`],
    ['One feed that dropped every log', '[Shared feed](docs/shared-feed.md)', `${scope}, **loopback**`,
      `${controls.omit.observed}/${controls.omit.expected} ✗`, `${controls.omit.gets} GET`, `${ms(controls.omit.elapsedMs)} ms (loopback)`],
    ['Same feed plus an independent feed, then resume with a corrected source', '[Shared feed](docs/shared-feed.md)', `${scope}, **loopback**`,
      `held, then ${controls.resume.observed}/${controls.resume.expected} ✓`, `${controls.hold.gets} + ${controls.resume.gets} GET`, `${ms(controls.resume.elapsedMs)} ms after resume (loopback)`],
  ];
  return table(['Strategy', 'Experiment', 'Scope', 'Logs found', 'Requests', 'Time'], ['l', 'l', 'l', 'r', 'r', 'r'], rows);
}

function approachTable() {
  const scan = scanCost();
  const controls = (host: string) => {
    const h = scan.find(x => x.host === host)!;
    return range(fixed(Math.min(h.before, h.after), 1), fixed(Math.max(h.before, h.after), 1), '–');
  };
  const base = chainVolume().find(c => c.chain === 'base')!;
  const run = (strategy: string) => base.runs.find(r => r.strategy === strategy)!;
  const cold = pagedRepeat().find(r => r.host === 'bazzite' && r.scenario === 'cold' && r.count === '1000000' && r.profile === 'public' && r.pageBlocks === '256')!;
  const samples = browserSamples();
  const browserEndpoints = [...new Set(samples.map(s => s.endpoint))];
  const completed = browserEndpoints.filter(e => samples.filter(s => s.endpoint === e).every(s => s.exact === 'True'));
  const requests = (mode: string) => median(samples.filter(s => completed.includes(s.endpoint!) && s.mode === mode).map(s => Number(s.requests)))!;
  // Per completed endpoint, the median catch-up; the cell shows the fastest to slowest endpoint.
  const catchUp = (mode: string) => {
    const medians = completed.map(e => median(samples.filter(s => s.endpoint === e && s.mode === mode).map(s => Number(s.catchUpMs)))! / 1000);
    return range(Math.min(...medians).toFixed(2), Math.max(...medians).toFixed(2), '–');
  };
  const { windows, pageBlocks, expected } = recoveryReference();
  const windowScope = `Base, ${windows} pinned windows × ${fixed(pageBlocks, 0)} blocks`;
  const single = recoveryRun('live-daybreak-single', 'single');
  const cross = recoveryRun('live-daybreak-cross', 'cross');
  const feed = feedSummary()['dual-cold'];
  const minutes = (seconds: number) => `${fixed(seconds / 60, 0)} min`;
  const rows: string[][] = [
    ['Local scan of fetched announcements', '[Scan cost](docs/scan-cost.md)', 'Synthetic 100k, no network', '0',
      `${controls('Bazzite')} s (i7), ${controls('Turing Pi')} s (A76)`, 'Fixture oracle ✓', 'No (Bun CLI)'],
    ['Paged JSON-RPC, cold rescan', '[Paged discovery](docs/paged-discovery.md)', 'Synthetic 1M, emulated 100 ms / 50 Mbit/s link, 256-block pages, i7', '—',
      `${fixed(num(cold.totalSMedian)!, 1)} s median`, 'Fixture oracle ✓', 'No (Bun CLI)'],
    ['Keyless RPC, sequential adaptive', '[Chain volume](docs/chain-volume.md)', 'Base, deploy block to head, live', fixed(run('probe-informed').requests, 0),
      minutes(run('probe-informed').seconds), `✗ budget spent at ${fixed(run('probe-informed').count, 0)} of ${fixed(base.canonical, 0)}`, 'No (Bun CLI)'],
    ['Keyless RPC, parallel backfill', '[Chain volume](docs/chain-volume.md)', 'Base, deploy block to head, live', fixed(run('parallel').requests, 0),
      minutes(run('parallel').seconds), `✓ ${fixed(run('parallel').count, 0)} logs`, 'No (Bun CLI)'],
    ['Public RPC with a saved cursor', '[Browser discovery](docs/browser-discovery.md)', `Base, ${fixed(browserScope.head - browserScope.start + 1, 0)} blocks, live`,
      `${requests('fresh')} fresh / ${requests('resume')} resumed`, `${catchUp('fresh')} s fresh, ${catchUp('resume')} s resumed`, `${completed.length} of ${browserEndpoints.length} endpoints exact`, 'Yes'],
    ['One public RPC (Daybreak)', '[RPC recovery](docs/rpc-recovery.md)', `${windowScope}, live`, `${single.requests} POST`,
      `${(single.elapsedMs / 1000).toFixed(2)} s`, `✗ ${single.observed}/${expected}`, 'Yes'],
    ['Cross-checked RPCs', '[RPC recovery](docs/rpc-recovery.md)', `${windowScope}, live`, `${cross.requests} POST`,
      `${(cross.elapsedMs / 1000).toFixed(2)} s`, `✓ ${cross.observed}/${expected}`, 'Yes'],
    ['Two static feeds', '[Shared feed](docs/shared-feed.md)', `${windowScope}, **loopback**`, `${one(feed.gets, 'gets')} GET`,
      `${ms(median(feed.elapsedMs)!)} ms (loopback)`, `✓ ${one(feed.observed, 'observed')}/${expected}`, 'No (Bun client)'],
  ];
  return table(['Approach', 'Experiment', 'Scope', 'Requests', 'Time', 'Complete', 'In a browser'], ['l', 'l', 'l', 'r', 'r', 'l', 'l'], rows);
}

// ---- writer -------------------------------------------------------------------

const TABLES: Record<string, [file: string, render: () => string]> = {
  'scan-cost': ['docs/scan-cost.md', scanCostTable],
  'paged-cold': ['docs/paged-discovery.md', pagedColdTable],
  'paged-catchup': ['docs/paged-discovery.md', pagedCatchupTable],
  'browser-discovery': ['docs/browser-discovery.md', browserTable],
  'recovery-live': ['docs/rpc-recovery.md', recoveryLiveTable],
  'recovery-faults': ['docs/rpc-recovery.md', recoveryFaultTable],
  'shared-feed': ['docs/shared-feed.md', feedTable],
  'shared-feed-hosts': ['docs/shared-feed.md', feedHostsTable],
  'recovery-matrix': ['README.md', recoveryMatrix],
  'approaches': ['README.md', approachTable],
};

export function renderTables(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [name, [file, render]] of Object.entries(TABLES)) {
    const text = files.get(file) ?? readFileSync(`${ROOT}${file}`, 'utf8');
    const open = `<!-- generated:${name} -->`;
    const close = `<!-- /generated:${name} -->`;
    const start = text.indexOf(open);
    const end = text.indexOf(close);
    if (start < 0 || end < start) throw new Error(`${file}: missing ${open} … ${close}`);
    files.set(file, `${text.slice(0, start + open.length)}\n${render()}\n${text.slice(end)}`);
  }
  return files;
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [file, text] of renderTables()) {
    if (readFileSync(`${ROOT}${file}`, 'utf8') === text) continue;
    stale++;
    if (check) console.error(`${file} is out of date; run bun run tables`);
    else { writeFileSync(`${ROOT}${file}`, text); console.log(`wrote ${file}`); }
  }
  if (check && stale) process.exitCode = 1;
}
