/**
 * Aggregates phase-2 host result directories into one CSV and a Markdown table.
 * Usage: bun run src/phase2/report.ts --host LABEL=DIR [--host LABEL=DIR ...] --csv OUT.csv --md OUT.md
 * Each DIR is a scripts/phase2-run.sh output (subdirectories with samples.jsonl / controls.jsonl).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { WalletSample } from './model.ts';
import { summaryRow, type SummaryRow } from './sweep.ts';

interface HostRow extends SummaryRow {
  host: string;
  cpu: string;
  sweep: string;
}

async function jsonl(path: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { host: { type: 'string', multiple: true }, csv: { type: 'string' }, md: { type: 'string' } },
  });
  const rows: HostRow[] = [];
  const controls: string[] = [];
  for (const entry of values.host ?? []) {
    const [host, dir] = entry.split('=');
    if (host === undefined || dir === undefined) throw new Error(`invalid --host ${entry}`);
    for (const sweep of (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
      for (const sample of await jsonl(join(dir, sweep, 'samples.jsonl'))) {
        const typed = { ...(sample as unknown as WalletSample), pages: [] };
        const env = typed.environment as { cpuModel?: string };
        rows.push({ host, cpu: env.cpuModel ?? '', sweep, ...summaryRow(typed) });
      }
      for (const control of await jsonl(join(dir, sweep, 'controls.jsonl'))) {
        controls.push(`| ${host} | ${sweep} | ${String(control.label)} | ${(Number(control.scanMs) / 1000).toFixed(3)} | ${(Number(control.processLifetimePeakRssBytes) / 1024 ** 2).toFixed(0)} |`);
      }
    }
  }
  const headers = Object.keys(rows[0] ?? {}) as (keyof HostRow)[];
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  if (values.csv !== undefined) {
    await writeFile(values.csv, `${headers.join(',')}\n${rows.map(r => headers.map(h => cell(r[h])).join(',')).join('\n')}\n`);
  }
  if (values.md !== undefined) {
    const lines = [
      '| Host | Size | Scenario | Profile | Page blocks | Network s | Decode s | Scan s | Verify s | Total s | First match s | Requests | Wire down MiB | Wallet peak RSS MiB | Chain RSS MiB |',
      '| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...rows.filter(r => r.scenario !== 'prefix').map(r =>
        `| ${r.host} | ${r.count} | ${r.scenario} | ${r.profile} | ${r.pageBlocks} | ${r.networkS} | ${r.decodeS} | ${r.scanS} | ${r.verifyS} | ${r.totalS} | ${r.firstMatchS ?? '-'} | ${r.requests} | ${r.wireDownMiB} | ${r.peakRssMiB} | ${r.chainRssMiB} |`),
      '',
      '| Host | Sweep | Control | 100k crypto scan s | Peak RSS MiB |',
      '| --- | --- | --- | ---: | ---: |',
      ...controls,
    ];
    await writeFile(values.md, `${lines.join('\n')}\n`);
  }
  console.error(`${rows.length} samples, ${controls.length} controls`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
