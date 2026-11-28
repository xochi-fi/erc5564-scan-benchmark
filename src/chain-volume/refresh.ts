// `bun run chain-volume:refresh`: the weekly live refresh. Read-only and keyless.
// Per chain, resumes from the last agreed block, fetches the new range from two endpoint sets with no
// provider in common, and records the new announcements only if both sets agree exactly. Then rechecks
// the hosts that silently omitted known announcements on 2026-11-26. Writes refresh/<date>.json and a
// Markdown report (the pull request body). Hardware timings are not touched.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CHAINS, chainByKey, type ChainConfig } from './chains.ts';
import { PoliteHttp, USER_AGENT, type Transport } from './http.ts';
import type { ProbeFile } from './run.ts';
import { compareSets, formatKeyed, parseKeyed, retrieveHistory } from './retrieve.ts';
import { getLogsParams, quantity, rpc, rpcLogsSchema, toHex } from './rpc.ts';
import {
  REFRESH_DIR, chainState, disjointSets, loadBaseline, loadSnapshots, providerKey, silentVerdict, statePerMonth, stateSinceBaseline,
  type RefreshChain, type RefreshSet, type RefreshSnapshot, type SilentCheck,
} from './refresh-state.ts';

const log = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** Seconds of chain kept back from the lower of the two heads, so a reorg or a lagging backend cannot split the sets. */
const MARGIN_S = 900;
async function headOf(transport: Transport, urls: string[]): Promise<number | null> {
  for (const url of urls) {
    const call = await rpc(transport, url, 'eth_blockNumber', [], quantity);
    if (call.result !== null) return call.result;
  }
  return null;
}

async function blockTime(transport: Transport, urls: string[], block: number): Promise<string | null> {
  for (const url of urls) {
    const call = await rpc(transport, url, 'eth_getBlockByNumber', [toHex(block), false], z.object({ timestamp: quantity }).passthrough());
    if (call.result) return new Date(call.result.timestamp * 1000).toISOString();
  }
  return null;
}

/** Hosts the 2026-11-26 consistency check caught returning [] for a known announcement. */
const silentHosts = (dir: string, chain: string): Set<string> => {
  const path = join(dir, 'consistency', `${chain}.json`);
  return new Set(existsSync(path) ? readJson(path).endpoints.filter((e: any) => e.empty > 0).map((e: any) => e.host as string) : []);
};

async function refreshChain(transport: Transport, dir: string, chain: ChainConfig, date: string, budget: { requests: number; minutes: number; perSet: number }): Promise<RefreshChain> {
  const baseline = loadBaseline(dir, chain.key);
  const state = chainState(baseline, loadSnapshots(dir, date));
  const fromBlock = state.throughBlock + 1;
  const probe = readJson(join(dir, 'probe', `${chain.key}.json`)) as ProbeFile;
  const silent = silentHosts(dir, chain.key);
  // Same preference as the probe-informed run: endpoints that served the deploy block, widest span first, silent hosts left out.
  const span = (e: ProbeFile['endpoints'][number]) => (e.range?.unbounded ? Number.MAX_SAFE_INTEGER : e.range?.maxOk ?? 0);
  const ranked = probe.endpoints
    .filter(e => e.status === 'usable' && e.servesDeployBlock === true && e.firstLogReturned !== false && !silent.has(e.host))
    .sort((a, b) => span(b) - span(a) || (a.latency.medianMs ?? 1e9) - (b.latency.medianMs ?? 1e9));
  const [setA, setB] = disjointSets(ranked.map(e => ({ url: e.url, host: e.host })), budget.perSet);
  const entry: RefreshChain = {
    status: 'failed', reason: null, fromBlock, toBlock: null, throughTime: null, baselineThroughTime: null,
    sets: [setA, setB].map((urls): RefreshSet => ({ endpoints: urls.map(url => new URL(url).host), head: null, success: false, failure: null, requests: 0, count: null })),
    comparison: null, identities: [], lastTime: null,
  };
  if (setA.length === 0 || setB.length === 0) { entry.reason = 'fewer than two independent providers'; return entry; }
  const heads = await Promise.all([headOf(transport, setA), headOf(transport, setB)]);
  heads.forEach((head, i) => { entry.sets[i]!.head = head; });
  if (heads.some(head => head === null)) { entry.reason = `no head from set ${heads[0] === null ? 'A' : 'B'}`; return entry; }
  const urls = [...setA, ...setB];
  // Block time measured over the last 1,000 blocks (chain configs carry stale rough values, e.g. Base at 2 s).
  const low = Math.min(...(heads as number[]));
  const [t1, t0] = await Promise.all([blockTime(transport, urls, low), blockTime(transport, urls, low - 1000)]);
  const blockSeconds = t1 !== null && t0 !== null && t1 > t0 ? (Date.parse(t1) - Date.parse(t0)) / 1000 / 1000 : chain.blockSeconds;
  const toBlock = low - Math.ceil(MARGIN_S / blockSeconds);
  if (toBlock < fromBlock) { entry.reason = `no new blocks past ${fromBlock - 1}`; return entry; }
  log(`[${chain.key}] ${fromBlock}..${toBlock} (${toBlock - fromBlock + 1} blocks, ${blockSeconds.toFixed(2)} s/block); A ${entry.sets[0]!.endpoints.join(', ')}; B ${entry.sets[1]!.endpoints.join(', ')}`);
  const results = await Promise.all([setA, setB].map(endpoints => retrieveHistory(transport, {
    endpoints, fromBlock, toBlock, initialSpan: 10_000, maxRequests: budget.requests, maxMs: budget.minutes * 60_000,
  })));
  results.forEach((r, i) => Object.assign(entry.sets[i]!, { success: r.success, failure: r.failure, requests: r.requests, count: r.logs.length }));
  // Both sets cover [fromBlock, common]. A set that stopped early (budget, errors) still lets the agreed prefix advance.
  const common = Math.min(...results.map(r => r.checkpoint)) - 1;
  const stopped = results.map((r, i) => (r.success ? null : `set ${'AB'[i]} stopped at block ${r.checkpoint}: ${r.failure}`)).filter(Boolean).join('; ');
  if (common < fromBlock) { entry.reason = stopped; return entry; }
  const [a, b] = results.map(r => r.logs.filter(l => l.blockNumber <= common).map(formatKeyed)) as [string[], string[]];
  const comparison = compareSets(a.map(parseKeyed), b.map(parseKeyed));
  entry.comparison = { missing: comparison.missing, extra: comparison.extra, txMismatch: comparison.txMismatch };
  entry.toBlock = common;
  if (!comparison.exact) {
    entry.status = 'disagree';
    entry.reason = `set A ${a.length}, set B ${b.length} through block ${common}: ${comparison.missing.length} only in A, ${comparison.extra.length} only in B, ${comparison.txMismatch.length} tx mismatches`;
    entry.toBlock = null;
    return entry;
  }
  if (stopped) entry.reason = `partial: agreed through ${common} of ${toBlock}; ${stopped}`;
  entry.throughTime = await blockTime(transport, urls, common);
  if (entry.throughTime === null) { entry.status = 'failed'; entry.reason = `no timestamp for block ${common}`; entry.toBlock = null; return entry; }
  if (state.baselineThroughTime === null) entry.baselineThroughTime = await blockTime(transport, urls, baseline.toBlock);
  entry.identities = a;
  const last = a.at(-1);
  if (last !== undefined) entry.lastTime = await blockTime(transport, urls, parseKeyed(last).blockNumber);
  entry.status = 'agreed';
  log(`[${chain.key}] agreed: ${a.length} new, ${results[0]!.requests} + ${results[1]!.requests} requests`);
  return entry;
}

/** Re-asks each silent host for the recorded known announcements, in the recorded windows, beside a control endpoint. */
async function recheckSilent(transport: Transport, dir: string, chain: ChainConfig): Promise<SilentCheck[]> {
  const path = join(dir, 'consistency', `${chain.key}.json`);
  if (!existsSync(path)) return [];
  const recorded = readJson(path);
  const probe = readJson(join(dir, 'probe', `${chain.key}.json`)) as ProbeFile;
  const silent = recorded.endpoints.filter((e: any) => e.empty > 0);
  if (silent.length === 0) return [];
  const silentProviders = new Set(silent.map((e: any) => providerKey(e.host)));
  // Control: an endpoint that returned every target on 2026-11-26, widest window first.
  const control = recorded.endpoints
    .filter((e: any) => e.returned === e.checks.length && !silentProviders.has(providerKey(e.host)))
    .sort((x: any, y: any) => y.window - x.window)[0];
  const targets = (recorded.targets as string[]).map(key => ({ key, blockNumber: Number(key.split(':')[0]) }));
  const ask = async (url: string, from: number, window: number, key: string) => {
    const call = await rpc(transport, url, 'eth_getLogs', getLogsParams(from, from + window - 1), rpcLogsSchema);
    const outcome = call.error ? `error: ${call.error.kind}` : call.result!.some(l => `${l.blockNumber}:${l.logIndex}` === key) ? 'returned' : 'empty';
    return { outcome, message: call.error?.message.slice(0, 120) ?? null };
  };
  return Promise.all(silent.map(async (endpoint: any): Promise<SilentCheck> => {
    const checks: SilentCheck['checks'] = [];
    for (const target of targets) {
      const from = Math.max(probe.deployBlock, target.blockNumber - Math.floor(endpoint.window / 2));
      for (let attempt = 1; attempt <= 2; attempt++) {
        const [own, ctl] = await Promise.all([
          ask(endpoint.url, from, endpoint.window, target.key),
          control ? ask(control.url, from, endpoint.window, target.key) : Promise.resolve({ outcome: 'none', message: null }),
        ]);
        checks.push({ target: target.key, attempt, outcome: own.outcome, control: ctl.outcome, message: own.message });
      }
    }
    const outcomes = checks.map(c => c.outcome);
    const result: SilentCheck = {
      chain: chain.key, host: endpoint.host, url: endpoint.url, window: endpoint.window, control: control?.host ?? null, checks,
      returned: outcomes.filter(o => o === 'returned').length, empty: outcomes.filter(o => o === 'empty').length,
      errors: outcomes.filter(o => o.startsWith('error')).length, verdict: silentVerdict(checks),
    };
    log(`[${chain.key}] ${endpoint.host}: ${result.verdict} (${result.returned} returned, ${result.empty} empty, ${result.errors} errors; control ${result.control})`);
    return result;
  }));
}

const n = (value: number) => value.toLocaleString('en-US');

function report(dir: string, snapshot: RefreshSnapshot): string {
  const lines = [
    `Weekly chain-volume refresh, ${snapshot.date} (${snapshot.runner}). Keyless, read-only; new blocks fetched from two endpoint sets with no provider in common.`,
    '', '| Chain | Status | Announcements | New this run | Checked through | Requests A + B | Note |', '| --- | --- | ---: | ---: | --- | ---: | --- |',
  ];
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(snapshot.chains)) {
    const state = chainState(loadBaseline(dir, key), [...loadSnapshots(dir, snapshot.date), snapshot]);
    const requests = entry.sets.map(s => n(s.requests)).join(' + ');
    const through = `${n(state.throughBlock)}${state.throughTime ? ` (${state.throughTime.slice(0, 16)}Z)` : ''}`;
    lines.push(`| ${chainByKey(key).name} | ${entry.status} | ${n(state.count)} | ${entry.status === 'agreed' ? n(entry.identities.length) : '-'} | ${through} | ${requests} | ${entry.reason ?? ''} |`);
    if (entry.status !== 'agreed') problems.push(`- ${chainByKey(key).name}: ${entry.status}, ${entry.reason}. Count left at the last agreed block; next run retries from ${n(entry.fromBlock)}.`);
  }
  lines.push('', '| Chain | Silent host on 2026-11-26 | Now | Returned / empty / errors | Control |', '| --- | --- | --- | --- | --- |');
  for (const check of snapshot.silent) {
    lines.push(`| ${chainByKey(check.chain).name} | ${check.host} | ${check.verdict} | ${check.returned} / ${check.empty} / ${check.errors} | ${check.control ?? 'none'} |`);
    if (check.verdict === 'inconclusive' || check.verdict === 'errors') problems.push(`- ${check.host} (${check.chain}): ${check.verdict}; the control did not return the targets or the host errored.`);
    if (check.verdict === 'returns all') problems.push(`- ${check.host} (${check.chain}) now returns every known announcement. Review the chain-volume findings before merging.`);
  }
  if (problems.length > 0) lines.push('', '**Needs review**', '', ...problems);
  lines.push('', 'Hardware timings (scan cost, paged discovery, feed latency) are fixed recordings and are not refreshed.');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      output: { type: 'string', default: 'data/chain-volume' },
      chains: { type: 'string', default: CHAINS.map(c => c.key).join(',') },
      'max-requests': { type: 'string', default: '6000' },
      'max-minutes': { type: 'string', default: '40' },
      'per-set': { type: 'string', default: '4' },
      report: { type: 'string' },
      runner: { type: 'string', default: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : hostname().split('.')[0]! },
    },
  });
  const dir = resolve(values.output);
  const date = new Date().toISOString().slice(0, 10);
  const budget = { requests: Number(values['max-requests']), minutes: Number(values['max-minutes']), perSet: Number(values['per-set']) };
  // ≤4 requests/s per provider (METHODS.md, Live RPC): hostnames of one operator share a pacing slot.
  const transport = new PoliteHttp({ minIntervalMs: 250, keyOf: url => providerKey(url.host) });
  log(`User-Agent: ${USER_AGENT}; budget ${budget.requests} requests per set per chain, ${budget.minutes} min`);
  const chains = values.chains.split(',').map(chainByKey);
  const snapshot: RefreshSnapshot = {
    kind: 'chain-volume-refresh', version: 1, date, measuredAt: new Date().toISOString(), runner: values.runner, userAgent: USER_AGENT, chains: {}, silent: [],
  };
  // Chains one after another: a provider serving several chains sees one paced stream.
  for (const chain of chains) {
    try {
      snapshot.chains[chain.key] = await refreshChain(transport, dir, chain, date, budget);
    } catch (error) {
      snapshot.chains[chain.key] = {
        status: 'failed', reason: `error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), fromBlock: -1, toBlock: null,
        throughTime: null, baselineThroughTime: null, sets: [], comparison: null, identities: [], lastTime: null,
      };
    }
    snapshot.silent.push(...await recheckSilent(transport, dir, chain));
  }
  await mkdir(join(dir, REFRESH_DIR), { recursive: true });
  await writeFile(join(dir, REFRESH_DIR, `${date}.json`), `${JSON.stringify(snapshot, null, 1)}\n`);
  log(`wrote ${join(dir, REFRESH_DIR, `${date}.json`)}`);
  const text = report(dir, snapshot);
  if (values.report) await writeFile(values.report, text);
  process.stdout.write(text);
  for (const [key, entry] of Object.entries(snapshot.chains)) {
    if (entry.status === 'agreed') {
      const state = chainState(loadBaseline(dir, key), loadSnapshots(dir));
      log(`[${key}] ${state.count} total, ${statePerMonth(state)?.toFixed(1)}/month, since baseline ${stateSinceBaseline(state)?.perDay.toFixed(2)}/day`);
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
