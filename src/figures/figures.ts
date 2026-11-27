// `bun run figures`: writes the README summary figures to docs/figures/ from data/.
// Pass --check to fail instead of writing when a figure would change.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CHAIN_LABELS, ROOT, STRATEGIES, chainVolume, num, pagedRepeat, scanCost, type Strategy } from './data.ts';
import { caption, circle, decadeLabel, legend, line, linearScale, logScale, rect, svg, text } from './svg.ts';

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
  const notes = caption(20, B + 108, W - 40, [
    `Rug rows: each chain's full history from deployment to head, ${chains.length} chains, 2026-11-26. The largest (Umbra, ${fmt(largest)}) would take about ${fmt(largest * a76Rate, 0)} s on the A76.`,
    `Lines: synthetic zero-match fixtures, crypto engine. Dots are measured. Dashed is a linear extrapolation (1M / 100k measured at ${ratioRange}x).`,
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

// ---- writer -------------------------------------------------------------------

export const FIGURES: Record<string, () => string> = {
  'scan-vs-volume.svg': scanVsVolume,
  'cold-start-requests.svg': coldStart,
  'paged-breakdown.svg': pagedBreakdown,
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
