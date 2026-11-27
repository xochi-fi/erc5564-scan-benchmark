// `bun run tables`: regenerates result tables from data/ and writes them between
// `<!-- generated:NAME -->` and `<!-- /generated:NAME -->` markers in docs/*.md.
// Pass --check to fail instead of writing when a file would change.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CHAIN_LABELS, ROOT, browserSamples, feedControls, feedSummary, num, pagedControls, pagedRepeat, pagedSingle, readCsv, readJson,
  bestRetrieval, chainRetrieval, perMonth, recoveryReference, recoveryRun, scanCost, spreadOf, type FeedKey, type FeedSummary, type Row,
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

// Appendix A: the original single run. Plain toFixed, no thousands separators, as recorded.
const SINGLE_LABELS: Record<string, string> = { bazzite: 'Bazzite i7-13700K', 'turing-node-1': 'Turing Pi A76' };
function pagedSingleControlsTable() {
  const control = (dir: string) => {
    const rows = pagedControls(`single-run/${dir}`);
    const get = (label: string) => rows.find(r => r.label === label)!.seconds.toFixed(3);
    return [get('control_before'), get('control_after')];
  };
  const scan = (host: string) => {
    const h = scanCost().find(x => x.host === host)!;
    return range(Math.min(h.before, h.after).toFixed(3), Math.max(h.before, h.after).toFixed(3));
  };
  return table(['Host', 'Before s', 'After s', 'Scan-cost range s'], ['l', 'r', 'r', 'l'], [
    ['Bazzite', ...control('bazzite/sweep'), scan('Bazzite')],
    ['Turing node 1 (10k/100k sweep)', ...control('turing-node-1/sweep'), scan('Turing Pi')],
    ['Turing node 1 (1M run)', ...control('turing-node-1/million'), ''],
  ]);
}
function pagedSingleColdTable() {
  const rows = pagedSingle().filter(r => r.scenario === 'cold' && Number(r.count) >= 100_000 && r.profile !== 'lan'
    && (r.count === '1000000' && r.host !== 'bazzite' ? true : ['1', '16', '256'].includes(r.pageBlocks!)))
    .sort((a, b) => (a.host === b.host ? Number(a.count) - Number(b.count) : 0));
  const f = (value: string | undefined, digits: number) => (value ? Number(value).toFixed(digits) : '-');
  return table(['Host', 'Size', 'Profile', 'Page blocks', 'Network s', 'Scan s', 'Verify s', 'Total s', 'First match s', 'Wire down MiB', 'Wallet peak RSS MiB'],
    ['l', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    rows.map(r => [SINGLE_LABELS[r.host!]!, `${fixed(Number(r.count), 0)}${r.matches === '0' ? ' (zero-match)' : ''}`, r.profile!, r.pageBlocks!,
      f(r.networkS, 1), f(r.scanS, 1), f(r.verifyS, 1), f(r.totalS, 1), f(r.firstMatchS, 2), f(r.wireDownMiB, 0), f(r.peakRssMiB, 0)]));
}
function pagedSingleCatchupTable() {
  const rows = pagedSingle().filter(r => r.scenario === 'catchup');
  const cell = (host: string, counts: string[], profile: string, pages?: (p: number) => boolean) => {
    const totals = rows.filter(r => r.host === host && counts.includes(r.count!) && r.profile === profile && (!pages || pages(Number(r.pageBlocks))))
      .map(r => Number(r.totalS));
    const [low, high] = [Math.min(...totals).toFixed(1), Math.max(...totals).toFixed(1)];
    return low === high ? low : range(low, high);
  };
  const line = (label: string, host: string, counts: string[]) => [label, cell(host, counts, 'none'), cell(host, counts, 'lan'),
    cell(host, counts, 'public', p => p === 1), cell(host, counts, 'public', p => p >= 16)];
  return table(['Host', 'none', 'lan', 'public, 1-block pages', 'public, 16-256-block pages'], ['l', 'l', 'l', 'l', 'l'], [
    line('Bazzite (100k and 1M histories)', 'bazzite', ['100000', '1000000']),
    line('Turing node 1 (100k history)', 'turing-node-1', ['100000']),
  ]);
}

// ---- chain volume -------------------------------------------------------------

// Curated text the recorded files do not carry: sources compared, dates, indexer notes.
const CHAIN_NOTES: Record<string, { sources: string; perMonth?: string; endpoints?: string; span?: string; indexers: string }> = {
  ethereum: { sources: 'Blockscout v2 = Routescan = RPC (2 endpoint sets)', perMonth: '30-36 in each of the last 3 months',
    indexers: 'Blockscout v2 OK (50/page); Routescan OK (100/page, ~441 blocks behind head); Blockscout etherscan-API timed out (90 s) or 429' },
  base: { sources: 'RPC only (matches both partial runs on their silent-free prefixes)', endpoints: '3 of the 11 return silent empty results',
    indexers: 'Blockscout: Cloudflare challenge (blocked); Basescan/Etherscan: key required' },
  arbitrum: { sources: 'RPC (2 endpoint sets agree)', indexers: 'Blockscout: Cloudflare challenge (blocked)' },
  optimism: { sources: 'Blockscout v2 = Blockscout etherscan-API = RPC', indexers: 'Blockscout (explorer.optimism.io) OK' },
  gnosis: { sources: 'RPC (2 endpoint sets agree)', indexers: 'Blockscout: Cloudflare challenge (blocked)' },
  polygon: { sources: 'RPC (2 endpoint sets agree)', indexers: 'Blockscout: Cloudflare challenge (blocked)' },
  sepolia: { sources: 'Routescan = RPC (2 endpoint sets); **Blockscout has 1,026**', span: 'ethereum-sepolia-rpc.publicnode.com',
    indexers: 'Blockscout v2 and etherscan-API: 13 missing; Routescan OK' },
};
function chainVolumeTable() {
  const summary = readCsv('data/chain-volume/summary.csv');
  const n = (value: number) => fixed(value, 0);
  const duration = (ms: number) => (ms < 100_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
  return table(['Chain', 'Deploy block', 'Announcements', 'First - last announcement', 'Per month (since first)',
    'Keyless endpoints: listed / probed / answered getLogs / full history', 'Max span of full-history endpoints, blocks: median [min-max]',
    'Best keyless cold start', 'Naive cold start (chainlist order)', 'Keyless indexers'],
  ['l', 'r', 'l', 'l', 'r', 'l', 'l', 'l', 'l', 'l'],
  summary.map(row => {
    const chain = row.chain!;
    const notes = CHAIN_NOTES[chain]!;
    const retrieve = (strategy: string) => chainRetrieval(chain, strategy);
    const parallel = retrieve('parallel');
    const best = bestRetrieval(chain);
    const naive = retrieve('list-order');
    const date = (time: string | null) => (time ? ` (${time.slice(0, 10)})` : '');
    // Span over endpoints that served the deploy block, as in report.ts; a flagged host is left out of the minimum only.
    const probes = readJson(`data/chain-volume/probe/${chain}.json`).endpoints.filter((p: any) => p.status === 'usable' && p.servesDeployBlock === true);
    const finite = probes.filter((p: any) => !p.range?.unbounded).map((p: any) => ({ host: p.host as string, span: p.range?.maxOk ?? 0 }));
    const whole = probes.length - finite.length;
    const min = Math.min(...finite.filter((p: any) => p.host !== notes.span).map((p: any) => p.span));
    const excluded = finite.find((p: any) => p.host === notes.span);
    const median = row.spanMedianFullArchive === 'whole history' ? 'whole history' : n(Number(row.spanMedianFullArchive));
    const span = `${median} [${n(min)} - ${whole ? 'whole history' : n(Math.max(...finite.map((p: any) => p.span)))}]`
      + (whole ? `; ${whole} took the whole history` : ' (none took the whole history)')
      + (excluded ? ` (one ${excluded.span}-block value excluded: a head-lag artifact, see caveats)` : '');
    const ok = (r: any) => `OK${parallel?.result.success && r === best ? ', parallel' : r.comparison?.exact ? ', exact' : ''}`;
    const bestCell = `${ok(best)}: ${duration(best.result.totalMs)}, ${n(best.result.requests)} requests, ${n(best.result.responseBytes / 1024)} KiB`;
    const naiveCell = naive.result.success
      ? `${ok(naive)}: ${duration(naive.result.totalMs)}, ${n(naive.result.requests)} requests`
      : (() => {
        const stopped = Number(/at block (\d+)/.exec(naive.result.failure)![1]);
        const share = (stopped - naive.result.fromBlock) / (naive.result.toBlock - naive.result.fromBlock);
        return `FAILED: ${n(naive.result.requests)}-request budget spent at ${Math.round(share * 100)}% of history (${duration(naive.result.totalMs)}, ${n(naive.result.count)} announcements so far)`;
      })();
    return [CHAIN_LABELS[chain]!, n(Number(row.deployBlock)), `**${n(best.result.count)}**: ${notes.sources}`,
      `${n(best.result.firstBlock)}${date(best.result.firstTime)} - ${n(best.result.lastBlock)}${date(best.result.lastTime)}`,
      `${perMonth(best).toFixed(1)}${notes.perMonth ? ` (${notes.perMonth})` : ''}`,
      `${row.endpointsListed} / ${row.endpointsProbed} / ${row.endpointsUsable} / ${row.endpointsFullArchive}${notes.endpoints ? ` (${notes.endpoints})` : ''}`,
      span, bestCell, naiveCell, notes.indexers];
  }));
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

export const LIVE_RECOVERY: [string, string, string][] = [
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
export const FAULTS: [string, string, string][] = [
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

function feedControlsTable() {
  const controls = feedControls();
  const { expected } = recoveryReference();
  const samples = readJson('data/shared-feed/evidence.json').samples;
  const committed = (key: string) => `${samples[key].next}/${samples[key].limit}`;
  return table(['Control', 'Committed groups', 'Missed / recovered logs', 'GETs', 'Elapsed (ms)'], ['l', 'r', 'l', 'r', 'r'], [
    ['Empty feed alone', committed('omission-single'), `${controls.omit.expected - controls.omit.observed} missed`, String(controls.omit.gets), ms(controls.omit.elapsedMs)],
    ['Empty feed plus independent source', committed('omission-hold'), `${expected - controls.hold.expected} pending`, String(controls.hold.gets), ms(controls.hold.elapsedMs)],
    ['Resume with corrected source', committed('omission-resume'), `${controls.resume.observed} recovered`, String(controls.resume.gets), ms(controls.resume.elapsedMs)],
    ['Same identities, altered ABI data', committed('payload-hold'), `${expected - controls.altered.expected} pending`, String(controls.altered.gets), ms(controls.altered.elapsedMs)],
  ]);
}

// ---- README summary tables ----------------------------------------------------

// ---- writer -------------------------------------------------------------------

const TABLES: Record<string, [file: string, render: () => string]> = {
  'scan-cost': ['docs/scan-cost.md', scanCostTable],
  'paged-cold': ['docs/paged-discovery.md', pagedColdTable],
  'paged-catchup': ['docs/paged-discovery.md', pagedCatchupTable],
  'paged-single-controls': ['docs/paged-discovery.md', pagedSingleControlsTable],
  'paged-single-cold': ['docs/paged-discovery.md', pagedSingleColdTable],
  'paged-single-catchup': ['docs/paged-discovery.md', pagedSingleCatchupTable],
  'chain-volume': ['docs/chain-volume.md', chainVolumeTable],
  'browser-discovery': ['docs/browser-discovery.md', browserTable],
  'recovery-live': ['docs/rpc-recovery.md', recoveryLiveTable],
  'recovery-faults': ['docs/rpc-recovery.md', recoveryFaultTable],
  'shared-feed': ['docs/shared-feed.md', feedTable],
  'shared-feed-hosts': ['docs/shared-feed.md', feedHostsTable],
  'shared-feed-controls': ['docs/shared-feed.md', feedControlsTable],
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
