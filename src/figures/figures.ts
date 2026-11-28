// `bun run figures`: writes the summary figures (README and docs) to docs/figures/ from data/.
// Pass --check to fail instead of writing when a figure would change.
// Figures carry a short title, minimal axes and direct labels on the key marks only. Exact values
// sit in hover tooltips; sources, scope and caveats go in the Markdown caption under each image.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CHAIN_LABELS, ROOT, STRATEGIES, bestRetrieval, chainLatest, chainVolume, consistency, feedBytesLog, feedEvidence, feedControls, feedSummary, num,
  pagedRepeat, perMonth, recoveryReference, recoveryRun, recoveryTimeline, REMOTE_HOSTS, remoteSummary, rpcUnpaced, scanCost, engineHeadlines, perAnnouncement, scanEngines, type Strategy,
} from './data.ts';
import { FAULTS } from './tables.ts';
import { circle, decadeLabel, dotKey, legend, line, linearScale, logScale, rect, svg, text } from './svg.ts';
import { median } from '../shared/stats.ts';

const fmt = (value: number, digits = 0) =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const kilo = (value: number) => `${fmt(value / 1000)}k`;
const logTick = (d: number) => (d >= 1 ? decadeLabel(d) : String(d));

// ---- 1. scan time against real announcement volume ----------------------------

function scanVsVolume(): string {
  const W = 760, L = 96, R = 730, T = 66, B = 420;
  const x = logScale(1, 1e6, L, R);
  const y = logScale(1e-6, 1e4, B, T);
  const hosts = scanCost();
  const chains = chainVolume();
  const engines = scanEngines();
  const headlines = engineHeadlines();
  const keys: [cls: string, style: string, label: string][] = [];
  const out: string[] = [
    text(20, 30, 'Scan time vs announcements', 'title ink'),
    text(20, 54, 'seconds, log scale', 'small muted'),
  ];
  for (const d of x.decades.filter((_, i) => i % 2 === 0)) {
    out.push(line(x.scale(d), T, x.scale(d), B, 'grid'));
    out.push(text(x.scale(d), B + 20, decadeLabel(d), 'small muted', 'middle'));
  }
  for (const d of y.decades.filter((_, i) => i % 2 === 0)) {
    out.push(line(L, y.scale(d), R, y.scale(d), 'grid'));
    out.push(text(L - 8, y.scale(d) + 5, logTick(d), 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 40, 'announcements, log scale', 'small muted', 'end'));

  const series: [string, string][] = [['s1', 'i7-13700K'], ['s2', 'Cortex-A76']];
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
    keys.push([cls, ' stroke-width="2" stroke-dasharray="5 4"', `${label}, ScopeLift SDK: ${fmt(perAnnouncement * 1000, 2)} ms each`]);
  });
  // Best measured engine per host: the fastest wall-clock scenario, measured at 100k and 1M.
  headlines.forEach((h, i) => {
    const [cls, label] = series[i]!;
    const { engine, threads } = h.best;
    const point = (count: number) => engines.find(r => r.host === h.host && r.engine === engine && r.threads === threads && r.count === count && r.case === 'zero')!;
    const small = point(1e5).medianMs / 1000, large = point(1e6).medianMs / 1000;
    const each = small / 1e5;
    const at = (n: number) => y.scale(n * each);
    out.push(line(x.scale(1), at(1), x.scale(1e5), at(1e5), cls, ' stroke-width="1.5" stroke-dasharray="2 3" fill="none"'));
    out.push(line(x.scale(1e5), y.scale(small), x.scale(1e6), y.scale(large), cls, ' stroke-width="1.5" fill="none"'));
    const what = `libsecp256k1 ${engine}, ${threads} thread${threads === 1 ? '' : 's'}`;
    for (const [n, sec] of [[1e5, small], [1e6, large]] as const) {
      out.push(circle(x.scale(n), y.scale(sec), 4, `${cls} hollow`, `${label}, ${what}, ${kilo(n)}: ${fmt(sec, 3)} s`, ' stroke-width="2"'));
    }
    keys.push([cls, ' stroke-width="1.5" stroke-dasharray="2 3"', `${label}, libsecp256k1 ${engine} × ${threads} threads: ${fmt(h.best.seconds * 1e6, 1)} µs each`]);
  });
  // Key in the empty upper-left corner: the lines are parallel, so inline labels would cross them.
  [...keys].reverse().forEach(([cls, style, label], k) => {
    const ky = T + 22 + k * 22;
    out.push(line(L + 14, ky - 5, L + 44, ky - 5, cls, style));
    out.push(text(L + 52, ky, label, 'label ink'));
  });

  // Ticks: each real chain's full announcement history, read against the x-axis as a full-history scan.
  // Labels alternate above and below the ticks and are spread apart (dodge) so text never overlaps.
  const labelWidth = (s: string) => s.length * 7.2;
  const dodge = (want: number[], widths: number[], lo: number, hi: number, gap = 12) => {
    let groups = want.map((c, i) => ({ items: [i], left: c - widths[i]! / 2, width: widths[i]! }));
    const place = (g: typeof groups[number]) => {
      let offset = 0;
      const shifts = g.items.map(i => { const s = want[i]! - offset - widths[i]! / 2; offset += widths[i]! + gap; return s; });
      g.width = offset - gap;
      g.left = Math.min(Math.max(shifts.reduce((a, b) => a + b, 0) / shifts.length, lo), hi - g.width);
    };
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 1; i < groups.length; i++) {
        const a = groups[i - 1]!, b = groups[i]!;
        if (a.left + a.width + gap > b.left) {
          groups.splice(i - 1, 2, { items: [...a.items, ...b.items], left: 0, width: 0 });
          place(groups[i - 1]!);
          merged = true;
          break;
        }
      }
    }
    const centers: number[] = [];
    for (const g of groups) {
      let at = g.left;
      for (const i of g.items) { centers[i] = at + widths[i]! / 2; at += widths[i]! + gap; }
    }
    return centers;
  };
  const LARGEST = 'Polygon PoS';
  const rug = (top: number, label: string, counts: [string, number][]) => {
    const sorted = [...counts].sort((a, b) => a[1] - b[1]);
    const rowY = top + 38;
    const values = sorted.map(([, n]) => n);
    out.push(text(20, top, label, 'small muted'));
    out.push(rect(x.scale(values[0]!), rowY - 7, x.scale(values.at(-1)!) - x.scale(values[0]!), 14, 'band', undefined, ' rx="3"'));
    for (const side of [0, 1]) {
      const picked = sorted.filter((_, i) => i % 2 === side);
      const names = picked.map(([chain, n]) => `${chain} ${fmt(n)}`);
      const centers = dodge(picked.map(([, n]) => x.scale(n)), names.map(labelWidth), 20, W - 20);
      const labelY = side === 0 ? rowY - 22 : rowY + 32;
      picked.forEach(([chain, n], i) => {
        const tx = x.scale(n);
        out.push(line(tx, side === 0 ? rowY - 9 : rowY + 9, centers[i]!, side === 0 ? labelY + 5 : labelY - 14, 'axis', ' stroke-width="1"'));
        out.push(text(centers[i]!, labelY, names[i]!, 'small ink', 'middle'));
      });
    }
    for (const [chain, n] of sorted) {
      const key = label.startsWith('Umbra') && chain === LARGEST;
      out.push(rect(x.scale(n) - 1.5, rowY - 8, 3, 16, key ? 'ink' : 'muted', `${label}, ${chain}: ${fmt(n)} announcements`));
    }
  };
  out.push(text(20, B + 72, 'Real chains, total announcements to date', 'label ink'));
  // ERC-5564 counts follow the weekly refresh; Umbra stays at the 2026-11-26 recording.
  rug(B + 98, 'ERC-5564 Announcer', chains.map(c => [CHAIN_LABELS[c.chain]!, chainLatest(c.chain).count]));
  rug(B + 196, 'Umbra contract', chains.filter(c => c.umbra !== null).map(c => [CHAIN_LABELS[c.chain]!, c.umbra!]));

  // The largest real history, Umbra on Polygon PoS, read off each host's line.
  const largest = chains.find(c => CHAIN_LABELS[c.chain] === LARGEST)!.umbra!;
  const lx = x.scale(largest);
  const onLine = (h: typeof hosts[number]) => {
    const start = (h.before + h.after) / 2;
    return start * (h.million / start) ** Math.log10(largest / 1e5);
  };
  const times = hosts.map(onLine);
  out.push(line(lx, B, lx, y.scale(Math.max(...times)), 'axis', ' stroke-width="1.5" stroke-dasharray="3 3"'));
  const duration = (s: number) => (s < 120 ? `${fmt(s)} s` : `${fmt(s / 60, 1)} min`);
  hosts.forEach((h, i) => out.push(circle(lx, y.scale(times[i]!), 3.5, 'ink', `${series[i]![1]}, Umbra on ${LARGEST} (${fmt(largest)}): ${fmt(times[i]!, 1)} s`)));
  out.push(text(lx - 8, B - 64, `Umbra on ${LARGEST}`, 'label ink', 'end'));
  out.push(text(lx - 8, B - 46, `${fmt(largest)} announcements`, 'small muted', 'end'));
  hosts.forEach((_, i) => out.push(text(lx - 8, B - 28 + i * 18, `${series[i]![1]}: ${duration(times[i]!)}`, 'small ink', 'end')));
  return svg(W, B + 276, 'Scan time against announcement count, log-log, with each real chain\'s full history', out);
}

// ---- 2. cold-start requests per chain by strategy -----------------------------

const STRATEGY_STYLE: Record<Strategy, [cls: string, label: string]> = {
  'list-order': ['s2', 'Chainlist order'],
  'probe-informed': ['s1', 'Probe-informed'],
  parallel: ['s3', 'Parallel backfill'],
};
const HOLLOW_BAR = ' rx="2" fill-opacity="0.12" stroke-width="2"';
function coldStart(): string {
  const chains = chainVolume();
  const W = 760, L = 120, R = 720, T = 76, rowH = 44, barH = 11;
  const B = T + chains.length * rowH;
  const x = logScale(10, 1e5, L, R);
  const out: string[] = [
    text(20, 30, 'Requests to fetch each chain\'s history', 'title ink'),
    ...legend(20, 58, STRATEGIES.map(s => STRATEGY_STYLE[s])),
  ];
  // A failed run is drawn hollow, so failure is not shown by color alone.
  const keyX = 20 + STRATEGIES.reduce((a, s) => a + 34 + STRATEGY_STYLE[s][1].length * 7.6, 0);
  out.push(rect(keyX + 1, 58 - 10, 10, 10, 'axis', undefined, ' rx="2" fill="none" stroke-width="2"'), text(keyX + 18, 58, 'stopped early', 'label ink'));
  for (const d of x.decades) {
    out.push(line(x.scale(d), T, x.scale(d), B, 'grid'));
    out.push(text(x.scale(d), B + 20, decadeLabel(d), 'small muted', 'middle'));
  }
  out.push(line(L, B, R, B, 'axis'));
  out.push(text(R, B + 40, 'requests, log scale', 'small muted', 'end'));
  chains.forEach((chain, i) => {
    const top = T + i * rowH + 4;
    out.push(text(L - 10, top + 6 + (chain.runs.length * (barH + 2)) / 2, CHAIN_LABELS[chain.chain]!, 'label ink', 'end'));
    chain.runs.forEach((run, j) => {
      const [cls, label] = STRATEGY_STYLE[run.strategy];
      const by = top + j * (barH + 2);
      const w = x.scale(run.requests) - L;
      const tip = `${CHAIN_LABELS[chain.chain]}, ${label}: ${fmt(run.requests)} requests, ${fmt(run.seconds, 1)} s, ${run.success ? `${fmt(run.count)} logs` : `stopped after ${fmt(run.count)} logs`}`;
      out.push(run.success
        ? rect(L, by, w, barH, cls, tip, ' rx="2"')
        : rect(L + 1, by + 1, w - 2, barH - 2, cls, tip, HOLLOW_BAR));
    });
  });
  return svg(W, B + 56, "Requests to fetch each chain's full history by strategy", out);
}

// ---- 3. paged discovery cost breakdown ----------------------------------------

function pagedBreakdown(): string {
  const rows = pagedRepeat().filter(r => r.host === 'bazzite' && r.scenario === 'cold' && r.count === '1000000');
  const order = rows.sort((a, b) => a.profile!.localeCompare(b.profile!) || Number(a.pageBlocks) - Number(b.pageBlocks));
  const W = 760, L = 170, R = 650, T = 76, rowH = 36, barH = 20;
  const B = T + order.length * rowH;
  const max = Math.ceil(Math.max(...order.map(r => num(r.totalSMedian)!)) / 300) * 300;
  const xs = linearScale(0, max, L, R);
  const parts: [string, string, string][] = [['networkSMedian', 's1', 'Network'], ['scanSMedian', 's2', 'Scan'], ['verifySMedian', 's3', 'Verify']];
  const out: string[] = [
    text(20, 30, 'Where a 1M cold rescan spends its time', 'title ink'),
    ...legend(20, 58, parts.map(([, cls, label]) => [cls, label])),
  ];
  for (let t = 0; t <= max; t += 600) {
    out.push(line(xs(t), T, xs(t), B, 'grid'));
    out.push(text(xs(t), B + 20, fmt(t), 'small muted', 'middle'));
  }
  out.push(line(L, B, R, B, 'axis'));
  out.push(text(R, B + 40, 'seconds', 'small muted', 'end'));
  order.forEach((row, i) => {
    const top = T + i * rowH + (rowH - barH) / 2;
    out.push(text(L - 10, top + 15, `${row.profile}, ${row.pageBlocks}-block pages`, 'label ink', 'end'));
    let at = 0;
    for (const [field, cls, label] of parts) {
      const value = num(row[field])!;
      // 2px surface gap between segments.
      out.push(rect(xs(at), top, xs(at + value) - xs(at), barH, `${cls}`, `${row.profile}, ${row.pageBlocks}-block pages, ${label}: ${fmt(value, 1)} s`, ' rx="2"'));
      out.push(line(xs(at + value), top, xs(at + value), top + barH, 'gap', ' stroke-width="2"'));
      at += value;
    }
    out.push(text(xs(at) + 8, top + 15, `${fmt(num(row.totalSMedian)!)} s`, 'label ink'));
  });
  return svg(W, B + 56, 'Network, scan and verify time for a 1M cold rescan', out);
}

// ---- 4. who caught what: outcome per strategy, fault and endpoint -------------

type Outcome = 'missing' | 'held' | 'complete';
const OUTCOME_COLUMNS: [Outcome, string, string][] = [
  ['missing', 's2', 'missed logs'],
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
    ['Live public RPC, Base', [
      fromRun('Daybreak alone', 'live-daybreak-single', 'single'),
      fromRun('Daybreak × Tenderly, Sentio tiebreak', 'live-daybreak-cross', 'cross'),
      fromRun('Tenderly alone', 'live-healthy-single', 'single'),
      fromRun('Tenderly × Sentio, Pocket standby', 'live-healthy-cross', 'cross'),
    ]],
    ['Injected RPC faults', FAULTS.map(([name, mode, label]) => fromRun(label, name, mode))],
    ['Static feeds', [
      fromFeed('Two independent feeds', 'complete', median(feed.gets)!, `${median(feed.observed)}/${expected}`),
      fromFeed('One feed that dropped every log', 'missing', c.omit.gets, `${c.omit.observed}/${expected} found, ended without error`, false),
      fromFeed('Empty feed plus independent feed', 'held', c.hold.gets,
        `stopped at group ${controls['omission-hold'].next}/${controls['omission-hold'].limit}, ${expected - c.hold.expected} pending`),
      fromFeed('Resume with corrected source', 'complete', c.resume.gets, `${c.resume.observed}/${expected}`),
      fromFeed('Same identities, altered ABI data', 'held', c.altered.gets,
        `stopped at group ${controls['payload-hold'].next}/${controls['payload-hold'].limit}, ${expected - c.altered.expected} pending`),
    ]],
  ];
  const W = 760, labelEnd = 340, colX = [430, 540, 650], rowH = 26, groupH = 52;
  const out: string[] = [text(20, 30, 'Who missed logs, who held, who recovered', 'title ink')];
  const kx = dotKey(20, 58, 'muted', 'two sources agreed', false, out);
  dotKey(kx, 58, 'axis', 'one source', true, out);
  let y = 92;
  OUTCOME_COLUMNS.forEach(([, , label], i) => out.push(text(colX[i]!, y, label, 'label ink', 'middle')));
  for (const [title, rows] of groups) {
    y += groupH;
    out.push(text(20, y - 8, title, 'label muted'));
    out.push(line(20, y, W - 20, y, 'grid'));
    y -= 4;
    for (const row of rows) {
      y += rowH;
      const col = OUTCOME_COLUMNS.findIndex(([o]) => o === row.outcome);
      const [, cls, outcomeLabel] = OUTCOME_COLUMNS[col]!;
      out.push(text(labelEnd, y + 5, row.label, 'label ink', 'end'));
      for (const x of colX) out.push(circle(x, y, 1.5, 'grid'));
      const tip = `${row.label}: ${outcomeLabel}, ${row.verified ? 'two sources' : 'single source'}; ${row.note}`;
      out.push(row.verified
        ? circle(colX[col]!, y, 7, cls, tip)
        : circle(colX[col]!, y, 6, `${cls} hollow`, tip, ' stroke-width="2.5"'));
    }
  }

  // Panel B: keyless endpoints that answered a known announcement's window with [].
  const CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'gnosis', 'polygon', 'sepolia'];
  const silent = CHAINS.flatMap(consistency).filter(e => e.checks.some(ch => ch.outcome === 'empty'));
  y += groupH + 8;
  out.push(text(20, y - 8, 'Endpoints that answered [] at a known log', 'label muted'));
  out.push(line(20, y, W - 20, y, 'grid'));
  y -= 4;
  const squareX = colX[0]! - 50;
  for (const e of silent) {
    y += rowH;
    out.push(text(labelEnd, y + 5, `${e.host} (${CHAIN_LABELS[e.chain]})`, 'label ink', 'end'));
    e.checks.forEach((ch, i) => {
      const cls = ch.outcome === 'returned' ? 's3' : ch.outcome === 'empty' ? 's2' : 'muted';
      out.push(rect(squareX + i * 20, y - 7, 14, 14, cls, `${e.host}, log ${ch.target}: ${ch.outcome}`, ' rx="2"'));
    });
  }
  y += rowH + 14;
  out.push(...legend(squareX, y, [['s3', 'returned'], ['s2', 'empty []'], ['muted', 'error']]));
  return svg(W, y + 20, 'Outcome of each strategy, injected fault and endpoint recheck', out);
}

// ---- 5. cost frontier on the pinned Base windows ------------------------------

function costFrontier(): string {
  const { expected } = recoveryReference();
  const feed = feedSummary();
  const remote = remoteSummary(REMOTE_HOSTS[0]!)['remote-concurrent-cold'];
  const sec = (ms: number) => `${fmt(ms / 1000, 2)} s`;
  type Place = 'above' | 'below' | 'none';
  interface Point { label: string; requests: number; unit: string; found: number; verified: boolean; time: string; place: Place }
  const live = (label: string, name: string, mode: string, place: Place): Point => {
    const run = recoveryRun(name, mode);
    return { label, requests: run.requests, unit: 'POST', found: run.observed, verified: mode !== 'single', time: `${sec(run.elapsedMs)} paced`, place };
  };
  const one = (values: number[]) => median(values)!;
  const points: Point[] = [
    { label: 'Two feeds', requests: one(remote.gets), unit: 'GET', found: one(remote.observed), verified: true,
      time: `${sec(one(remote.elapsedMs))} over the network (${fmt(one(feed['dual-cold'].elapsedMs), 1)} ms on loopback)`, place: 'above' },
    live('Tenderly alone', 'live-healthy-single', 'single', 'above'),
    // The Bun client run sits one request from the browser run; the shared label covers both.
    { label: 'Tenderly alone, Bun client', requests: one(feed['rpc-cold'].posts), unit: 'POST', found: one(feed['rpc-cold'].observed), verified: false,
      time: `${sec(one(rpcUnpaced(REMOTE_HOSTS[0] === 'bazzite' ? '' : REMOTE_HOSTS[0]).cold.map(row => row.busyMs)))} excluding pacing (${sec(one(feedSummary(REMOTE_HOSTS[0] === 'bazzite' ? '' : REMOTE_HOSTS[0])['rpc-cold'].elapsedMs))} paced)`, place: 'none' },
    live('Tenderly × Sentio', 'live-healthy-cross', 'cross', 'above'),
    live('Daybreak × Tenderly', 'live-daybreak-cross', 'cross', 'below'),
    live('Daybreak alone', 'live-daybreak-single', 'single', 'above'),
  ];
  const W = 760, L = 70, R = 720, T = 110, B = 310;
  const max = Math.ceil(Math.max(...points.map(p => p.requests)) / 100) * 100;
  const xs = linearScale(0, max, L, R);
  const ys = linearScale(0, expected, B, T);
  const out: string[] = [text(20, 30, 'Requests vs logs found', 'title ink')];
  const kx = dotKey(20, 58, 's3', 'two sources agreed', false, out);
  dotKey(kx, 58, 's2', 'one source', true, out);
  out.push(text(20, 90, `logs found, of ${expected}`, 'small muted'));
  for (let t = 0; t <= max; t += 100) {
    out.push(line(xs(t), T, xs(t), B, 'grid'));
    out.push(text(xs(t), B + 20, fmt(t), 'small muted', 'middle'));
  }
  for (const v of [0, expected]) {
    out.push(line(L, ys(v), R, ys(v), 'grid'));
    out.push(text(L - 8, ys(v) + 5, `${v}`, 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 40, 'requests', 'small muted', 'end'));
  for (const p of points) {
    const cls = p.verified ? 's3' : 's2';
    const tip = `${p.label}: ${p.found}/${expected}, ${p.requests} ${p.unit}, ${p.time}`;
    const px = xs(p.requests), py = ys(p.found);
    out.push(p.verified ? circle(px, py, 7, cls, tip) : circle(px, py, 6, `${cls} hollow`, tip, ' stroke-width="2.5"'));
    if (p.place !== 'none') out.push(text(px, p.place === 'above' ? py - 14 : py + 26, p.label, 'label ink', 'middle'));
  }
  return svg(W, B + 56, 'Requests against logs found per strategy on the pinned Base windows', out);
}

// ---- 6. accepted logs over wall time, live -------------------------------------

function liveTimeline(): string {
  const { expected } = recoveryReference();
  const runs: [string, string, string, string][] = [
    ['live-daybreak-single', 'single', 's2', 'Daybreak alone'],
    ['live-healthy-single', 'single', 's3', 'Tenderly alone'],
    ['live-healthy-cross', 'cross', 'axis', 'Tenderly × Sentio'],
    ['live-daybreak-cross', 'cross', 's1', 'Daybreak × Tenderly'],
  ];
  const series = runs.map(([name, mode, cls, label]) => ({ cls, label, ...recoveryTimeline(name, mode) }));
  const W = 760, L = 60, R = 540, T = 76, B = 290;
  const max = Math.ceil(Math.max(...series.map(s => s.elapsedMs)) / 5000) * 5;
  const xs = linearScale(0, max, L, R);
  const ys = linearScale(0, expected, B, T);
  const out: string[] = [
    text(20, 30, 'Logs accepted over time', 'title ink'),
    text(20, 56, `logs accepted, of ${expected}`, 'small muted'),
  ];
  for (let t = 0; t <= max; t += 10) {
    out.push(line(xs(t), T, xs(t), B, 'grid'));
    out.push(text(xs(t), B + 20, `${t}`, 'small muted', 'middle'));
  }
  for (const v of [0, expected]) {
    out.push(line(L, ys(v), R, ys(v), 'grid'));
    out.push(text(L - 8, ys(v) + 5, `${v}`, 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 40, 'seconds', 'small muted', 'end'));
  // End labels sit right of the plot, spread so they never overlap.
  const labelYs = new Map<string, number>();
  const order = [...series].sort((a, b) => b.points.at(-1)!.accepted - a.points.at(-1)!.accepted || a.elapsedMs - b.elapsedMs);
  let lastY = -Infinity;
  for (const s of order) {
    const yEnd = Math.max(ys(s.points.at(-1)!.accepted), lastY + 22);
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
    const ly = labelYs.get(s.label)!;
    out.push(line(R + 12, ly, R + 30, ly, s.cls, ` stroke-width="2.5"${dash}`));
    out.push(text(R + 38, ly + 5, s.label, 'label ink'));
  }
  return svg(W, B + 56, 'Logs accepted over wall time for each live strategy', out);
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
    ['RPC, cold', one(summary['rpc-cold'].responseBytes), null, 's2'],
    ['RPC, cold, eth_getLogs only', sum(rpc.filter(r => r.operation === 'eth_getLogs')), null, 's2'],
    ['Two feeds, cold', one(summary['dual-cold'].responseBytes), one(remoteSummary(REMOTE_HOSTS[0]!)['remote-cold'].wireBytes), 's1'],
    ['One feed, cold', baseline.metric, Number(baseline.metrics.cold_gzip_bytes), 's1'],
    ['One feed, cold, optimized', best.metric, Number(best.metrics.cold_gzip_bytes), 's3'],
    ['RPC, warm', one(summary['rpc-warm'].responseBytes), null, 's2'],
    ['Two feeds, warm', one(summary['dual-warm'].responseBytes), one(remoteSummary(REMOTE_HOSTS[0]!)['remote-warm'].wireBytes), 's1'],
  ];
  const W = 760, L = 230, R = 680, T = 76, rowH = 30, barH = 16;
  const max = Math.ceil(Math.max(...bars.map(b => b[1])) / 50000) * 50000;
  const xs = linearScale(0, max, L, R);
  const out: string[] = [
    text(20, 30, 'Response bytes: feeds vs RPC', 'title ink'),
    ...legend(20, 58, [['s2', 'RPC'], ['s1', 'feed'], ['s3', 'feed, optimized'], ['muted', 'gzip / as served']]),
  ];
  const B1 = T + 8 + bars.length * rowH;
  for (let t = 0; t <= max; t += 50000) {
    out.push(line(xs(t), T + 4, xs(t), B1, 'grid'));
    out.push(text(xs(t), B1 + 20, kilo(t), 'small muted', 'middle'));
  }
  let y = T + 10;
  for (const [label, raw, gzip, cls] of bars) {
    out.push(text(L - 10, y + barH - 2, label, 'label ink', 'end'));
    out.push(rect(L, y, xs(raw) - L, barH, cls, `${label}: ${fmt(raw)} bytes`, ' rx="2"'));
    if (gzip !== null) out.push(rect(L, y + barH + 1, xs(gzip) - L, 5, 'muted', `${label}, gzip: ${fmt(gzip)} bytes`));
    out.push(text(xs(raw) + 8, y + barH - 2, kilo(raw), 'small ink'));
    y += rowH;
  }

  // Panel B: the keep/revert format search, one point per iteration.
  const top = B1 + 72, bottom = top + 150;
  const searchMax = Math.ceil(baseline.metric / 10000) * 10000;
  const ix = linearScale(0, log.length - 1, L, R);
  const iy = linearScale(0, searchMax, bottom, top);
  out.push(text(20, top - 22, 'Format search, one feed\'s cold pages', 'label ink'));
  for (const v of [0, searchMax / 2, searchMax]) {
    out.push(line(L, iy(v), R, iy(v), 'grid'));
    out.push(text(L - 10, iy(v) + 5, kilo(v), 'small muted', 'end'));
  }
  for (let t = 0; t < log.length; t += 5) out.push(text(ix(t), bottom + 20, `${t}`, 'small muted', 'middle'));
  out.push(line(L, bottom, R, bottom, 'axis'));
  out.push(text(R, bottom + 40, 'iteration', 'small muted', 'end'));
  // Step line through the best kept size so far; reverted tries are hollow.
  let d = '';
  let current = baseline.metric;
  log.forEach((r, i) => {
    if (r.status !== 'discard') current = r.metric;
    d += `${i === 0 ? 'M' : ' H'}${ix(i).toFixed(1)}${i === 0 ? `,${iy(current).toFixed(1)}` : ` V${iy(current).toFixed(1)}`}`;
  });
  out.push(`<path d="${d}" class="s3" style="fill: none" stroke-width="2"/>`);
  log.forEach((r, i) => {
    const tip = `${r.run}. ${r.description}: ${fmt(r.metric)} bytes, ${r.status}`;
    out.push(r.status === 'discard'
      ? circle(ix(i), iy(r.metric), 4.5, 'axis hollow', tip, ' stroke-width="2"')
      : circle(ix(i), iy(r.metric), 5, r.status === 'baseline' ? 's1' : 's3', tip));
  });
  out.push(text(ix(0) + 10, iy(baseline.metric) - 10, `baseline ${kilo(baseline.metric)}`, 'label ink'));
  out.push(text(ix(log.indexOf(best)), iy(best.metric) + 26, `best ${kilo(best.metric)}`, 'label ink', 'middle'));
  const rx = dotKey(L + 230, top - 22, 's3', 'kept', false, out);
  dotKey(rx, top - 22, 'axis', 'reverted', true, out);
  return svg(W, bottom + 56, 'Response bytes for feed pages and RPC payloads, with the format search', out);
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
  const W = 800, L = 96, R = 590, T = 66, B = 320;
  const x = logScale(1e-3, 1e7, L, R);
  const y = logScale(1e-5, 1e6, B, T);
  const hosts = scanCost();
  const out: string[] = [
    text(20, 30, 'CPU per day to scan every announcement', 'title ink'),
    text(20, 54, 'CPU seconds per day, log scale', 'small muted'),
  ];
  for (const d of x.decades.filter((_, i) => i % 2 === 0)) {
    out.push(line(x.scale(d), T, x.scale(d), B, 'grid'));
    out.push(text(x.scale(d), B + 20, decadeLabel(d), 'small muted', 'middle'));
  }
  for (const d of y.decades.filter((_, i) => i % 2 === 1)) {
    out.push(line(L, y.scale(d), R, y.scale(d), 'grid'));
    out.push(text(L - 8, y.scale(d) + 5, logTick(d), 'small muted', 'end'));
  }
  out.push(line(L, B, R, B, 'axis'), line(L, T, L, B, 'axis'));
  out.push(text(R, B + 40, 'announcements per day, log scale', 'small muted', 'end'));
  const clipLine = (perAnnouncement: number, cls: string, extra = '') => {
    const x1 = Math.min(1e7, 1e6 / perAnnouncement);
    out.push(line(x.scale(1e-3), y.scale(1e-3 * perAnnouncement), x.scale(x1), y.scale(x1 * perAnnouncement), cls, ` stroke-width="2"${extra}`));
  };
  // Every line runs to the right edge; its label sits there, spread so labels never overlap.
  const ends: [y: number, label: string, cls: string][] = [];
  const labels: [string, string][] = [['s1', 'i7-13700K, SDK'], ['s2', 'Cortex-A76, SDK']];
  const rates = hosts.map(h => (h.before + h.after) / 2 / 1e5);
  hosts.forEach((_, i) => {
    clipLine(rates[i]!, labels[i]![0]);
    ends.push([y.scale(1e7 * rates[i]!), labels[i]![1], 'label ink']);
  });
  // Cited OMR costs for comparison (literature, not measured here).
  out.push(line(x.scale(1e-3), y.scale(OMR_CLIENT_S), x.scale(1e7), y.scale(OMR_CLIENT_S), 'axis', ' stroke-width="1.5" stroke-dasharray="6 4"'));
  ends.push([y.scale(OMR_CLIENT_S), 'DoS-PerfOMR recipient', 'small muted']);
  const a76 = rates[1]!;
  const cross = OMR_CLIENT_S / a76;
  out.push(circle(x.scale(cross), y.scale(OMR_CLIENT_S), 4, 's2', `A76 SDK scan passes DoS-PerfOMR recipient runtime at ${fmt(cross, 1)} announcements`));
  out.push(text(x.scale(cross) - 8, y.scale(OMR_CLIENT_S) - 10, `~${fmt(Math.ceil(cross))}/day`, 'small ink', 'end'));
  // Best measured engine on the A76: single-thread libsecp256k1 CPU time (threads cut wall time, not CPU).
  const fast = perAnnouncement(scanEngines(), 'turing-node-1', 'native', 1, true)!;
  clipLine(fast, 's2', ' stroke-dasharray="2 3"');
  ends.push([y.scale(1e7 * fast), 'Cortex-A76, libsecp256k1', 'label ink']);
  const fastCross = OMR_CLIENT_S / fast;
  out.push(circle(x.scale(fastCross), y.scale(OMR_CLIENT_S), 4, 's2 hollow', `A76 libsecp256k1 scan passes DoS-PerfOMR recipient runtime at ${fmt(fastCross, 1)} announcements`, ' stroke-width="2"'));
  out.push(text(x.scale(fastCross) + 10, y.scale(OMR_CLIENT_S) + 20, `~${fmt(Math.ceil(fastCross))}/day`, 'small ink', 'start'));
  const detector = (perMessage: number, dash: string, label: string) => {
    const end = Math.min(1e7, 1e6 / perMessage);
    out.push(line(x.scale(1e-3), y.scale(1e-3 * perMessage), x.scale(end), y.scale(end * perMessage), 'axis', ` stroke-width="1.5" stroke-dasharray="${dash}"`));
    ends.push([y.scale(end * perMessage), label, 'small muted']);
  };
  detector(PERFOMR2_DETECTOR_S_PER_MESSAGE, '2 3', 'PerfOMR2 detector');
  detector(DOS_PERFOMR_DETECTOR_S_PER_MESSAGE, '8 3', 'DoS-PerfOMR detector');
  let lastY = -Infinity;
  for (const [endY, label, cls] of ends.sort((a, b) => a[0] - b[0])) {
    const ly = Math.max(endY, lastY + 19);
    out.push(text(R + 10, ly + 5, label, cls));
    lastY = ly;
  }
  // Budget line (an assumption, not a measurement).
  const bx = x.scale(PHONE_BUDGET_PER_DAY);
  out.push(line(bx, T, bx, B, 'axis', ' stroke-width="1.5" stroke-dasharray="4 3"'));
  out.push(text(bx - 8, T + 16, `~${decadeLabel(PHONE_BUDGET_PER_DAY)}/day budget (assumed)`, 'small ink', 'end'));
  out.push(circle(x.scale(1e6), y.scale(1e6 * a76), 4, 's2', `1M/day on the A76, SDK: ${fmt(1e6 * a76 / 60, 0)} min CPU`));
  out.push(circle(x.scale(1e6), y.scale(1e6 * fast), 4, 's2 hollow', `1M/day on the A76, libsecp256k1: ${fmt(1e6 * fast / 60, 1)} min CPU`, ' stroke-width="2"'));
  // Real ERC-5564 rates per chain.
  const chains = chainVolume().map(c => [CHAIN_LABELS[c.chain]!, perMonth(bestRetrieval(c.chain)) / 30.44] as [string, number]);
  const lo = Math.min(...chains.map(([, v]) => v)), hi = Math.max(...chains.map(([, v]) => v));
  const rowY = B + 70;
  out.push(rect(x.scale(lo), rowY - 7, x.scale(hi) - x.scale(lo), 14, 'band', undefined, ' rx="3"'));
  for (const [chain, v] of chains) out.push(rect(x.scale(v) - 1.5, rowY - 8, 3, 16, 'muted', `${chain}: ${fmt(v, 3)} announcements/day; A76 CPU ${fmt(v * a76 * 1000, 1)} ms/day`));
  out.push(text(L - 8, rowY + 5, 'ERC-5564', 'small ink', 'end'));
  out.push(text(x.scale(hi) + 10, rowY + 5, 'real chains', 'small muted'));
  return svg(W, rowY + 24, 'CPU per day to scan announcements against real chain rates and a phone budget', out);
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
