// `bun run figures`: writes the summary figures (README and docs) to docs/figures/ from data/.
// Pass --check to fail instead of writing when a figure would change.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CHAIN_LABELS, ROOT, STRATEGIES, bestRetrieval, chainVolume, consistency, feedBytesLog, feedControls, feedEvidence, feedSummary, num, pagedControls,
  pagedRepeat, perMonth, recoveryReference, recoveryRun, recoveryTimeline, scanCost, type Strategy,
} from './data.ts';
import { FAULTS } from './tables.ts';
import { caption, circle, decadeLabel, legend, line, linearScale, logScale, rect, svg, text } from './svg.ts';
import { median } from '../shared/stats.ts';

const fmt = (value: number, digits = 0) =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ---- 1. scan time against real announcement volume ----------------------------

function scanVsVolume(): string {
  const W = 760, L = 78, R = 724, T = 58, B = 300;
  const x = logScale(1, 1e6, L, R);
  const y = logScale(1e-4, 1e4, B, T);
  const hosts = scanCost();
  const chains = chainVolume();
  const out: string[] = [
    text(20, 28, 'Local scan time vs announcements: real histories are tiny next to the synthetic runs', 'title ink'),
  ];
  for (const d of x.decades) {
    out.push(line(x.scale(d), T, x.scale(d), B, 'grid'));
    out.push(text(x.scale(d), B + 16, decadeLabel(d), 'small muted', 'middle'));
  }
  for (const d of y.decades) {
    out.push(line(L, y.scale(d), R, y.scale(d), 'grid'));
    out.push(text(L - 6, y.scale(d) + 4, d >= 1 ? decadeLabel(d) : String(d), 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 32, 'announcements scanned (log)', 'small muted', 'end'));
  out.push(text(L - 52, T - 12, 'scan s (log)', 'small muted'));

  const series: [string, string][] = [['s1', 'i7-13700K (Bazzite)'], ['s2', 'Cortex-A76 (Turing node 1)']];
  hosts.forEach((h, i) => {
    const [cls, label] = series[i]!;
    const perAnnouncement = (h.before + h.after) / 2 / 1e5;
    const at = (n: number) => y.scale(n * perAnnouncement);
    // Dashed: linear extrapolation below the measured range. Solid: the measured 100k-1M span.
    out.push(line(x.scale(1), at(1), x.scale(1e5), at(1e5), cls, ' stroke-width="2" stroke-dasharray="5 4" fill="none"'));
    out.push(line(x.scale(1e5), at(1e5), x.scale(1e6), y.scale(h.million), cls, ' stroke-width="2" fill="none"'));
    out.push(line(x.scale(1e5), y.scale(h.before), x.scale(1e5), y.scale(h.after), cls, ' stroke-width="2"'));
    for (const [n, s, what] of [[1e5, h.before, '100k control before'], [1e5, h.after, '100k control after'], [1e6, h.million, '1M run']] as const) {
      out.push(circle(x.scale(n), y.scale(s), 4.5, cls, `${label}, ${what}: ${fmt(s, 3)} s`, ' stroke-width="2"'));
      out.push(circle(x.scale(n), y.scale(s), 2, 'hollow'));
    }
    // Slower host labelled above its line, faster host below, so labels never sit between the lines.
    out.push(i === 0
      ? text(x.scale(2e3), at(2e3) + 22, `${label}: ${fmt(perAnnouncement * 1000, 2)} ms each`, 'label ink', 'start')
      : text(x.scale(2e3), at(2e3) - 12, `${label}: ${fmt(perAnnouncement * 1000, 2)} ms each`, 'label ink', 'end'));
  });

  // Rugs: each chain's full history, canonical Announcer and Umbra.
  const rug = (rowY: number, label: string, counts: [string, number][], cls: string) => {
    const values = counts.map(([, n]) => n);
    const lo = Math.min(...values), hi = Math.max(...values);
    out.push(rect(x.scale(lo), rowY - 6, x.scale(hi) - x.scale(lo), 12, 'band', undefined, ' rx="3"'));
    for (const [chain, n] of counts) out.push(rect(x.scale(n) - 1.5, rowY - 7, 3, 14, cls, `${chain}: ${fmt(n)} announcements`));
    out.push(text(L - 6, rowY + 4, label, 'small ink', 'end'));
    out.push(text(x.scale(hi) + 8, rowY + 4, `${fmt(lo)}–${fmt(hi)} per chain`, 'small muted'));
  };
  rug(B + 52, 'ERC-5564', chains.map(c => [CHAIN_LABELS[c.chain]!, c.canonical]), 'muted');
  rug(B + 74, 'Umbra', chains.filter(c => c.umbra !== null).map(c => [CHAIN_LABELS[c.chain]!, c.umbra!]), 'muted');

  const a76 = hosts[1]!;
  const a76Rate = (a76.before + a76.after) / 2 / 1e5;
  const largest = Math.max(...chains.map(c => c.umbra ?? 0));
  const ratios = hosts.flatMap(h => [h.million / h.before, h.million / h.after]);
  const ratioRange = `${Math.min(...ratios).toFixed(1)}–${Math.max(...ratios).toFixed(1)}`;
  const controlRange = (values: number[]) => `${fmt(Math.min(...values), 1)}–${fmt(Math.max(...values), 1)}`;
  const notes = caption(20, B + 108, W - 40, [
    `Rug rows: each chain's full history from deployment to head, ${chains.length} chains, 2026-11-26. The largest (Umbra, ${fmt(largest)}) would take about ${fmt(largest * a76Rate, 0)} s on the A76.`,
    `Lines: synthetic zero-match fixtures, crypto engine. Dots are measured. Dashed is a linear extrapolation (1M / 100k measured at ${ratioRange}x).`,
    `Every scan-time estimate in this repo uses these scan-cost 100k controls (i7 ${controlRange([hosts[0]!.before, hosts[0]!.after])} s), not the paged-discovery controls (i7 ${controlRange(pagedControls('repeat/bazzite').map(c => c.seconds))} s).`,
    'Sources: data/scan-cost/results.csv, data/chain-volume/summary.csv, data/chain-volume/umbra/retrieve-*.json.',
    'Details: docs/scan-cost.md, docs/chain-volume.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, 'Scan time against announcement count, log-log', out);
}

// ---- 2. cold-start requests per chain by strategy -----------------------------

const STRATEGY_STYLE: Record<Strategy, [cls: string, label: string]> = {
  'list-order': ['s2', 'Chainlist order'],
  'probe-informed': ['s1', 'Probe-informed'],
  parallel: ['s3', 'Parallel backfill'],
};
function coldStart(): string {
  const chains = chainVolume();
  const W = 760, L = 118, R = 640, T = 64, rowH = 46, barH = 11;
  const B = T + chains.length * rowH;
  const x = logScale(10, 1e5, L, R);
  const out: string[] = [
    text(20, 28, 'Requests to fetch each chain\'s full announcement history, keyless public RPC', 'title ink'),
    ...legend(L, 50, STRATEGIES.map(s => STRATEGY_STYLE[s])),
  ];
  for (const d of x.decades) {
    out.push(line(x.scale(d), T, x.scale(d), B, 'grid'));
    out.push(text(x.scale(d), B + 16, decadeLabel(d), 'small muted', 'middle'));
  }
  out.push(line(L, B, R, B, 'axis'));
  out.push(text(R, B + 32, 'requests (log)', 'small muted', 'end'));
  chains.forEach((chain, i) => {
    const top = T + i * rowH + 6;
    out.push(text(L - 10, top + rowH / 2, CHAIN_LABELS[chain.chain]!, 'label ink', 'end'));
    chain.runs.forEach((run, j) => {
      const [cls, label] = STRATEGY_STYLE[run.strategy];
      const by = top + j * (barH + 2);
      const w = x.scale(run.requests) - L;
      const tip = `${CHAIN_LABELS[chain.chain]}, ${label}: ${fmt(run.requests)} requests, ${fmt(run.seconds, 1)} s, ${run.success ? `${fmt(run.count)} logs` : `stopped after ${fmt(run.count)} logs`}`;
      // A failed run is drawn hollow, so failure is not shown by color alone.
      out.push(run.success
        ? rect(L, by, w, barH, cls, tip, ' rx="2"')
        : rect(L + 1, by + 1, w - 2, barH - 2, cls, tip, ' rx="2" fill-opacity="0.12" stroke-width="2"'));
      out.push(text(L + w + 6, by + barH - 1, run.success ? fmt(run.requests) : `${fmt(run.requests)}, stopped: request budget spent`, 'small ink'));
    });
  });
  const notes = caption(20, B + 56, W - 40, [
    'One run per strategy from a residential IP, ≤4 requests/s per host, 2026-11-26. Hollow bar: stopped before head. Parallel was run only where needed.',
    'Source: data/chain-volume/summary.csv (list-order, probe-informed and parallel requests). Details: docs/chain-volume.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, "Requests to fetch each chain's full history by strategy", out);
}

// ---- 3. paged discovery cost breakdown ----------------------------------------

function pagedBreakdown(): string {
  const rows = pagedRepeat().filter(r => r.host === 'bazzite' && r.scenario === 'cold' && r.count === '1000000');
  const order = rows.sort((a, b) => a.profile!.localeCompare(b.profile!) || Number(a.pageBlocks) - Number(b.pageBlocks));
  const W = 760, L = 150, R = 640, T = 64, rowH = 40, barH = 18;
  const B = T + order.length * rowH;
  const max = Math.ceil(Math.max(...order.map(r => num(r.totalSMedian)!)) / 300) * 300;
  const xs = linearScale(0, max, L, R);
  const parts: [string, string, string][] = [['networkSMedian', 's1', 'Network'], ['scanSMedian', 's2', 'Scan'], ['verifySMedian', 's3', 'Verify']];
  const out: string[] = [
    text(20, 28, 'Where a 1M-announcement cold rescan spends its time, by link and page size', 'title ink'),
    ...legend(L, 50, parts.map(([, cls, label]) => [cls, label])),
  ];
  for (let t = 0; t <= max; t += 300) {
    out.push(line(xs(t), T, xs(t), B, 'grid'));
    out.push(text(xs(t), B + 16, fmt(t), 'small muted', 'middle'));
  }
  out.push(line(L, B, R, B, 'axis'));
  out.push(text(R, B + 32, 'seconds, median of 3', 'small muted', 'end'));
  order.forEach((row, i) => {
    const top = T + i * rowH + (rowH - barH) / 2 - 4;
    out.push(text(L - 10, top + 13, `${row.profile}, ${row.pageBlocks}-block pages`, 'label ink', 'end'));
    let at = 0;
    for (const [field, cls, label] of parts) {
      const value = num(row[field])!;
      // 2px surface gap between segments.
      out.push(rect(xs(at), top, xs(at + value) - xs(at), barH, `${cls}`, `${row.profile}, ${row.pageBlocks}-block pages, ${label}: ${fmt(value, 1)} s`, ' rx="2"'));
      out.push(line(xs(at + value), top, xs(at + value), top + barH, 'gap', ' stroke-width="2"'));
      at += value;
    }
    const total = num(row.totalSMedian)!;
    out.push(text(xs(at) + 6, top + 13, `${fmt(total, 1)} s total`, 'label ink'));
    out.push(text(L, top + barH + 12, parts.map(([field, , label]) => `${label.toLowerCase()} ${fmt(num(row[field])!, 1)}`).join(' · '), 'small muted'));
  });
  const notes = caption(20, B + 56, W - 40, [
    'Bazzite i7-13700K, synthetic 1M announcements with 1,000 payments, oldest-first cold rescan. The link is emulated on loopback: none = no delay, public = 100 ms RTT, 50/20 Mbit/s. Total also includes decode and checkpoints.',
    'Source: data/paged-discovery/repeat.csv. Details: docs/paged-discovery.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, 'Network, scan and verify time for a 1M cold rescan', out);
}

// ---- 4. who caught what: outcome per strategy, fault and endpoint -------------

type Outcome = 'missing' | 'held' | 'complete';
const OUTCOME_COLUMNS: [Outcome, string, string][] = [
  ['missing', 's2', 'logs missing'],
  ['held', 's1', 'held'],
  ['complete', 's3', 'complete'],
];
function outcomeMatrix(): string {
  const { expected, windows } = recoveryReference();
  interface Row { label: string; outcome: Outcome; verified: boolean; note: string }
  const fromRun = (label: string, name: string, mode: string): Row => {
    const run = recoveryRun(name, mode);
    const outcome: Outcome = run.committedMissing ? 'missing' : run.stop ? 'held' : 'complete';
    const note = outcome === 'missing' ? `${expected - run.committedMissing!}/${expected} found, ended without error`
      : outcome === 'held' ? `stopped at window ${run.finalNext}/${windows}, ${run.unprocessedExpected} pending`
        : `${run.observed}/${expected}`;
    return { label, outcome, verified: mode !== 'single', note: `${note} · ${run.requests} POST` };
  };
  const feed = feedSummary()['dual-cold'];
  const controls = (feedEvidence() as any).samples;
  const c = feedControls();
  const fromFeed = (label: string, outcome: Outcome, gets: number, note: string, verified = true): Row =>
    ({ label, outcome, verified, note: `${note} · ${gets} GET` });
  const groups: [string, Row[]][] = [
    [`Live public RPC, Base, ${windows} pinned windows, browser`, [
      fromRun('Daybreak alone', 'live-daybreak-single', 'single'),
      fromRun('Daybreak × Tenderly, Sentio tiebreak', 'live-daybreak-cross', 'cross'),
      fromRun('Tenderly alone', 'live-healthy-single', 'single'),
      fromRun('Tenderly × Sentio, Pocket standby', 'live-healthy-cross', 'cross'),
    ]],
    ['Injected RPC faults, same windows, loopback', FAULTS.map(([name, mode, label]) => fromRun(label, name, mode))],
    ['Static feed controls, same windows, loopback', [
      fromFeed('Two independent feeds', 'complete', median(feed.gets)!, `${median(feed.observed)}/${expected}`),
      fromFeed('One feed that dropped every log', 'missing', c.omit.gets, `${c.omit.observed}/${expected} found, ended without error`, false),
      fromFeed('Empty feed plus independent feed', 'held', c.hold.gets,
        `stopped at group ${controls['omission-hold'].next}/${controls['omission-hold'].limit}, ${expected - c.hold.expected} pending`),
      fromFeed('Resume with corrected source', 'complete', c.resume.gets, `${c.resume.observed}/${expected}`),
      fromFeed('Same identities, altered ABI data', 'held', c.altered.gets,
        `stopped at group ${controls['payload-hold'].next}/${controls['payload-hold'].limit}, ${expected - c.altered.expected} pending`),
    ]],
  ];
  const W = 860, labelEnd = 300, colX = [345, 420, 495], noteX = 540, rowH = 20, groupH = 40;
  const out: string[] = [
    text(20, 28, 'Completeness fails silently: who committed missing logs, who held, who recovered', 'title ink'),
  ];
  let y = 62;
  OUTCOME_COLUMNS.forEach(([, , label], i) => {
    out.push(text(colX[i]!, y, label, 'small ink', 'middle'));
  });
  y += 8;
  for (const [title, rows] of groups) {
    y += groupH;
    out.push(text(20, y - 6, title, 'label muted'));
    out.push(line(20, y, W - 20, y, 'grid'));
    for (const row of rows) {
      y += rowH;
      const col = OUTCOME_COLUMNS.findIndex(([o]) => o === row.outcome);
      const [, cls, outcomeLabel] = OUTCOME_COLUMNS[col]!;
      out.push(text(labelEnd, y + 4, row.label, 'label ink', 'end'));
      for (const x of colX) out.push(circle(x, y, 1.5, 'grid'));
      const tip = `${row.label}: ${outcomeLabel}, ${row.verified ? 'two sources' : 'single source'}; ${row.note}`;
      out.push(row.verified
        ? circle(colX[col]!, y, 6, cls, tip)
        : circle(colX[col]!, y, 5, `${cls} hollow`, tip, ' stroke-width="2.5"'));
      out.push(text(noteX, y + 4, row.note, 'small muted'));
    }
  }

  // Panel B: keyless endpoints that answered a known announcement's window with [].
  const CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'gnosis', 'polygon', 'sepolia'];
  const endpoints = CHAINS.flatMap(consistency);
  const silent = endpoints.filter(e => e.checks.some(ch => ch.outcome === 'empty'));
  const clean = endpoints.filter(e => e.checks.every(ch => ch.outcome === 'returned')).length;
  y += groupH;
  out.push(text(20, y - 6, 'Chain volume: keyless endpoints rechecked twice at known announcements, silent [] in orange', 'label muted'));
  out.push(line(20, y, W - 20, y, 'grid'));
  for (const e of silent) {
    y += rowH;
    out.push(text(labelEnd, y + 4, `${e.host} (${CHAIN_LABELS[e.chain]})`, 'label ink', 'end'));
    e.checks.forEach((ch, i) => {
      const cls = ch.outcome === 'returned' ? 's3' : ch.outcome === 'empty' ? 's2' : 'muted';
      out.push(rect(labelEnd + 26 + i * 16, y - 6, 12, 12, cls, `${e.host}, log ${ch.target}: ${ch.outcome}`, ' rx="2"'));
    });
    const counts = (o: string) => e.checks.filter(ch => ch.outcome === o).length;
    out.push(text(noteX, y + 4, `${counts('empty')} empty, ${counts('returned')} returned, ${e.checks.length - counts('empty') - counts('returned')} errors`, 'small muted'));
  }
  y += rowH;
  out.push(text(20, y + 4, `${clean} of ${endpoints.length} rechecked endpoints on ${CHAINS.length} chains returned every known log; the rest errored on at least one check or, as above, answered [] without an error.`, 'small muted'));

  const notes = caption(20, y + 34, W - 40, [
    'Filled dot: accepted only what two sources agreed on. Hollow: one source, so a complete result cannot be told apart from a silent omission. The runs that miss logs end without an error; only scoring against the frozen reference shows the misses.',
    'Sources: data/rpc-recovery/summary.json, data/shared-feed/summary.json and evidence.json, data/chain-volume/consistency/*.json. Details: docs/rpc-recovery.md, docs/shared-feed.md, docs/chain-volume.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, 'Outcome of each strategy, injected fault and endpoint recheck', out);
}

// ---- 5. cost frontier on the pinned Base windows ------------------------------

function costFrontier(): string {
  const { expected, windows } = recoveryReference();
  const feed = feedSummary();
  const sec = (ms: number) => `${fmt(ms / 1000, 2)} s`;
  interface Point { label: string; requests: number; unit: string; found: number; verified: boolean; time: string; dy: number }
  const live = (label: string, name: string, mode: string, dy: number): Point => {
    const run = recoveryRun(name, mode);
    return { label, requests: run.requests, unit: 'POST', found: run.observed, verified: mode !== 'single', time: sec(run.elapsedMs), dy };
  };
  const one = (values: number[]) => median(values)!;
  // Labels hang below the 48 line (or above the 0 line) at fixed rows, joined to their point by a leader.
  const points: Point[] = [
    { label: 'Two static feeds', requests: one(feed['dual-cold'].gets), unit: 'GET', found: one(feed['dual-cold'].observed), verified: true,
      time: `${fmt(one(feed['dual-cold'].elapsedMs), 1)} ms on loopback, not over the Internet`, dy: 94 },
    live('Tenderly alone, browser', 'live-healthy-single', 'single', 58),
    { label: 'Tenderly alone, Bun client', requests: one(feed['rpc-cold'].posts), unit: 'POST', found: one(feed['rpc-cold'].observed), verified: false,
      time: `${sec(one(feed['rpc-cold'].elapsedMs))} median`, dy: 76 },
    live('Tenderly × Sentio', 'live-healthy-cross', 'cross', 22),
    live('Daybreak × Tenderly, Sentio tiebreak', 'live-daybreak-cross', 'cross', 40),
    live('Daybreak alone', 'live-daybreak-single', 'single', -20),
  ];
  const W = 760, L = 70, R = 720, T = 70, B = 260;
  const max = Math.ceil(Math.max(...points.map(p => p.requests)) / 50) * 50;
  const xs = linearScale(0, max, L, R);
  const ys = linearScale(0, expected, B, T);
  const out: string[] = [
    text(20, 28, `Requests against logs found, Base, ${windows} pinned windows: verified completeness is cheap`, 'title ink'),
    ...legend(L + 160, 52, [['s3', 'two sources agreed'], ['s2', 'single source (hollow)']]),
  ];
  for (let t = 0; t <= max; t += 50) {
    out.push(line(xs(t), T, xs(t), B, 'grid'));
    out.push(text(xs(t), B + 16, fmt(t), 'small muted', 'middle'));
  }
  for (const v of [0, expected / 2, expected]) {
    out.push(line(L, ys(v), R, ys(v), 'grid'));
    out.push(text(L - 8, ys(v) + 4, `${v}`, 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 32, 'requests (POST for RPC, GET for feeds)', 'small muted', 'end'));
  out.push(text(20, 52, `logs found / ${expected}`, 'small muted'));
  for (const p of points) {
    const cls = p.verified ? 's3' : 's2';
    const tip = `${p.label}: ${p.found}/${expected}, ${p.requests} ${p.unit}, ${p.time}`;
    const px = xs(p.requests), py = ys(p.found);
    const ly = py + p.dy;
    const anchor = px > (L + R) / 2 ? 'end' : 'start';
    const tx = anchor === 'end' ? px - 6 : px + 8;
    out.push(line(px, py + Math.sign(p.dy) * 7, px, ly - Math.sign(p.dy) * 4, 'axis'));
    out.push(p.verified ? circle(px, py, 6, cls, tip) : circle(px, py, 5, `${cls} hollow`, tip, ' stroke-width="2.5"'));
    out.push(text(tx, ly + 4, `${p.label}: ${p.requests} ${p.unit}, ${p.time}`, 'small ink', anchor));
  }
  const notes = caption(20, B + 52, W - 40, [
    `All points cover the same ${windows} windows of 1,000 blocks with ${expected} known logs. A single source that finds ${expected} looks the same as one that finds 0: nothing in the run says which. Feeds ran on loopback; remote hosting adds round trips the time does not include.`,
    'Sources: data/rpc-recovery/summary.json (browser runs), data/shared-feed/summary.json (Bun client and feeds). Details: docs/rpc-recovery.md, docs/shared-feed.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, 'Requests against logs found per strategy on the pinned Base windows', out);
}

// ---- 6. accepted logs over wall time, live -------------------------------------

function liveTimeline(): string {
  const { expected, windows } = recoveryReference();
  const runs: [string, string, string, string][] = [
    ['live-daybreak-single', 'single', 's2', 'Daybreak alone'],
    ['live-healthy-single', 'single', 's3', 'Tenderly alone'],
    ['live-healthy-cross', 'cross', 'axis', 'Tenderly × Sentio, Pocket standby'],
    ['live-daybreak-cross', 'cross', 's1', 'Daybreak × Tenderly, Sentio tiebreak'],
  ];
  const series = runs.map(([name, mode, cls, label]) => ({ cls, label, ...recoveryTimeline(name, mode) }));
  const W = 860, L = 60, R = 480, T = 56, B = 250;
  const max = Math.ceil(Math.max(...series.map(s => s.elapsedMs)) / 5000) * 5;
  const xs = linearScale(0, max, L, R);
  const ys = linearScale(0, expected, B, T);
  const out: string[] = [text(20, 28, 'Logs accepted over wall time: the single-RPC failure finishes on time, with nothing', 'title ink')];
  for (let t = 0; t <= max; t += 5) {
    out.push(line(xs(t), T, xs(t), B, 'grid'));
    out.push(text(xs(t), B + 16, `${t}`, 'small muted', 'middle'));
  }
  for (const v of [0, expected / 2, expected]) {
    out.push(line(L, ys(v), R, ys(v), 'grid'));
    out.push(text(L - 8, ys(v) + 4, `${v}`, 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 32, 'seconds since the first request', 'small muted', 'end'));
  out.push(text(L - 40, T - 12, `logs accepted / ${expected}`, 'small muted'));
  // End labels sit right of the plot, spread so they never overlap.
  const labelYs = new Map<string, number>();
  const order = [...series].sort((a, b) => b.points.at(-1)!.accepted - a.points.at(-1)!.accepted || a.elapsedMs - b.elapsedMs);
  let lastY = -Infinity;
  for (const s of order) {
    const yEnd = Math.max(ys(s.points.at(-1)!.accepted), lastY + 16);
    labelYs.set(s.label, yEnd);
    lastY = yEnd;
  }
  for (const s of series) {
    let d = `M${xs(0).toFixed(1)},${ys(0).toFixed(1)}`;
    let prev = 0;
    for (const p of s.points) {
      d += ` H${xs(p.ms / 1000).toFixed(1)}`;
      if (p.accepted !== prev) d += ` V${ys(p.accepted).toFixed(1)}`;
      prev = p.accepted;
    }
    d += ` H${xs(s.elapsedMs / 1000).toFixed(1)}`;
    const dash = s.cls === 'axis' ? ' stroke-dasharray="5 3"' : '';
    out.push(`<path d="${d}" class="${s.cls}" style="fill: none" stroke-width="2"${dash}/>`);
    const end = s.points.at(-1)!;
 out.push(circle(xs(s.elapsedMs / 1000), ys(end.accepted), 4, s.cls === 'axis' ? 'muted' : s.cls, `${s.label}: ${end.accepted}/${expected} at ${fmt(s.elapsedMs / 1000, 2)} s`));
    out.push(text(R + 10, labelYs.get(s.label)! + 4, `${s.label}: ${end.accepted}/${expected}, done at ${fmt(s.elapsedMs / 1000, 1)} s`, 'small ink'));
  }
  const notes = caption(20, B + 52, W - 40, [
    `One browser run per strategy, Base, ${windows} pinned windows of 1,000 blocks, 2026-11-26. A step is a window committed with new logs; a window's time is when its last log request ended. Pacing is ≥270 ms between requests per provider.`,
    'Source: data/rpc-recovery/live-*.json (requests and browser resource timings). Details: docs/rpc-recovery.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, 'Logs accepted over wall time for each live strategy', out);
}

// ---- 7. bytes on the wire: feed pages against RPC payloads --------------------

function feedBytes(): string {
  const summary = feedSummary();
  const log = feedBytesLog();
  const baseline = log.find(r => r.status === 'baseline')!;
  const kept = log.filter(r => r.status === 'keep');
  const best = kept.reduce((a, b) => (b.metric < a.metric ? b : a));
  const cold = (feedEvidence() as any).samples['dual-cold-1'].requests as any[];
  const rpc = (feedEvidence() as any).samples['rpc-cold-1'].requests as any[];
  const sum = (rows: any[]) => rows.reduce((a, r) => a + r.responseBytes, 0);
  const onePages = sum(cold.filter(r => r.operation === 'page' && r.source === 'feed-1'));
  if (onePages !== baseline.metric) throw new Error(`shared-feed: recorded pages ${onePages} differ from the search baseline ${baseline.metric}`);
  const one = (values: number[]) => median(values)!;
  const bars: [label: string, raw: number, gzip: number | null, cls: string][] = [
    ['Live RPC, all cold replies', one(summary['rpc-cold'].responseBytes), null, 's2'],
    ['Live RPC, eth_getLogs replies only', sum(rpc.filter(r => r.operation === 'eth_getLogs')), null, 's2'],
    ['Two feeds plus manifests, cold', one(summary['dual-cold'].responseBytes), null, 's1'],
    ['One feed, cold pages, recorded format', baseline.metric, Number(baseline.metrics.cold_gzip_bytes), 's1'],
    ['One feed, cold pages, byte-optimized', best.metric, Number(best.metrics.cold_gzip_bytes), 's3'],
    ['Live RPC, all warm replies', one(summary['rpc-warm'].responseBytes), null, 's2'],
    ['Two feeds plus manifests, warm', one(summary['dual-warm'].responseBytes), null, 's1'],
  ];
  const W = 760, L = 250, R = 640, T = 64, rowH = 26, barH = 14;
  const max = Math.ceil(Math.max(...bars.map(b => b[1])) / 20000) * 20000;
  const xs = linearScale(0, max, L, R);
  const out: string[] = [
    text(20, 28, 'Decoded response bytes for the same Base windows: feed pages against RPC payloads', 'title ink'),
    ...legend(L - 100, 50, [['s2', 'live RPC'], ['s1', 'feed, recorded'], ['s3', 'feed, optimized'], ['muted', 'gzip']]),
  ];
  let y = T + 8;
  const B1 = T + 8 + bars.length * rowH;
  for (let t = 0; t <= max; t += 20000) {
    out.push(line(xs(t), T + 4, xs(t), B1, 'grid'));
    out.push(text(xs(t), B1 + 14, `${t / 1000}k`, 'small muted', 'middle'));
  }
  for (const [label, raw, gzip, cls] of bars) {
    out.push(text(L - 10, y + barH - 3, label, 'label ink', 'end'));
    out.push(rect(L, y, xs(raw) - L, barH, cls, `${label}: ${fmt(raw)} bytes`, ' rx="2"'));
    if (gzip !== null) out.push(rect(L, y + barH + 1, xs(gzip) - L, 5, 'muted', `${label}, gzip: ${fmt(gzip)} bytes`));
    out.push(text(xs(raw) + 6, y + barH - 3, gzip === null ? fmt(raw) : `${fmt(raw)} (gzip ${fmt(gzip)})`, 'small ink'));
    y += rowH;
  }

  // Inset: the keep/revert search, one row per iteration.
  y = B1 + 44;
  out.push(text(20, y, `Format search, one source's cold pages per iteration (${log.length - 1} iterations, keep or revert)`, 'label muted'));
  y += 10;
  const ix = linearScale(0, Math.ceil(baseline.metric / 10000) * 10000, L, R);
  for (const r of log) {
    y += 17;
    const cls = r.status === 'discard' ? 'muted' : r.status === 'baseline' ? 's1' : 's3';
    out.push(text(L - 10, y, `${r.run}. ${r.description}`, `small ${r.status === 'discard' ? 'muted' : 'ink'}`, 'end'));
    out.push(rect(L, y - 9, ix(r.metric) - L, 10, cls, `${r.description}: ${fmt(r.metric)} bytes, ${r.status}`, ` rx="2"${r.status === 'discard' ? ' fill-opacity="0.35"' : ''}`));
    out.push(text(ix(r.metric) + 6, y, `${fmt(r.metric)}${r.status === 'discard' ? ', reverted' : ''}`, 'small muted'));
  }
  const notes = caption(20, y + 28, W - 40, [
    `Decoded body bytes without headers or framing, median of three samples. Live RPC is Tenderly; feeds are two loopback origins built from the RPC-recovery captures. The byte-optimized format is the search's best kept params, ${fmt((1 - best.metric / baseline.metric) * 100, 1)}% smaller raw and ${fmt((1 - Number(best.metrics.cold_gzip_bytes) / Number(baseline.metrics.cold_gzip_bytes)) * 100, 1)}% smaller under gzip. RPC gzip was not measured.`,
    'Sources: data/shared-feed/summary.json, evidence.json, autoresearch/feed-bytes.jsonl. Details: docs/shared-feed.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, 'Response bytes for feed pages and RPC payloads, with the format search', out);
}

// ---- 8. daily scan budget -----------------------------------------------------

// Literature constants and one assumption, not measurements from this repo. The OMR-family values all
// come from one table so they are comparable: eprint 2024/510 Table 1 ("Comparison with prior OMR
// constructions for N = 2^19, γ = γ̄ = 50"), detector runtime in ms per scanned message, amortized over
// N, 1 thread, on a Google Compute Cloud n4-standard-8 (32 GB) with SEAL HEXL / AVX512-IFMA52. Table 2
// gives the same DoS-PerfOMR quantity as 4.95 ms/msg "amortized runtime" at N = 2^19, γ̄ = 50. They
// mirror the scheme table in docs/paged-discovery.md.
// Assumption, not derived from any OMR figure: the daily announcement volume at which a phone-class
// feed budget runs out.
const PHONE_BUDGET_PER_DAY = 1e5;
// DoS-PerfOMR recipient runtime, eprint 2024/510 Table 1: 20 ms.
const OMR_CLIENT_S = 0.02;
// DoS-PerfOMR detector runtime, eprint 2024/510 Table 1: 4.9 ms/msg, 1 thread. DoS-resistant (Theorem 5.3).
const DOS_PERFOMR_DETECTOR_S_PER_MESSAGE = 0.0049;
// PerfOMR2 detector runtime, eprint 2024/510 Table 1: 21.5 ms/msg, 1 thread. Not DoS-resistant (Section 5.1).
const PERFOMR2_DETECTOR_S_PER_MESSAGE = 0.0215;

function scanBudget(): string {
  const W = 760, L = 78, R = 724, T = 58, B = 300;
  const x = logScale(1e-3, 1e7, L, R);
  const y = logScale(1e-5, 1e6, B, T);
  const hosts = scanCost();
  const out: string[] = [text(20, 28, 'CPU per day to scan every announcement: real chains are far below a phone budget', 'title ink')];
  for (const d of x.decades) {
    out.push(line(x.scale(d), T, x.scale(d), B, 'grid'));
    out.push(text(x.scale(d), B + 16, decadeLabel(d), 'small muted', 'middle'));
  }
  for (const d of y.decades.filter((_, i) => i % 2 === 1)) {
    out.push(line(L, y.scale(d), R, y.scale(d), 'grid'));
    out.push(text(L - 6, y.scale(d) + 4, d >= 1 ? decadeLabel(d) : String(d), 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 32, 'announcements per day (log)', 'small muted', 'end'));
  out.push(text(L - 52, T - 12, 'CPU s per day (log)', 'small muted'));
  const clipLine = (perAnnouncement: number, cls: string, extra = '') => {
    const x1 = Math.min(1e7, 1e6 / perAnnouncement);
    out.push(line(x.scale(1e-3), y.scale(1e-3 * perAnnouncement), x.scale(x1), y.scale(x1 * perAnnouncement), cls, ` stroke-width="2"${extra}`));
  };
  const labels: [string, string][] = [['s1', 'i7-13700K'], ['s2', 'Cortex-A76']];
  const rates = hosts.map(h => (h.before + h.after) / 2 / 1e5);
  hosts.forEach((_, i) => {
    clipLine(rates[i]!, labels[i]![0]);
    const at = i === 0 ? 1e3 : 1e2;
    out.push(text(x.scale(at), y.scale(at * rates[i]!) + (i === 0 ? 20 : -12), `${labels[i]![1]}: ${fmt(rates[i]! * 1000, 2)} ms each`, 'label ink', i === 0 ? 'start' : 'end'));
  });
  // Cited OMR costs for comparison.
  out.push(line(x.scale(1e-3), y.scale(OMR_CLIENT_S), x.scale(1e7), y.scale(OMR_CLIENT_S), 'axis', ' stroke-width="1.5" stroke-dasharray="6 4"'));
  out.push(text(R - 4, y.scale(OMR_CLIENT_S) + 15, `DoS-PerfOMR recipient runtime, flat ${OMR_CLIENT_S * 1000} ms`, 'small muted', 'end'));
  const a76 = rates[1]!;
  const cross = OMR_CLIENT_S / a76;
  out.push(circle(x.scale(cross), y.scale(OMR_CLIENT_S), 3.5, 's2', `A76 scan passes DoS-PerfOMR recipient runtime at ${fmt(cross, 1)} announcements`));
  out.push(text(x.scale(cross) - 8, y.scale(OMR_CLIENT_S) - 8, `A76 scan passes it at ~${fmt(Math.ceil(cross))}/day`, 'small muted', 'end'));
  const detector = (perMessage: number, dash: string, label: string, at: number) => {
    const end = Math.min(1e7, 1e6 / perMessage);
    out.push(line(x.scale(1e-3), y.scale(1e-3 * perMessage), x.scale(end), y.scale(end * perMessage), 'axis', ` stroke-width="1.5" stroke-dasharray="${dash}"`));
    out.push(text(x.scale(at), y.scale(at * perMessage) - 10, label, 'small muted', 'end'));
  };
  detector(PERFOMR2_DETECTOR_S_PER_MESSAGE, '2 3', `PerfOMR2 detector, ${fmt(PERFOMR2_DETECTOR_S_PER_MESSAGE * 1000, 1)} ms/message (not DoS-resistant)`, 3e4);
  detector(DOS_PERFOMR_DETECTOR_S_PER_MESSAGE, '8 3', `DoS-PerfOMR detector, ${fmt(DOS_PERFOMR_DETECTOR_S_PER_MESSAGE * 1000, 1)} ms/message (DoS-resistant)`, 3e3);
  // Budget line.
  const bx = x.scale(PHONE_BUDGET_PER_DAY);
  out.push(line(bx, T, bx, B, 'axis', ' stroke-width="1.5" stroke-dasharray="4 3"'));
  out.push(text(bx - 6, T + 12, `~${decadeLabel(PHONE_BUDGET_PER_DAY)}/day: assumed phone feed budget (estimate)`, 'small ink', 'end'));
  out.push(text(bx - 6, T + 26, `A76 ${fmt(PHONE_BUDGET_PER_DAY * a76 / 60, 1)} min CPU/day`, 'small muted', 'end'));
  out.push(circle(x.scale(1e6), y.scale(1e6 * a76), 3.5, 's2', `1M/day on the A76: ${fmt(1e6 * a76 / 60, 0)} min CPU`));
  out.push(text(x.scale(1e6) - 8, y.scale(1e6 * a76) + 4, `1M/day: ${fmt(1e6 * a76 / 60, 0)} min`, 'small ink', 'end'));
  // Real ERC-5564 rates per chain.
  const chains = chainVolume().map(c => [CHAIN_LABELS[c.chain]!, perMonth(bestRetrieval(c.chain)) / 30.44] as [string, number]);
  const lo = Math.min(...chains.map(([, v]) => v)), hi = Math.max(...chains.map(([, v]) => v));
  const rowY = B + 52;
  out.push(rect(x.scale(lo), rowY - 6, x.scale(hi) - x.scale(lo), 12, 'band', undefined, ' rx="3"'));
  for (const [chain, v] of chains) out.push(rect(x.scale(v) - 1.5, rowY - 7, 3, 14, 'muted', `${chain}: ${fmt(v, 3)} announcements/day`));
  out.push(text(L - 6, rowY + 4, 'ERC-5564', 'small ink', 'end'));
  out.push(text(x.scale(hi) + 8, rowY + 4, `${fmt(lo, 3)}–${fmt(hi, 1)} per day per chain; A76 CPU at the busiest: ${fmt(hi * a76 * 1000, 1)} ms/day`, 'small muted'));
  const notes = caption(20, B + 86, W - 40, [
    'Lines: scan-cost 100k controls, crypto engine, per announcement, scaled linearly. Rug: each chain\'s canonical Announcer rate, first announcement to 2026-11-26.',
    'Dashed lines are literature values, not measured here: detector runtime per scanned message, amortized over N = 2^19, for one recipient\'s digest; eprint 2024/510 Table 1, GCP n4-standard-8 with AVX512 (HEXL), 1 thread. The flat line is DoS-PerfOMR\'s recipient runtime from the same table. The ~12/day crossover compares that recipient runtime with the A76 scan-cost rate. The ~100k/day budget is an assumption, not derived from OMR. Lines compare a cloud x86 core with AVX512 to one A76 core.',
    'Sources: data/scan-cost/results.csv, data/chain-volume/canonical/retrieve-*.json. Details: docs/paged-discovery.md (prior work), docs/scan-cost.md.',
  ]);
  out.push(...notes.elements);
  return svg(W, notes.bottom + 8, 'CPU per day to scan announcements against real chain rates and a phone budget', out);
}

// ---- writer -------------------------------------------------------------------

export const FIGURES: Record<string, () => string> = {
  'scan-vs-volume.svg': scanVsVolume,
  'cold-start-requests.svg': coldStart,
  'paged-breakdown.svg': pagedBreakdown,
  'outcome-matrix.svg': outcomeMatrix,
  'cost-frontier.svg': costFrontier,
  'live-timeline.svg': liveTimeline,
  'feed-bytes.svg': feedBytes,
  'scan-budget.svg': scanBudget,
};

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const dir = `${ROOT}docs/figures/`;
  mkdirSync(dir, { recursive: true });
  let stale = 0;
  for (const [name, render] of Object.entries(FIGURES)) {
    const content = render();
    let current = '';
    try { current = readFileSync(dir + name, 'utf8'); } catch { /* new figure */ }
    if (current === content) continue;
    stale++;
    if (check) console.error(`docs/figures/${name} is out of date; run bun run figures`);
    else { writeFileSync(dir + name, content); console.log(`wrote docs/figures/${name}`); }
  }
  if (check && stale) process.exitCode = 1;
}
