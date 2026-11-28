// Aggregate per-host and per-node samples into median, min and max.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { WalletSample } from './model.ts';
import { spread, type Spread } from './repeat.ts';
import { summaryRow, type HostMonitor, type SummaryRow } from './sweep.ts';
import { readJsonl } from '../shared/host.ts';

/** A sample is tainted when the host swapped or was under memory pressure while it ran. */
export const SWAP_PAGES_PER_S_LIMIT = 100;
export const MEMORY_PSI_AVG10_LIMIT = 1.0;

interface SampleRow extends SummaryRow {
  host: string;
  node: string;
  run: string;
  sweep: string;
  order: number | null;
  verifyPerPaymentS: number | null;
  cooldownWaitS: number | null;
  startMaxThermalC: number | null;
  maxThermalC: number | null;
  maxThrottleState: number | null;
  minWalletCpuMHz: number | null;
  maxSwapPagesPerS: number | null;
  swapPagesInOut: number | null;
  maxMemoryPsiAvg10: number | null;
  swapUsedMiB: number | null;
  tainted: boolean;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function walletCpus(runJson: Record<string, unknown>): string[] | null {
  const list = (runJson.options as { walletCpus?: string | null } | undefined)?.walletCpus;
  if (typeof list !== 'string') return null;
  return list.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map(Number);
    if (a === undefined || Number.isNaN(a)) return [];
    return b === undefined ? [String(a)] : Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  });
}

function hostFields(record: Record<string, unknown>, cpus: string[] | null, gateOverridden: boolean) {
  const before = (record.hostBefore ?? {}) as Record<string, unknown>;
  const monitor = (record.hostMonitor ?? null) as HostMonitor | null;
  const cooldown = (record.cooldown ?? null) as Record<string, unknown> | null;
  const swapTotal = num(before.swapTotalBytes);
  const swapFree = num(before.swapFreeBytes);
  const throttle = monitor === null ? [] : Object.entries(monitor.maxCoolingState).filter(([k]) => k.includes('cpufreq')).map(([, v]) => v);
  const freqs = monitor === null ? [] : Object.entries(monitor.minCpuMHz).filter(([cpu]) => cpus === null || cpus.includes(cpu)).map(([, v]) => v);
  const maxSwapPagesPerS = monitor?.maxSwapPagesPerS ?? null;
  const maxMemoryPsiAvg10 = monitor?.maxMemoryPsiSomeAvg10 ?? null;
  return {
    node: typeof before.hostname === 'string' ? before.hostname : '?',
    cooldownWaitS: num(cooldown?.waitedS),
    startMaxThermalC: num(cooldown?.startMaxC) ?? (before.thermalC === undefined ? null : Math.max(...Object.values(before.thermalC as Record<string, number>))),
    maxThermalC: monitor?.maxThermalC ?? null,
    maxThrottleState: throttle.length === 0 ? null : Math.max(...throttle),
    minWalletCpuMHz: freqs.length === 0 ? null : Math.min(...freqs),
    maxSwapPagesPerS,
    swapPagesInOut: monitor?.swapPagesInOut ?? null,
    maxMemoryPsiAvg10,
    swapUsedMiB: swapTotal === null || swapFree === null ? null : Number(((swapTotal - swapFree) / 1024 ** 2).toFixed(0)),
    tainted: gateOverridden || (maxSwapPagesPerS ?? 0) > SWAP_PAGES_PER_S_LIMIT || (maxMemoryPsiAvg10 ?? 0) > MEMORY_PSI_AVG10_LIMIT,
  };
}

const METRICS = ['totalS', 'networkS', 'scanS', 'verifyS', 'verifyPerPaymentS', 'firstMatchS', 'peakRssMiB', 'wireDownMiB'] as const;
type Metric = typeof METRICS[number];

export interface SettingSummary {
  host: string;
  count: number;
  matches: number;
  scenario: string;
  profile: string;
  pageBlocks: number;
  verifyMode: string;
  n: number;
  nodes: string;
  tainted: number;
  maxThermalC: number | null;
  maxThrottleState: number | null;
  stats: Record<Metric, Spread>;
}

export function summarize(rows: readonly SampleRow[]): SettingSummary[] {
  const groups = new Map<string, SampleRow[]>();
  for (const row of rows) {
    if (row.scenario === 'prefix') continue;
    const key = [row.host, row.count, row.matches, row.scenario, row.profile, row.pageBlocks, row.verifyMode].join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as SampleRow;
    const thermal = group.map(r => r.maxThermalC).filter((v): v is number => v !== null);
    const throttle = group.map(r => r.maxThrottleState).filter((v): v is number => v !== null);
    return {
      host: first.host,
      count: first.count,
      matches: first.matches,
      scenario: first.scenario,
      profile: first.profile,
      pageBlocks: first.pageBlocks,
      verifyMode: first.verifyMode,
      n: group.length,
      nodes: [...new Set(group.map(r => r.node))].sort().join(' '),
      tainted: group.filter(r => r.tainted).length,
      maxThermalC: thermal.length === 0 ? null : Math.max(...thermal),
      maxThrottleState: throttle.length === 0 ? null : Math.max(...throttle),
      stats: Object.fromEntries(METRICS.map(m => [m, spread(group.map(r => r[m]))])) as Record<Metric, Spread>,
    };
  }).sort((a, b) => a.host.localeCompare(b.host) || a.count - b.count || a.scenario.localeCompare(b.scenario)
    || a.profile.localeCompare(b.profile) || a.pageBlocks - b.pageBlocks || a.verifyMode.localeCompare(b.verifyMode));
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = (rows: Record<string, unknown>[]): string => {
  const headers = Object.keys(rows[0] ?? {});
  return `${headers.join(',')}\n${rows.map(r => headers.map(h => cell(r[h])).join(',')).join('\n')}\n`;
};
const fmt = (value: number | null, digits: number): string => (value === null ? '-' : value.toFixed(digits));
export const formatSpread = (s: Spread, digits: number): string =>
  s.n === 0 ? '-' : s.n === 1 ? fmt(s.median, digits) : `${fmt(s.median, digits)} [${fmt(s.min, digits)}-${fmt(s.max, digits)}]`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { host: { type: 'string', multiple: true }, 'samples-csv': { type: 'string' }, csv: { type: 'string' }, md: { type: 'string' } },
  });
  const rows: SampleRow[] = [];
  const controls: Record<string, unknown>[] = [];
  for (const entry of values.host ?? []) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`invalid --host ${entry}`);
    const host = entry.slice(0, separator);
    const dir = entry.slice(separator + 1);
    const run = dir.split('/').filter(Boolean).at(-1) ?? dir;
    // A run started with ALLOW_BUSY_HOST=1 after a failed host gate taints every sample in it.
    const gate = await readFile(join(dir, 'HOST-GATE.txt'), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
      throw error;
    });
    const gateOverridden = /^override:/m.test(gate);
    if (gateOverridden) console.error(`${run}: host gate was overridden; all its samples are marked tainted`);
    for (const sweep of (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
      const runJson = JSON.parse(await readFile(join(dir, sweep, 'run.json'), 'utf8')) as Record<string, unknown>;
      const cpus = walletCpus(runJson);
      for (const record of await readJsonl(join(dir, sweep, 'samples.jsonl'))) {
        const sample = { ...(record as unknown as WalletSample), pages: [] };
        const summary = summaryRow(sample);
        rows.push({
          host, run, sweep, order: num(record.order), ...summary,
          verifyPerPaymentS: summary.matches > 0 ? Number((summary.verifyS / summary.matches).toFixed(4)) : null,
          ...hostFields(record, cpus, gateOverridden),
        });
      }
      for (const control of await readJsonl(join(dir, sweep, 'controls.jsonl'))) {
        const fields = hostFields(control, cpus, gateOverridden);
        controls.push({
          host, run, sweep, node: fields.node, label: control.label,
          scanS: Number((Number(control.scanMs) / 1000).toFixed(3)),
          peakRssMiB: Number((Number(control.processLifetimePeakRssBytes) / 1024 ** 2).toFixed(0)),
          maxThermalC: fields.maxThermalC, maxThrottleState: fields.maxThrottleState, minWalletCpuMHz: fields.minWalletCpuMHz, tainted: fields.tainted,
        });
      }
    }
  }
  const summaries = summarize(rows);
  if (values['samples-csv'] !== undefined) await writeFile(values['samples-csv'], csv(rows as unknown as Record<string, unknown>[]));
  if (values.csv !== undefined) {
    await writeFile(values.csv, csv(summaries.map(s => {
      const { stats, ...rest } = s;
      return {
        ...rest,
        ...Object.fromEntries(METRICS.flatMap(m => [[`${m}Median`, stats[m].median], [`${m}Min`, stats[m].min], [`${m}Max`, stats[m].max]])),
      };
    })));
  }
  if (values.md !== undefined) {
    const lines = [
      'Values are median [min-max] over n samples.',
      '',
      '| Host | Size | Scenario | Profile | Page blocks | Verify | n | Nodes | Network s | Scan s | Verify s | Verify s/payment | Total s | First match s | Wallet peak RSS MiB | Max C | Throttle | Tainted |',
      '| --- | ---: | --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...summaries.map(s => `| ${s.host} | ${s.count} | ${s.scenario} | ${s.profile} | ${s.pageBlocks} | ${s.verifyMode} | ${s.n} | ${s.nodes} | ${formatSpread(s.stats.networkS, 1)} | ${formatSpread(s.stats.scanS, 1)} | ${formatSpread(s.stats.verifyS, 2)} | ${formatSpread(s.stats.verifyPerPaymentS, 4)} | ${formatSpread(s.stats.totalS, 1)} | ${formatSpread(s.stats.firstMatchS, 2)} | ${formatSpread(s.stats.peakRssMiB, 0)} | ${fmt(s.maxThermalC, 1)} | ${s.maxThrottleState ?? '-'} | ${s.tainted} |`),
      '',
      '| Host | Node | Run | Control | 100k crypto scan s | Max C | Throttle | Min wallet MHz | Tainted |',
      '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
      ...controls.map(c => `| ${String(c.host)} | ${String(c.node)} | ${String(c.run)} | ${String(c.label)} | ${String(c.scanS)} | ${fmt(c.maxThermalC as number | null, 1)} | ${String(c.maxThrottleState ?? '-')} | ${String(c.minWalletCpuMHz ?? '-')} | ${String(c.tainted)} |`),
    ];
    await writeFile(values.md, `${lines.join('\n')}\n`);
  }
  console.error(`${rows.length} samples (${rows.filter(r => r.tainted).length} tainted), ${summaries.length} settings, ${controls.length} controls`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
