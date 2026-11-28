// `bun run phone-bench:cli [--engine crypto|sdk] [--count N] [--out FILE]`: the page's scan code outside a
// browser, on the same pinned fixture. With BUN_JSC_useJIT=0 JavaScriptCore runs interpreter-only, a proxy
// for Safari with the JIT off (iOS Lockdown Mode). A proxy: different OS, CPU and runtime than a phone.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { cpus, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PAGE_VERSION, PHONE_PACKED_SHA256, packedFixture } from './build.ts';
import { runScan } from './scan.ts';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { engine: { type: 'string', default: 'crypto' }, count: { type: 'string', default: '1000' }, out: { type: 'string' } } });
const fixture = await packedFixture(join(await mkdtemp(join(tmpdir(), 'phone-bench-')), 'fx'));
if (fixture.packedSha256 !== PHONE_PACKED_SHA256) throw new Error('fixture differs from the pinned page fixture');
const count = Number(values.count);
const startedAt = new Date().toISOString();
const r = await runScan(fixture, values.engine!, count, 250);
const result = {
  kind: 'phone-bench-proxy', pageVersion: PAGE_VERSION, startedAt, host: hostname(), cpu: cpus()[0]?.model ?? null,
  runtime: `bun ${Bun.version}`, jit: process.env.BUN_JSC_useJIT === '0' ? 'off-jsc-useJIT=0' : 'on',
  engine: values.engine, count, chunk: 250, packedSha256: fixture.packedSha256,
  scanMs: Number(r.scanMs.toFixed(1)), msPerAnnouncement: Number((r.scanMs / count).toFixed(4)),
  matches: r.matches.length, expectedMatches: r.expected.length, verified: r.verified,
};
if (!r.verified) throw new Error('oracle check failed');
if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
