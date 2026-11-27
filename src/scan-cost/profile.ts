import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GCProfiler, type GCProfilerResult } from 'node:v8';
import { heapStats, profile, type SamplingProfileStackTraces } from 'bun:jsc';
import type { AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { z } from 'zod';
import { loadFixture } from '../shared/fixtures.ts';
import { SDK_COMMIT, SDK_VERSION } from '../shared/model.ts';
import { announcementIdentity, assertMatches, scanAnnouncements } from '../shared/worker.ts';

const integer = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    output: { type: 'string' },
    engine: { type: 'string', default: 'crypto' },
    'batch-size': { type: 'string', default: '0' },
    'scan-count': { type: 'string' },
    'interval-us': { type: 'string', default: '20000' },
    'native-seconds': { type: 'string', default: '10' },
  },
});
const options = {
  fixture: resolve(z.string().min(1).parse(values.fixture)),
  output: resolve(z.string().min(1).parse(values.output)),
  engine: z.enum(['crypto', 'sdk']).parse(values.engine),
  batchSize: integer.parse(values['batch-size']),
  scanCount: values['scan-count'] === undefined ? undefined : integer.min(1).parse(values['scan-count']),
  intervalUs: integer.min(1000).parse(values['interval-us']),
  nativeSeconds: integer.parse(values['native-seconds']),
};

function hostSnapshot() {
  const commands: Record<string, string[]> = process.platform === 'darwin' ? {
    vm: ['/usr/bin/vm_stat'],
    pressure: ['/usr/bin/memory_pressure', '-Q'],
    swap: ['/usr/sbin/sysctl', 'vm.swapusage'],
    thermal: ['/usr/bin/pmset', '-g', 'therm'],
  } : {
    memory: ['/bin/cat', '/proc/meminfo'],
    vm: ['/bin/cat', '/proc/vmstat'],
    memoryPressure: ['/bin/cat', '/proc/pressure/memory'],
    cpuPressure: ['/bin/cat', '/proc/pressure/cpu'],
    swap: ['/bin/cat', '/proc/swaps'],
    load: ['/bin/cat', '/proc/loadavg'],
    process: ['/bin/cat', `/proc/${process.pid}/status`],
  };
  const snapshots = Object.fromEntries(Object.entries(commands).map(([name, command]) => {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      throw new Error(`${name} snapshot failed: ${result.stderr.toString()}`);
    }
    return [name, result.stdout.toString()];
  }));
  if (process.platform === 'linux') {
    for (const directory of ['/sys/class/thermal', '/sys/devices/system/cpu/cpufreq']) {
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (!name.startsWith('thermal_zone') && !name.startsWith('policy')) continue;
        for (const field of ['type', 'temp', 'scaling_governor', 'scaling_cur_freq', 'scaling_max_freq', 'affected_cpus']) {
          const file = `${directory}/${name}/${field}`;
          if (existsSync(file)) snapshots[file] = readFileSync(file, 'utf8');
        }
      }
    }
  }
  return snapshots;
}

function snapshot() {
  return { epochMs: Date.now(), monotonicMs: performance.now(), memory: process.memoryUsage(), resources: process.resourceUsage() };
}

function chromeProfile(stacks: SamplingProfileStackTraces) {
  type Node = {
    id: number;
    callFrame: { functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number };
    hitCount: number;
    children: number[];
  };
  const root: Node = { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [] };
  const nodes: Node[] = [root];
  const edges = new Map<string, Node>();
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  const collapsed = new Map<string, number>();
  const self = new Map<string, number>();
  const firstTime = stacks.traces[0]?.timestamp ?? 0;
  let previous = firstTime;
  for (const trace of stacks.traces) {
    let parent = root;
    const names: string[] = [];
    for (let index = trace.frames.length - 1; index >= 0; index -= 1) {
      const frame = trace.frames[index];
      if (!frame) throw new Error('Missing profiler frame');
      const name = `${frame.name || '(anonymous)'} [${frame.sourceURL ?? 'native'}:${frame.line}]`;
      names.push(name.replaceAll(';', ':').replaceAll('\n', ' '));
      const key = JSON.stringify([parent.id, name, frame.column]);
      let node = edges.get(key);
      if (!node) {
        node = {
          id: nodes.length + 1,
          callFrame: {
            functionName: frame.name || '(anonymous)',
            scriptId: String(frame.sourceID),
            url: frame.sourceURL ?? '',
            lineNumber: frame.line === 4294967295 ? -1 : frame.line - 1,
            columnNumber: frame.column === 4294967295 ? -1 : frame.column - 1,
          },
          hitCount: 0,
          children: [],
        };
        parent.children.push(node.id);
        nodes.push(node);
        edges.set(key, node);
      }
      parent = node;
    }
    parent.hitCount += 1;
    samples.push(parent.id);
    timeDeltas.push(Math.max(0, Math.round((trace.timestamp - previous) * 1e6)));
    previous = trace.timestamp;
    const stack = names.join(';') || '(empty stack)';
    collapsed.set(stack, (collapsed.get(stack) ?? 0) + 1);
    const leaf = names.at(-1) ?? '(empty stack)';
    self.set(leaf, (self.get(leaf) ?? 0) + 1);
  }
  return {
    chrome: { nodes, startTime: firstTime * 1e6, endTime: previous * 1e6, samples, timeDeltas },
    collapsed: [...collapsed].map(([stack, count]) => `${stack} ${count}`).join('\n') + '\n',
    topSelf: [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([frame, samples]) => ({ frame, samples, sampleSharePct: samples * 100 / stacks.traces.length })),
  };
}

async function main() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('This profiling driver supports macOS and Linux');
  }
  if (process.platform === 'linux' && options.nativeSeconds > 0) {
    throw new Error('Native sample capture is macOS-only; pass --native-seconds 0 on Linux');
  }
  await mkdir(options.output);
  const phases: Record<string, unknown> = {};
  const vm = Bun.spawn(process.platform === 'darwin' ? ['/usr/bin/vm_stat', '1'] : ['/usr/bin/vmstat', '-w', '1'], {
    stdout: Bun.file(`${options.output}/vm-stat.log`),
    stderr: Bun.file(`${options.output}/vm-stat.stderr.log`),
  });
  let native: Pick<Bun.Subprocess, 'exited' | 'exitCode' | 'kill'> | undefined;
  try {
    phases.beforeLoad = { ...snapshot(), host: hostSnapshot() };
    Bun.gc(true);
    const loaded = await loadFixture(options.fixture);
    const scanCount = options.scanCount ?? loaded.announcements.length;
    if (scanCount > loaded.announcements.length) throw new Error('scan-count exceeds fixture length');
    const input = scanCount === loaded.announcements.length ? loaded.announcements : loaded.announcements.slice(0, scanCount);
    const expected = loaded.manifest.expectedIndices.filter(index => index < scanCount).map(index => {
      const log = input[index];
      if (!log) throw new Error(`Missing expected announcement ${index}`);
      return announcementIdentity(log);
    });
    const inputHash = createHash('sha256');
    for (const log of input) {
      inputHash.update(JSON.stringify([announcementIdentity(log), log.ephemeralPubKey, log.metadata, log.stealthAddress, String(log.schemeId)]));
      inputHash.update('\n');
    }
    const scanInputSha256 = inputHash.digest('hex');
    Bun.gc(true);
    phases.beforeScan = { ...snapshot(), host: hostSnapshot(), heap: heapStats() };
    await writeFile(`${options.output}/phases.json`, JSON.stringify(phases, null, 2));
    if (options.nativeSeconds > 0) {
      native = Bun.spawn(['/usr/bin/sample', String(process.pid), String(options.nativeSeconds), '10', '-file', `${options.output}/native-sample.txt`], {
        stdout: Bun.file(`${options.output}/native-sample.stdout.log`),
        stderr: Bun.file(`${options.output}/native-sample.stderr.log`),
      });
    }
    const gcProfiler = new GCProfiler();
    let actual: AnnouncementLog[] | undefined;
    let gc: GCProfilerResult | undefined;
    let scanMs = 0;
    let cpu = { user: 0, system: 0 };
    let resourcesBefore: NodeJS.ResourceUsage | undefined;
    let resourcesAfter: NodeJS.ResourceUsage | undefined;
    const sampled = await profile(async () => {
      gcProfiler.start();
      resourcesBefore = process.resourceUsage();
      const cpuBefore = process.cpuUsage();
      const start = performance.now();
      actual = await scanAnnouncements(input, loaded.manifest.recipient, options.engine, options.batchSize);
      scanMs = performance.now() - start;
      cpu = process.cpuUsage(cpuBefore);
      resourcesAfter = process.resourceUsage();
      phases.scanEnd = snapshot();
      gc = gcProfiler.stop();
    }, options.intervalUs);
    if (!actual || !gc || !resourcesBefore || !resourcesAfter) throw new Error('Profiler did not complete the measured scan');
    assertMatches(actual, expected);
    phases.afterScan = { ...snapshot(), host: hostSnapshot(), heap: heapStats() };
    const nativeExit = native ? await native.exited : null;
    if (nativeExit !== null && nativeExit !== 0) throw new Error(`Native sampler exited ${nativeExit}; see native-sample.stderr.log`);
    const sourceHashes: Record<string, string> = {};
    for (const file of ['bun.lock', 'src/scan-cost/profile.ts', 'src/shared/worker.ts', 'src/shared/fixtures.ts']) {
      sourceHashes[file] = createHash('sha256').update(await readFile(new URL(`../../${file}`, import.meta.url))).digest('hex');
    }
    const report = chromeProfile(sampled.stackTraces);
    const gcTypes: Record<string, number> = {};
    for (const entry of gc.statistics) gcTypes[entry.gcType] = (gcTypes[entry.gcType] ?? 0) + 1;
    const gcCostRawSum = gc.statistics.reduce((sum, entry) => sum + entry.cost, 0);
    const result = {
      schemaVersion: 1,
      options,
      sdkVersion: SDK_VERSION,
      sdkCommit: SDK_COMMIT,
      fixtureSha256: loaded.manifest.fixtureSha256,
      scanInputSha256,
      retainedAnnouncements: loaded.announcements.length,
      scannedAnnouncements: input.length,
      matches: actual.length,
      scanMs,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      resourcesBefore,
      resourcesAfter,
      gc: { events: gc.statistics.length, costRawSum: gcCostRawSum, types: gcTypes },
      profiler: { intervalSeconds: sampled.stackTraces.interval, samples: sampled.stackTraces.traces.length, topSelf: report.topSelf },
      environment: { bun: Bun.version, nodeCompatibility: process.versions.node, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem(), sourceHashes },
      phases,
      verified: true,
    };
    await Promise.all([
      writeFile(`${options.output}/result.json`, JSON.stringify(result, null, 2)),
      writeFile(`${options.output}/phases.json`, JSON.stringify(phases, null, 2)),
      writeFile(`${options.output}/gc.json`, JSON.stringify(gc, null, 2)),
      writeFile(`${options.output}/functions.txt`, sampled.functions),
      writeFile(`${options.output}/bytecodes.txt`, sampled.bytecodes),
      writeFile(`${options.output}/stacks.json`, JSON.stringify(sampled.stackTraces)),
      writeFile(`${options.output}/scan.cpuprofile`, JSON.stringify(report.chrome)),
      writeFile(`${options.output}/scan.collapsed`, report.collapsed),
    ]);
    console.log(JSON.stringify({ output: options.output, retained: result.retainedAnnouncements, scanned: result.scannedAnnouncements, scanMs, cpuMs: result.cpuUserMs + result.cpuSystemMs, gcEvents: result.gc.events, gcCostRawSum, profilerSamples: result.profiler.samples, verified: true }));
  } finally {
    vm.kill();
    await vm.exited;
    if (native && native.exitCode === null) {
      native.kill();
      await native.exited;
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
