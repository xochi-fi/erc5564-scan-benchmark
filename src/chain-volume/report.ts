/** Builds data/chain-volume/{summary.csv,endpoints.csv,summary.md} from the recorded stage files. */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAINS } from './chains.ts';
import type { EndpointProbe } from './probe.ts';
import { classifyError } from './rpc.ts';
import { compareSets, parseKeyed } from './retrieve.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

async function maybe(path: string): Promise<Json | null> {
  return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null;
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const toCsv = (rows: Array<Record<string, unknown>>) => {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return `${[headers.join(','), ...rows.map(row => headers.map(h => csvCell(row[h])).join(','))].join('\n')}\n`;
};

export const spanLabel = (probe: EndpointProbe) => {
  if (probe.range === null) return '';
  if (probe.range.unbounded) return `whole history (${probe.range.maxOk})`;
  return String(probe.range.maxOk);
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] ?? null : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const fmt = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? '-' : n.toLocaleString('en-US', { maximumFractionDigits: digits }));

function monthsBetween(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  return (Date.parse(b) - Date.parse(a)) / (30.44 * 86400_000);
}

export async function buildReport(out: string): Promise<void> {
  const endpointsFile = await maybe(join(out, 'endpoints.json'));
  const endpointRows: Array<Record<string, unknown>> = [];
  const summaryRows: Array<Record<string, unknown>> = [];
  const md: string[] = [];
  md.push('| Chain | Deploy block | Announcements (source) | First - last block | Per month | Keyless endpoints: listed / probed / usable / full archive | Max getLogs span (blocks), endpoints serving the deploy block: median [min-max] | Full retrieval, list order | Full retrieval, probe-informed | Full retrieval, parallel | Indexers (keyless) |');
  md.push('| --- | ---: | --- | --- | ---: | --- | --- | --- | --- | --- | --- |');
  for (const chain of CHAINS) {
    const listed: Json[] = endpointsFile?.chains?.[chain.key] ?? [];
    const ref = await maybe(join(out, 'canonical', `reference-${chain.key}.json`));
    const probe = await maybe(join(out, 'probe', `${chain.key}.json`));
    const retrievals: Record<string, Json> = {};
    for (const strategy of ['list-order', 'probe-informed', 'parallel']) retrievals[strategy] = await maybe(join(out, 'canonical', `retrieve-${chain.key}-${strategy}.json`));
    const probes: EndpointProbe[] = probe?.endpoints ?? [];
    for (const p of probes) {
      endpointRows.push({
        chain: chain.key, host: p.host, url: p.url, status: p.status, unusableReason: p.unusableReason,
        maxSpanOk: p.range?.maxOk ?? null, minSpanFail: p.range?.minFail ?? null, wholeHistory: p.range?.unbounded ?? null,
        archiveDepthServed: p.archiveDepthServed, servesDeployBlock: p.servesDeployBlock, firstLogReturned: p.firstLogReturned,
        latencySpan: p.latency.span, latencyOk: p.latency.okSamples, medianMs: p.latency.medianMs === null ? null : Math.round(p.latency.medianMs),
        p95Ms: p.latency.p95Ms === null ? null : Math.round(p.latency.p95Ms), requests: p.requests, rateLimitHits: p.rateLimitHits,
        retryAfter: p.retryAfterSeen.join(' '), errorKinds: [...new Set(p.errors.map(e => classifyError(e.message, e.httpStatus)))].join(' '),
        firstError: p.errors[0] ? `${classifyError(p.errors[0].message, p.errors[0].httpStatus)} [${p.errors[0].code ?? p.errors[0].httpStatus}] ${p.errors[0].message}` : '',
      });
    }
    const usable = probes.filter(p => p.status === 'usable');
    const fullArchive = usable.filter(p => p.servesDeployBlock === true);
    // Only historical endpoints contribute to the span summary.
    const spans = fullArchive.map(p => (p.range?.unbounded ? Number.POSITIVE_INFINITY : p.range?.maxOk ?? 0));
    const finite = spans.filter(Number.isFinite);
    const unbounded = spans.length - finite.length;
    const med = median(spans.map(v => (Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER)));
    const spanText = spans.length === 0 ? '-' : `${med === Number.MAX_SAFE_INTEGER ? 'whole history' : fmt(med)} [${fmt(Math.min(...spans))}-${unbounded ? 'whole history' : fmt(Math.max(...finite))}]${unbounded ? `; ${unbounded} took the whole history` : ''}`;
    const reference = ref?.reference ?? null;
    const informed = [retrievals['probe-informed'], retrievals['parallel']].map(r => r?.result).find(r => r?.success) ?? null;
    const rateBase = reference ?? (informed?.success ? { count: informed.count, firstTime: informed.firstTime } : null);
    const months = monthsBetween(rateBase?.firstTime ?? null, (reference ? ref?.measuredAt : (retrievals['probe-informed']?.measuredAt ?? retrievals['parallel']?.measuredAt)) ?? null);
    const retrievalText = (r: Json) => {
      if (r === null) return 'not run';
      if (r.skipped) return `not run (${r.skipped.join('; ')})`;
      const res = r.result;
      const match = r.comparison ? (r.comparison.exact ? `exact match (${r.comparison.matched}/${r.comparison.reference})` : `MISMATCH: ${r.comparison.missing.length} missing, ${r.comparison.extra.length} extra, ${r.comparison.txMismatch.length} tx differ`) : 'no reference set';
      return `${res.success ? 'OK' : 'FAILED'}: ${fmt(res.count)} logs, ${fmt(res.totalMs / 1000)} s, ${fmt(res.requests)} req, ${fmt(res.responseBytes / 1024)} KiB, ${res.endpointSwitches} switches; ${match}${res.failure ? `; ${res.failure}` : ''}`;
    };
    const indexers: Json[] = ref?.indexers ?? [];
    const indexerText = indexers.length === 0 ? '-' : indexers.map(i => `${i.source.replace('-etherscan-api', ' etherscan-api')}: ${i.ok ? `${i.count}` : i.blocked ? 'blocked (Cloudflare)' : `failed (${String(i.failure).slice(0, 40)})`}`).join('; ');
    const count = reference?.count ?? informed?.count ?? null;
    const refSource = reference ? reference.source.split(' ')[0] : informed ? 'keyless RPC only' : '-';
    const first = reference?.firstBlock ?? informed?.firstBlock ?? null;
    const last = reference?.lastBlock ?? informed?.lastBlock ?? null;
    md.push(`| ${chain.name} | ${fmt(probe?.deployBlock ?? ref?.deploy?.block)} | ${fmt(count)} (${refSource}) | ${fmt(first)} - ${fmt(last)} | ${months && rateBase ? fmt(rateBase.count / months, 1) : '-'} | ${listed.length} / ${listed.filter((e: Json) => e.excluded === null).length} / ${usable.length} / ${fullArchive.length} | ${spanText} | ${retrievalText(retrievals['list-order'])} | ${retrievalText(retrievals['probe-informed'])} | ${retrievals['parallel'] ? retrievalText(retrievals['parallel']) : '-'} | ${indexerText} |`);
    summaryRows.push({
      chain: chain.key, chainId: chain.chainId, deployBlock: probe?.deployBlock ?? ref?.deploy?.block ?? null, deploySource: probe?.deploySource ?? ref?.deploy?.source ?? null,
      referenceSource: reference?.source ?? null, referenceCount: reference?.count ?? null, firstBlock: first, lastBlock: last,
      firstTime: reference?.firstTime ?? null, lastTime: reference?.lastTime ?? null, perMonth: months && rateBase ? (rateBase.count / months).toFixed(2) : null,
      endpointsListed: listed.length, endpointsProbed: listed.filter((e: Json) => e.excluded === null).length, endpointsUsable: usable.length, endpointsFullArchive: fullArchive.length,
      endpointsSilentMiss: usable.filter(p => p.firstLogReturned === false && p.servesDeployBlock === true).length,
      spanMedianFullArchive: med === Number.MAX_SAFE_INTEGER ? 'whole history' : med, spanMinFullArchive: spans.length ? Math.min(...spans) : null, spanWholeHistory: unbounded,
      ...Object.fromEntries(['list-order', 'probe-informed', 'parallel'].flatMap(strategy => {
        const r = retrievals[strategy];
        const res = r?.result;
        return [
          [`${strategy}:success`, res?.success ?? null], [`${strategy}:count`, res?.count ?? null], [`${strategy}:seconds`, res ? (res.totalMs / 1000).toFixed(1) : null],
          [`${strategy}:requests`, res?.requests ?? null], [`${strategy}:bytes`, res?.responseBytes ?? null], [`${strategy}:switches`, res?.endpointSwitches ?? null],
          [`${strategy}:exact`, r?.comparison?.exact ?? null], [`${strategy}:failure`, res?.failure ?? (r?.skipped ? r.skipped.join('; ') : null)],
        ];
      })),
    });
  }
  // ScopeLift SDK getAnnouncements default: fetchLogsInChunks from block 0 ('earliest') in 5,000-block chunks, sequential, no retry.
  md.push('', '| Chain | Head | SDK default requests (0 to head / 5,000) | From deploy block / 5,000 | Keyless endpoints that accept 5,000 blocks and serve the deploy block | At their median latency, s (sequential) |', '| --- | ---: | ---: | ---: | --- | --- |');
  for (const chain of CHAINS) {
    const probe = await maybe(join(out, 'probe', `${chain.key}.json`));
    if (probe === null) continue;
    const eps: EndpointProbe[] = probe.endpoints;
    const head = Math.max(...eps.map(e => e.head ?? 0));
    const ok = eps.filter(e => e.status === 'usable' && e.servesDeployBlock === true && (e.range?.unbounded || (e.range?.maxOk ?? 0) >= 5000));
    const fromZero = Math.ceil((head + 1) / 5000);
    const fromDeploy = Math.ceil((head - probe.deployBlock + 1) / 5000);
    md.push(`| ${chain.name} | ${fmt(head)} | ${fmt(fromZero)} | ${fmt(fromDeploy)} | ${ok.map(e => e.host).join(', ') || 'none'} | ${ok.map(e => fmt(((e.latency.medianMs ?? 0) * fromZero) / 1000)).join(', ') || '-'} |`);
  }
  // Cross-source agreement: every successful source's identity set against every other.
  md.push('', '| Chain | Source A | Source B | A | B | Same block:logIndex set | Tx hashes agree |', '| --- | --- | --- | ---: | ---: | --- | --- |');
  const crossRows: Array<Record<string, unknown>> = [];
  for (const chain of CHAINS) {
    const ref = await maybe(join(out, 'canonical', `reference-${chain.key}.json`));
    const sets: Array<{ name: string; rows: string[]; head: number | null }> = [];
    for (const i of ref?.indexers ?? []) if (i.ok && i.identities?.length) sets.push({ name: i.source === 'blockscout-v2' ? `${i.source} (tx filled)` : i.source, rows: i.identities, head: ref.rpcHead });
    for (const strategy of ['list-order', 'probe-informed', 'parallel']) {
      const r = await maybe(join(out, 'canonical', `retrieve-${chain.key}-${strategy}.json`));
      if (r?.result?.success) {
        const main = [...r.result.endpoints].sort((x: Json, y: Json) => y.ok - x.ok)[0];
        sets.push({ name: `rpc ${strategy} (mostly ${main ? new URL(String(main.url).replace(/^segment \d+: /, '')).host : '?'})`, rows: r.identities, head: r.result.toBlock });
      }
    }
    const cutoff = Math.min(...sets.map(set => set.head ?? Number.MAX_SAFE_INTEGER));
    for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
      const A = sets[a]!; const B = sets[b]!;
      const pa = A.rows.map(parseKeyed).filter(x => x.blockNumber <= cutoff);
      const pb = B.rows.map(parseKeyed).filter(x => x.blockNumber <= cutoff);
      const c = compareSets(pa, pb);
      const setText = c.missing.length === 0 && c.extra.length === 0 ? 'yes' : `no: ${c.missing.length ? `${c.missing.length}+ only in A` : ''}${c.extra.length ? ` ${c.extra.length}${c.extra.length === 20 ? '+' : ''} only in B (e.g. ${c.extra.slice(0, 2).join(', ')})` : ''}`;
      md.push(`| ${chain.name} | ${A.name} | ${B.name} | ${pa.length} | ${pb.length} | ${setText} | ${c.txMismatch.length === 0 ? `yes${c.referenceTxMissing ? ` (${c.referenceTxMissing} rows without tx in A)` : ''}` : `${c.txMismatch.length} differ`} |`);
      crossRows.push({ chain: chain.key, a: A.name, b: B.name, countA: pa.length, countB: pb.length, cutoffBlock: cutoff, onlyInA: c.reference - c.matched, onlyInB: c.candidate - c.matched, txMismatch: c.txMismatch.length, exact: c.exact });
    }
  }
  await writeFile(join(out, 'cross-source.csv'), toCsv(crossRows));
  await writeFile(join(out, 'summary.csv'), toCsv(summaryRows));
  await writeFile(join(out, 'endpoints.csv'), toCsv(endpointRows));
  await writeFile(join(out, 'summary.md'), `${md.join('\n')}\n`);
  process.stdout.write(`${md.join('\n')}\n`);
}
