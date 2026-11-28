// `bun run tables`: regenerates result tables from data/ and writes them between
// `<!-- generated:NAME -->` and `<!-- /generated:NAME -->` markers in docs/*.md.
// Pass --check to fail instead of writing when a file would change.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CHAIN_LABELS, ROOT, browserSamples, feedSummary, num, pagedControls, pagedRepeat, pagedSingle, readCsv, readJson,
  bestRetrieval, chainLatest, chainRetrieval, perMonth, refreshSnapshots, recoveryReference, recoveryRun, remoteSummary, rpcUnpaced, scanCost, scanEngines, perAnnouncement, spreadOf, REMOTE_HOSTS, type FeedKey, type Row,
  spamCost, omissionCause, freshness, realScan, phoneResults, phoneProxies, realTiming,
} from './data.ts';
import { median } from '../shared/stats.ts';
import { statePerMonth, vantageComparison } from '../chain-volume/refresh-state.ts';

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

const ENGINE_LABELS: Record<string, string> = {
  sdk: 'ScopeLift SDK', noble: 'noble, the SDK\'s curve in a lean loop', wasm: 'libsecp256k1 WASM', native: 'libsecp256k1 native',
};
function scanEnginesTable() {
  const rows = scanEngines();
  const hosts = ['bazzite', 'turing-node-1'];
  const sdk = hosts.map(host => perAnnouncement(rows, host, 'sdk', 1)!);
  const out: string[][] = [];
  for (const engine of ['sdk', 'noble', 'wasm', 'native']) {
    for (const threads of [1, 2, 4]) {
      const each = hosts.map(host => perAnnouncement(rows, host, engine, threads));
      if (each.some(value => value === null)) continue;
      out.push([ENGINE_LABELS[engine]!, String(threads),
        ...each.flatMap((value, i) => [fixed(value! * 1e6, 1), `${fixed(sdk[i]! / value!, 1)}×`])]);
    }
  }
  return table(['Engine', 'Threads', 'Bazzite, µs', 'Speed-up', 'Turing node 1, µs', 'Speed-up'], ['l', 'r', 'r', 'r', 'r', 'r'], out);
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

// Weekly refresh: counts and rates move; everything in chainVolumeTable stays the 2026-11-26 recording.
const BASELINE_DATE = '2026-11-26';
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
function chainRefreshTable() {
  const latest = refreshSnapshots().at(-1);
  if (latest === undefined) return 'No refresh recorded yet.';
  const n = (value: number) => fixed(value, 0);
  const rows = table(['Chain', `Recorded ${BASELINE_DATE}`, `Latest ${latest.date}`, 'Per month', 'Status'], ['l', 'r', 'r', 'r', 'l'],
    Object.keys(CHAIN_LABELS).map(chain => {
      const state = chainLatest(chain);
      const rate = statePerMonth(state);
      const entry = state.latest;
      const status = entry === null || entry.date !== latest.date ? 'not run'
        : entry.status === 'agreed' ? (entry.reason ? `agree (${entry.reason})` : 'agree') : `held: ${entry.reason}`;
      return [CHAIN_LABELS[chain]!, n(bestRetrieval(chain).result.count), n(state.count), rate === null ? '-' : rate.toFixed(1), status];
    }));
  // Silent hosts of 2026-11-26, grouped by today's verdict and chain.
  const hosts = (verdict: string) => {
    const byChain = new Map<string, string[]>();
    for (const c of latest.silent.filter(c => c.verdict === verdict)) byChain.set(c.chain, [...(byChain.get(c.chain) ?? []), `\`${c.host}\``]);
    return [...byChain].map(([chain, names]) => `${CHAIN_LABELS[chain]} ${names.join(', ')}`).join('; ');
  };
  const lines: string[] = [];
  if (hosts('still silent')) lines.push(`Still silent on ${latest.date}: ${hosts('still silent')}.`);
  if (hosts('returns all')) lines.push(`${hosts('returns all')} returned every known announcement this time, after empty answers on ${BASELINE_DATE}.`);
  for (const verdict of ['errors', 'inconclusive']) if (hosts(verdict)) lines.push(`${hosts(verdict)}: ${verdict}.`);
  const { columns, rows: differing } = vantageComparison(refreshSnapshots());
  if (columns.length >= 2) lines.push(`${differing.length} endpoint checks differ between ${list(columns.map(c => `${c.vantage} (${c.date})`))}.`);
  lines.push(`Detail per endpoint and vantage is in [${latest.date}.json](../data/chain-volume/refresh/${latest.date}.json).`);
  return `${rows}\n\n${lines.join(' ')}`;
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

const MODE: Record<string, string> = { cold: 'Cold', warm: 'Warm' };
const one = (values: number[], what: string) => {
  if (new Set(values).size !== 1) throw new Error(`shared-feed: ${what} varies across samples: ${values}`);
  return values[0]!;
};
const feedMedian = (values: number[]) => ms(median(values)!);
const feedSpread = (values: number[]) => {
  const { median, min, max } = spreadOf(values);
  return `${ms(median)} [${ms(min)}–${ms(max)}]`;
};
const REMOTE_LABEL: Record<string, [label: string, rpcDir: string]> = { bazzite: ['Bazzite', ''], 'turing-node-3': ['Turing node 3', 'turing-node-3'] };
/** Remote feed (sequential and concurrent GETs) against live RPC without its pacing wait, per host and mode. */
function feedTable() {
  const rows: string[][] = [];
  for (const host of REMOTE_HOSTS) {
    const [label, rpcDir] = REMOTE_LABEL[host]!;
    const remote = remoteSummary(host);
    const rpc = feedSummary(rpcDir);
    for (const mode of ['cold', 'warm'] as const) {
      const seq = remote[`remote-${mode}`];
      const con = remote[`remote-concurrent-${mode}`];
      const r = rpc[`rpc-${mode}`];
      rows.push([label, MODE[mode]!, feedSpread(seq.elapsedMs), feedSpread(con.elapsedMs), feedSpread(rpcUnpaced(rpcDir)[mode].map(row => row.busyMs)),
        `${one(seq.gets, 'gets')} / ${one(r.posts, 'posts')}`,
        `${fixed(one(seq.wireBytes, 'wire bytes'), 0)} / ${fixed(one(r.responseBytes, 'response bytes'), 0)}`]);
    }
  }
  return table(['Host', 'Mode', 'Feed, sequential GETs (ms)', 'Feed, concurrent GETs (ms)', 'RPC without pacing (ms)', 'GET / POST',
    'Bytes, feed compressed / RPC'], ['l', 'l', 'r', 'r', 'r', 'r', 'r'], rows);
}


// ---- README summary tables ----------------------------------------------------

// ---- writer -------------------------------------------------------------------

// ---- spam cost ------------------------------------------------------------------

const gwei = (wei: number) => {
  const g = wei / 1e9;
  return g === 0 ? '0' : g >= 1 ? fixed(g, 0) : g >= 0.001 ? fixed(g, 3) : g.toExponential(1);
};
const usd = (value: number) => (value >= 100 ? `$${fixed(value, 0)}` : value >= 1 ? `$${fixed(value, 2)}` : value >= 0.01 ? `$${fixed(value, 2)}` : `<$0.01`);
function spamTable() {
  const { chains } = spamCost();
  return table(['Chain', 'Gas, direct / batched', 'Base + p10 tip (gwei)', 'Native (USD)', '100k/day', '1M/day', 'Block gas at 1M/day'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    chains.map(c => [CHAIN_LABELS[c.chain]!, `${fixed(c.directGas, 0)} / ${fixed(c.batchedGas, 0)}`,
      `${gwei(c.baseFeeWei)} + ${gwei(c.tipWei)}`,
      c.native ? `${c.native} ${c.nativeUsd! >= 1 ? fixed(c.nativeUsd!, 2) : fixed(c.nativeUsd!, 3)}` : 'testnet',
      c.usdPerAnnouncement === null ? 'free' : usd(1e5 * c.usdPerAnnouncement),
      c.usdPerAnnouncement === null ? 'free' : usd(1e6 * c.usdPerAnnouncement),
      c.blockShareAt1M === null ? '—' : `${fixed(100 * c.blockShareAt1M, 1)}%`]));
}

// ---- omission cause -------------------------------------------------------------

const OMISSION_CLASS: Record<string, string> = {
  'base.daybreak-rpc.network': 'No receipts or logs: headers only, `[]` for every filter, `block not found` by hash',
  'rpc.degenprotocol.io': 'Intermittent: one pass drops the 1- and 50-block answers, keeps the 1,000-block one',
  'rpc.baseazul.dev': 'Pruned below block 62.5M, served as `[]`, an error or a partial answer',
  'public.1rpc.io': 'Filter bug: `[]` for one block, found in 50 blocks; receipts and canaries vary',
};
function omissionTable() {
  return table(['Provider', 'Known announcements omitted', 'Receipt missing', 'Omissions with an empty Transfer canary', 'Found by another query', 'Class'],
    ['l', 'r', 'r', 'r', 'r', 'l'],
    omissionCause().map(r => [`${r.host} (${CHAIN_LABELS[r.chain]})`, `${r.omitted}/${r.probes}`, `${r.noReceipt}/${r.probes}`,
      `${r.caught}/${r.omitted}`, `${r.otherSizes}/${r.omitted}`, OMISSION_CLASS[r.host] ?? '?']));
}

// ---- freshness ------------------------------------------------------------------

const minSec = (s: number | null) => (s === null ? '-' : s >= 120 ? `${fixed(s / 60, 1)} min` : `${fixed(s, 0)} s`);
function freshnessTable() {
  return table(['Chain', 'RPC-only and hybrid: mined to seen', 'Feed-only: mined to finalized, median [max]', 'Tail blocks', 'Tail requests / bytes per poll', 'Reorged heads', 'Samples'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    freshness().map(f => [CHAIN_LABELS[f.chain]!, minSec(f.headAgeS), `${minSec(f.finalMedianS)} [${minSec(f.finalMaxS)}]`,
      fixed(f.tailBlocks, 0), `${fixed(f.tailRequests, 0)} / ${fixed(f.tailBytes, 0)}`, String(f.reorgs), `${f.samples}${f.errors ? ` (+${f.errors} failed)` : ''}`]));
}

// ---- real announcements ---------------------------------------------------------

function realScanTable() {
  const rows = realScan().chains;
  const d = (c: typeof rows[number], k: string) => fixed(c.defects[k] ?? 0, 0);
  const total = (f: (c: typeof rows[number]) => number) => fixed(rows.reduce((n, c) => n + f(c), 0), 0);
  return table(['Chain', 'Announcements', 'Decoded', 'Scheme ≠ 1', 'Scheme 1, bad key', 'Scheme 1, no view tag', 'Scheme 1, 65-byte key', '`crypto` engine throws', 'SDK batch'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
    [...rows.map(c => [CHAIN_LABELS[c.chain]!, fixed(c.announcements, 0), fixed(c.parsed, 0), d(c, 'other-scheme'), d(c, 'bad-key'), d(c, 'no-view-tag'),
      fixed(c.scheme1KeyBytes['65'] ?? 0, 0), fixed(c.crypto.errors, 0), c.sdkWholeBatch.ok && c.sdkThrowsAlone.length === 0 ? 'completes' : 'throws']),
    ['All', total(c => c.announcements), total(c => c.parsed), total(c => c.defects['other-scheme'] ?? 0), total(c => c.defects['bad-key'] ?? 0),
      total(c => c.defects['no-view-tag'] ?? 0), total(c => c.scheme1KeyBytes['65'] ?? 0), total(c => c.crypto.errors), rows.every(c => c.sdkWholeBatch.ok) ? 'completes' : 'throws']]);
}

function realTimingTable() {
  const t = realTiming('turing-node-3').timing;
  const each = (ms: number[], n: number) => { const s = spreadOf(ms.map(v => v / n)); return `${fixed(s.median, 3)} [${fixed(s.min, 3)}-${fixed(s.max, 3)}]`; };
  return table(['Host', 'Input', 'Announcements', 'ms each, median [min-max]'], ['l', 'l', 'r', 'r'], [
    ['Turing node 3', 'Real, scheme 1 without defects', fixed(t.clean, 0), each(t.cleanMs, t.clean)],
    ['Turing node 3', 'Synthetic, same count', fixed(t.clean, 0), each(t.syntheticMs, t.clean)],
    ['Turing node 3', 'Real, all (defects throw early)', fixed(t.all, 0), each(t.allMs, t.all)],
  ]);
}

// ---- batched verification ---------------------------------------------------------

export function pagedBatchedTable() {
  const rows = readCsv('data/paged-discovery/batched.csv');
  const key = (r: Row) => [r.host, r.count, r.scenario, r.pageBlocks].join('|');
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const cell = (r: Row | undefined, m: string, digits: number) => (r ? `${fixed(num(r[`${m}Median`])!, digits)} [${fixed(num(r[`${m}Min`])!, digits)}-${fixed(num(r[`${m}Max`])!, digits)}]` : 'pending');
  return table(['Host', 'Size', 'Scenario', 'Page blocks', 'Payments', 'Verify s, sequential', 'Verify s, batched', 'Total s, sequential', 'Total s, batched'],
    ['l', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'r'],
    [...groups.values()].map(g => {
      const seq = g.find(r => r.verifyMode === 'sequential'), bat = g.find(r => r.verifyMode === 'batched');
      const r = (seq ?? bat)!;
      return [({ bazzite: 'Bazzite i7-13700K', turing: 'Turing RK1 A76 (nodes 2-3)' } as Record<string, string>)[r.host!] ?? r.host!, fixed(Number(r.count), 0), r.scenario === 'cold' ? 'cold rescan' : '64-block catch-up', r.pageBlocks!, r.matches!,
        cell(seq, 'verifyS', 2), cell(bat, 'verifyS', 2), cell(seq, 'totalS', 1), cell(bat, 'totalS', 1)];
    }));
}

// ---- phone bench -----------------------------------------------------------------

function phoneProxyTable() {
  return table(['Host', 'Runtime', 'JIT', 'Engine', 'ms per announcement'], ['l', 'l', 'l', 'l', 'r'],
    phoneProxies().map((r: Record<string, any>) => [r.host, r.runtime, r.jit === 'on' ? 'on' : 'off (`BUN_JSC_useJIT=0`)', r.engine, fixed(r.msPerAnnouncement, 2)]));
}

function phoneTable() {
  const rows = phoneResults();
  const header = ['Device', 'OS', 'Browser', 'JIT', 'Engine', 'Announcements', 'ms per announcement', 'Credit'];
  if (rows.length === 0) return table(header, ['l', 'l', 'l', 'l', 'l', 'r', 'r', 'l'], [['No results yet', '', '', '', '', '', '', '']]);
  return table(header, ['l', 'l', 'l', 'l', 'l', 'r', 'r', 'l'], rows.map(r => [r.device, r.os, r.browser, r.jit, r.engine, fixed(r.count, 0),
    fixed(r.msPerAnnouncement, 2), r.source ? `@${r.source}` : '-']));
}

const TABLES: Record<string, [file: string, render: () => string]> = {
  'scan-engines': ['docs/scan-cost.md', scanEnginesTable],
  'paged-cold': ['docs/paged-discovery.md', pagedColdTable],
  'paged-catchup': ['docs/paged-discovery.md', pagedCatchupTable],
  'paged-single-controls': ['docs/paged-discovery.md', pagedSingleControlsTable],
  'paged-single-cold': ['docs/paged-discovery.md', pagedSingleColdTable],
  'paged-single-catchup': ['docs/paged-discovery.md', pagedSingleCatchupTable],
  'chain-volume': ['docs/chain-volume.md', chainVolumeTable],
  'chain-volume-refresh': ['docs/chain-volume.md', chainRefreshTable],
  'browser-discovery': ['docs/browser-discovery.md', browserTable],
  'recovery-live': ['docs/rpc-recovery.md', recoveryLiveTable],
  'recovery-faults': ['docs/rpc-recovery.md', recoveryFaultTable],
  'shared-feed': ['docs/shared-feed.md', feedTable],
  'spam-cost': ['docs/spam-cost.md', spamTable],
  'omission-cause': ['docs/omission-cause.md', omissionTable],
  'freshness': ['docs/freshness.md', freshnessTable],
  'phone-bench': ['docs/phone-bench.md', phoneTable],
  'phone-proxy': ['docs/phone-bench.md', phoneProxyTable],
  'real-scan': ['docs/real-announcements.md', realScanTable],
  'real-timing': ['docs/real-announcements.md', realTimingTable],
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
