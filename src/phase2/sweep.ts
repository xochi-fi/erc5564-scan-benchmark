import { createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { freemem, hostname, loadavg, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { SDK_COMMIT, SDK_VERSION, type Engine } from '../model.ts';
import { FIRST_BLOCK, readManifest, ENTRIES_PER_BLOCK } from './chain.ts';
import { buildPlan, readMatrix, type PlannedSample, type Setting } from './repeat.ts';
import {
  LINK_PROFILES,
  LINK_PROFILE_NAMES,
  type ChainEndpoints,
  type ExpectedFile,
  type LinkProfileName,
  type WalletOptions,
  type WalletSample,
} from './model.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

const help = `Phase 2: paged wallet discovery against a local deterministic JSON-RPC chain

Usage: bun run phase2 --fixtures DIR[,DIR] --output DIR [options]

  --fixtures DIRS            Existing phase-1 fixture directories (manifest.json + announcements.jsonl)
  --matrix FILE              JSON {entries: [{fixture, profiles, scenarios, pages}]}; replaces
                             --fixtures/--pages/--size-pages/--profiles/--scenarios
  --fixtures-root DIR        Directory that relative matrix fixture names resolve against
  --pages 1,4,16,64,256      Blocks per eth_getLogs page (128 announcements per block)
  --size-pages N=P:P:P       Override pages for fixtures of N announcements (repeatable, comma-separated)
  --profiles none,lan,public Link profiles (latency/bandwidth) for the emulated RPC link
  --scenarios cold,catchup   cold = clear cache then full rescan; catchup = synced to head-M, catch up M blocks
  --catchup-blocks 64        M, blocks to catch up
  --prefix-pages 64          Page size of the untimed-in-summary prefix sync that builds the catch-up cache
  --engine sdk               Scan engine reused from phase 1 (sdk|crypto)
  --repetitions 1            Fresh wallet process per sample
  --first-repetition 1       Number of the first repetition (lets several hosts split one set of reps)
  --order grouped|shuffled   grouped = original order; shuffled = each repetition is a seeded permutation
  --seed TEXT                Seed for --order shuffled (default phase2-repeat-v1)
  --cooldown-c C             Linux: before each sample, wait until every thermal zone is below C
  --cooldown-max-s 600       Stop waiting after this many seconds (the wait is recorded either way)
  --monitor-ms 2000          Poll thermal/frequency/throttle/swap state this often while a sample runs
  --control-fixture DIR      Phase-1 fixture for unprofiled crypto controls before and after the sweep
  --wallet-cpus LIST         Linux only: taskset CPU list for wallet and control processes
  --chain-cpus LIST          Linux only: taskset CPU list for the chain/link process
  --control-cpus LIST        Linux only: taskset CPU list for controls (default: wallet CPUs)
  --output DIR               New output directory
`;

const integerList = (value: string): number[] =>
  [...new Set(value.split(',').map(item => z.coerce.number().int().min(1).parse(item.trim())))];

function parseOptions() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      fixtures: { type: 'string' },
      pages: { type: 'string', default: '1,4,16,64,256' },
      'size-pages': { type: 'string', default: '' },
      profiles: { type: 'string', default: 'none,lan,public' },
      scenarios: { type: 'string', default: 'cold,catchup' },
      'catchup-blocks': { type: 'string', default: '64' },
      'prefix-pages': { type: 'string', default: '64' },
      engine: { type: 'string', default: 'sdk' },
      repetitions: { type: 'string', default: '1' },
      'first-repetition': { type: 'string', default: '1' },
      order: { type: 'string', default: 'grouped' },
      seed: { type: 'string', default: 'phase2-repeat-v1' },
      matrix: { type: 'string' },
      'fixtures-root': { type: 'string' },
      'cooldown-c': { type: 'string' },
      'cooldown-max-s': { type: 'string', default: '600' },
      'monitor-ms': { type: 'string', default: '2000' },
      'control-fixture': { type: 'string' },
      'wallet-cpus': { type: 'string' },
      'chain-cpus': { type: 'string' },
      'control-cpus': { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return null;
  if (values.output === undefined) throw new Error('--output is required');
  if ((values.fixtures === undefined) === (values.matrix === undefined)) throw new Error('give exactly one of --fixtures or --matrix');
  const sizePages = new Map<number, number[]>();
  for (const entry of values['size-pages'].split(',').filter(Boolean)) {
    const [size, pages] = entry.split('=');
    if (size === undefined || pages === undefined) throw new Error(`invalid --size-pages entry ${entry}`);
    sizePages.set(z.coerce.number().int().parse(size), integerList(pages.replaceAll(':', ',')));
  }
  const profiles = values.profiles.split(',').map((name) => {
    if (!LINK_PROFILE_NAMES.includes(name as LinkProfileName)) throw new Error(`unknown profile ${name}`);
    return name as LinkProfileName;
  });
  const scenarios = values.scenarios.split(',').map(s => z.enum(['cold', 'catchup']).parse(s));
  return {
    fixtures: values.fixtures === undefined ? [] : values.fixtures.split(',').map(path => resolve(path)),
    matrix: values.matrix === undefined ? null : resolve(values.matrix),
    fixturesRoot: resolve(values['fixtures-root'] ?? '.'),
    pages: integerList(values.pages),
    sizePages,
    profiles,
    scenarios,
    catchupBlocks: z.coerce.number().int().min(1).parse(values['catchup-blocks']),
    prefixPages: z.coerce.number().int().min(1).parse(values['prefix-pages']),
    engine: z.enum(['sdk', 'crypto']).parse(values.engine) as Engine,
    repetitions: z.coerce.number().int().min(1).parse(values.repetitions),
    firstRepetition: z.coerce.number().int().min(1).parse(values['first-repetition']),
    order: z.enum(['grouped', 'shuffled']).parse(values.order),
    seed: values.seed,
    cooldownC: values['cooldown-c'] === undefined ? null : z.coerce.number().positive().parse(values['cooldown-c']),
    cooldownMaxS: z.coerce.number().nonnegative().parse(values['cooldown-max-s']),
    monitorMs: z.coerce.number().int().min(100).parse(values['monitor-ms']),
    controlFixture: values['control-fixture'] === undefined ? null : resolve(values['control-fixture']),
    walletCpus: values['wallet-cpus'] ?? null,
    chainCpus: values['chain-cpus'] ?? null,
    controlCpus: values['control-cpus'] ?? values['wallet-cpus'] ?? null,
    output: resolve(values.output),
  };
}
type Options = NonNullable<ReturnType<typeof parseOptions>>;

function pinned(command: string[], cpus: string | null): string[] {
  return cpus !== null && process.platform === 'linux' ? ['taskset', '-c', cpus, ...command] : command;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')) return null;
    throw error;
  }
}

/** Linux thermal cooling devices as cur/max; a non-zero thermal-cpufreq state means thermal throttling. */
async function coolingStates(): Promise<Record<string, string>> {
  const states: Record<string, string> = {};
  for (let device = 0; device < 32; device += 1) {
    const cur = await readText(`/sys/class/thermal/cooling_device${device}/cur_state`);
    if (cur === null) continue;
    const type = (await readText(`/sys/class/thermal/cooling_device${device}/type`))?.trim() ?? `device${device}`;
    const max = (await readText(`/sys/class/thermal/cooling_device${device}/max_state`))?.trim() ?? '?';
    states[`${device}:${type}`] = `${cur.trim()}/${max}`;
  }
  return states;
}

async function thermalReadings(): Promise<number[]> {
  const temps: number[] = [];
  for (let zone = 0; zone < 32; zone += 1) {
    const temp = await readText(`/sys/class/thermal/thermal_zone${zone}/temp`);
    if (temp !== null) temps.push(Number(temp.trim()) / 1000);
  }
  return temps;
}

async function swapPages(): Promise<number | null> {
  const vmstat = await readText('/proc/vmstat');
  if (vmstat === null) return null;
  return Number(/^pswpin (\d+)/m.exec(vmstat)?.[1] ?? NaN) + Number(/^pswpout (\d+)/m.exec(vmstat)?.[1] ?? NaN);
}

export interface HostMonitor {
  polls: number;
  maxThermalC: number | null;
  /** Minimum observed scaling_cur_freq per CPU, MHz. */
  minCpuMHz: Record<string, number>;
  /** Highest cur_state seen per cooling device (thermal throttling when > 0). */
  maxCoolingState: Record<string, number>;
  /** Highest memory PSI "some avg10" seen. */
  maxMemoryPsiSomeAvg10: number | null;
  /** Swap pages moved (pswpin + pswpout) during the sample, and the peak rate over one poll interval. */
  swapPagesInOut: number | null;
  maxSwapPagesPerS: number | null;
}

/** Polls thermal, frequency, cooling, memory-pressure and swap counters while a sample runs (Linux only). */
function startHostMonitor(intervalMs: number): { stop(): Promise<HostMonitor> } {
  const result: HostMonitor = {
    polls: 0, maxThermalC: null, minCpuMHz: {}, maxCoolingState: {}, maxMemoryPsiSomeAvg10: null, swapPagesInOut: null, maxSwapPagesPerS: null,
  };
  if (process.platform !== 'linux') return { stop: async () => result };
  let firstPages: number | null = null;
  let previous: { at: number; pages: number } | null = null;
  const poll = async (): Promise<void> => {
    for (const t of await thermalReadings()) result.maxThermalC = Math.max(result.maxThermalC ?? t, t);
    for (let cpu = 0; cpu < 32; cpu += 1) {
      const freq = await readText(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`);
      if (freq === null) continue;
      const mhz = Number(freq.trim()) / 1000;
      result.minCpuMHz[String(cpu)] = Math.min(result.minCpuMHz[String(cpu)] ?? mhz, mhz);
    }
    for (const [device, state] of Object.entries(await coolingStates())) {
      const cur = Number(state.split('/')[0]);
      result.maxCoolingState[device] = Math.max(result.maxCoolingState[device] ?? cur, cur);
    }
    const psi = await readText('/proc/pressure/memory');
    const avg10 = psi === null ? NaN : Number(/^some avg10=([\d.]+)/m.exec(psi)?.[1] ?? NaN);
    if (Number.isFinite(avg10)) result.maxMemoryPsiSomeAvg10 = Math.max(result.maxMemoryPsiSomeAvg10 ?? avg10, avg10);
    const pages = await swapPages();
    if (pages !== null && Number.isFinite(pages)) {
      firstPages ??= pages;
      result.swapPagesInOut = pages - firstPages;
      const now = Date.now();
      if (previous !== null && now > previous.at) {
        const rate = ((pages - previous.pages) * 1000) / (now - previous.at);
        result.maxSwapPagesPerS = Number(Math.max(result.maxSwapPagesPerS ?? rate, rate).toFixed(1));
      }
      previous = { at: now, pages };
    }
    result.polls += 1;
  };
  const logFailure = (error: unknown): void => console.error('host monitor poll failed', error);
  let busy: Promise<void> = poll().catch(logFailure);
  const timer = setInterval(() => {
    busy = busy.then(poll).catch(logFailure);
  }, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await busy;
      await poll().catch(logFailure);
      return result;
    },
  };
}

/** Waits until every thermal zone is below limitC (or maxS elapses) and reports the wait. */
async function coolDown(limitC: number | null, maxS: number): Promise<Record<string, unknown> | null> {
  if (limitC === null || process.platform !== 'linux') return null;
  const started = Date.now();
  let temps = await thermalReadings();
  if (temps.length === 0) return { limitC, note: 'no thermal zones' };
  const startMaxC = Math.max(...temps);
  while (Math.max(...temps) >= limitC && Date.now() - started < maxS * 1000) {
    await Bun.sleep(5000);
    temps = await thermalReadings();
  }
  const endMaxC = Math.max(...temps);
  const waitedS = Number(((Date.now() - started) / 1000).toFixed(1));
  if (waitedS > 0.5) console.error(`  cooldown ${startMaxC} C -> ${endMaxC} C in ${waitedS}s (limit ${limitC} C)`);
  return { limitC, startMaxC, endMaxC, waitedS, reachedLimit: endMaxC < limitC };
}

/** Host state: load, memory/swap and thermal counters where the OS exposes them. */
export async function hostState(): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {
    at: new Date().toISOString(),
    hostname: hostname(),
    loadavg: loadavg(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  };
  if (process.platform === 'linux') {
    const meminfo = await readText('/proc/meminfo');
    if (meminfo !== null) {
      const field = (name: string): number | null => {
        const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(meminfo);
        return match?.[1] === undefined ? null : Number(match[1]) * 1024;
      };
      state.memAvailableBytes = field('MemAvailable');
      state.swapTotalBytes = field('SwapTotal');
      state.swapFreeBytes = field('SwapFree');
    }
    const vmstat = await readText('/proc/vmstat');
    if (vmstat !== null) {
      state.pswpin = Number(/^pswpin (\d+)/m.exec(vmstat)?.[1] ?? NaN);
      state.pswpout = Number(/^pswpout (\d+)/m.exec(vmstat)?.[1] ?? NaN);
    }
    const thermal: Record<string, number> = {};
    for (let zone = 0; zone < 32; zone += 1) {
      const temp = await readText(`/sys/class/thermal/thermal_zone${zone}/temp`);
      if (temp === null) continue;
      const type = (await readText(`/sys/class/thermal/thermal_zone${zone}/type`))?.trim() ?? `zone${zone}`;
      thermal[`${zone}:${type}`] = Number(temp.trim()) / 1000;
    }
    state.thermalC = thermal;
    const freqs: Record<string, number> = {};
    for (let cpu = 0; cpu < 32; cpu += 1) {
      const freq = await readText(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`);
      if (freq !== null) freqs[String(cpu)] = Number(freq.trim()) / 1000;
    }
    state.cpuMHz = freqs;
    const maxFreqs: Record<string, number> = {};
    for (let cpu = 0; cpu < 32; cpu += 1) {
      const freq = await readText(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_max_freq`);
      if (freq !== null) maxFreqs[String(cpu)] = Number(freq.trim()) / 1000;
    }
    state.cpuMaxMHz = maxFreqs;
    state.coolingState = await coolingStates();
    const pressure = await readText('/proc/pressure/memory');
    if (pressure !== null) state.memoryPressure = pressure.trim();
  } else if (process.platform === 'darwin') {
    const swap = Bun.spawnSync(['sysctl', '-n', 'vm.swapusage']);
    state.swapUsage = swap.stdout.toString().trim();
  }
  return state;
}

/**
 * Expected identities taken straight from the fixture file at the manifest's
 * sender-side destination schedule: independent of the server and the wallet.
 */
export async function expectedIdentities(fixtureDir: string): Promise<ExpectedFile> {
  const manifest = await readManifest(fixtureDir);
  const wanted = new Set(manifest.expectedIndices);
  const matches: ExpectedFile['matches'] = [];
  let pending = '';
  let line = 0;
  for await (const chunk of createReadStream(join(fixtureDir, 'announcements.jsonl'), { encoding: 'utf8' })) {
    pending += chunk;
    let start = 0;
    for (let end = pending.indexOf('\n', start); end !== -1; end = pending.indexOf('\n', start)) {
      if (wanted.has(line)) {
        const row = z.object({ blockHash: z.string(), transactionHash: z.string(), logIndex: z.string(), blockNumber: z.string() })
          .passthrough().parse(JSON.parse(pending.slice(start, end)));
        matches.push({
          identity: JSON.stringify([row.blockHash, row.transactionHash, Number(BigInt(row.logIndex))]),
          blockNumber: Number(BigInt(row.blockNumber)),
        });
      }
      line += 1;
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (matches.length !== manifest.expectedIndices.length) throw new Error(`${fixtureDir}: could not read every expected index`);
  return { fixtureSha256: manifest.fixtureSha256, matches };
}

interface ChainProcess {
  endpoints: ChainEndpoints;
  stop(): Promise<void>;
}

async function startChainProcess(fixtureDir: string, profile: LinkProfileName, cpus: string | null): Promise<ChainProcess> {
  const child = Bun.spawn(pinned([process.execPath, join(root, 'src', 'phase2', 'chain-server.ts'),
    JSON.stringify({ fixtureDir, profile: LINK_PROFILES[profile] })], cpus), {
    cwd: root,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`chain server exited before reporting endpoints (exit ${await child.exited})`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const endpoints = JSON.parse(text.slice(0, text.indexOf('\n'))) as ChainEndpoints;
  return {
    endpoints,
    async stop() {
      child.kill('SIGTERM');
      const code = await child.exited;
      if (code !== 0 && code !== 143) throw new Error(`chain server exited with ${code}`);
    },
  };
}

async function setHead(controlUrl: string, head: number | null): Promise<void> {
  const response = await fetch(new URL('head', controlUrl), { method: 'POST', body: JSON.stringify({ head }) });
  if (!response.ok) throw new Error(`set head: HTTP ${response.status} ${await response.text()}`);
}

async function runChild(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${basename(command.find(part => part.endsWith('.ts')) ?? 'child')} failed (exit ${code}):\n${stderr || stdout}`);
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

async function runWalletProcess(options: WalletOptions, cpus: string | null): Promise<WalletSample> {
  const stdout = await runChild(pinned([process.execPath, join(root, 'src', 'phase2', 'wallet.ts'), JSON.stringify(options)], cpus));
  const sample = JSON.parse(stdout) as WalletSample;
  if (sample.verified !== true || sample.scenario !== options.scenario || sample.pageBlocks !== options.pageBlocks) {
    throw new Error('wallet sample does not match the requested scenario');
  }
  return sample;
}

async function runControl(fixtureDir: string, cpus: string | null, label: string, opts: Options): Promise<Record<string, unknown>> {
  const options = { fixtureDir, engine: 'crypto', batchSize: 0, warmupCount: 0, repetition: 1 };
  const cooldown = await coolDown(opts.cooldownC, opts.cooldownMaxS);
  const hostBefore = await hostState();
  const monitor = startHostMonitor(opts.monitorMs);
  const stdout = await runChild(pinned([process.execPath, join(root, 'src', 'worker.ts'), JSON.stringify(options)], cpus));
  const hostMonitor = await monitor.stop();
  const sample = JSON.parse(stdout) as Record<string, unknown>;
  return { label, cooldown, hostBefore, hostMonitor, hostAfter: await hostState(), ...sample };
}

export interface SummaryRow {
  count: number;
  scenario: string;
  profile: string;
  pageBlocks: number;
  engine: string;
  repetition: number;
  blocks: number;
  announcements: number;
  matches: number;
  requests: number;
  networkS: number;
  decodeS: number;
  scanS: number;
  verifyS: number;
  verifyNetworkS: number;
  otherS: number;
  totalS: number;
  firstMatchS: number | null;
  pageFetchP50Ms: number | null;
  wireDownMiB: number;
  wireUpMiB: number;
  bodyMiB: number;
  peakRssMiB: number;
  chainRssMiB: number;
}

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));
const mib = (bytes: number): number => round(bytes / 1024 ** 2, 2);

export function summaryRow(sample: WalletSample): SummaryRow {
  const t = sample.timings;
  return {
    count: sample.count,
    scenario: sample.scenario,
    profile: sample.profile.name,
    pageBlocks: sample.pageBlocks,
    engine: sample.engine,
    repetition: sample.repetition,
    blocks: sample.blocksScanned,
    announcements: sample.announcementsScanned,
    matches: sample.newMatches,
    requests: sample.requests.getLogs + sample.requests.blockNumber + sample.requests.receipts + sample.requests.balances,
    networkS: round(t.networkMs / 1000),
    decodeS: round(t.decodeMs / 1000),
    scanS: round(t.scanMs / 1000),
    verifyS: round(t.verifyMs / 1000),
    verifyNetworkS: round(t.verifyNetworkMs / 1000),
    otherS: round((t.checkpointMs + t.otherMs) / 1000),
    totalS: round(t.totalMs / 1000),
    firstMatchS: t.firstVerifiedMs === null ? null : round(t.firstVerifiedMs / 1000),
    pageFetchP50Ms: t.pageFetchMsP50 === null ? null : round(t.pageFetchMsP50, 2),
    wireDownMiB: mib(sample.bytes.wireDownlink),
    wireUpMiB: mib(sample.bytes.wireUplink),
    bodyMiB: mib(sample.bytes.getLogsResponseBody + sample.bytes.getLogsRequestBody + sample.bytes.verifyRequestBody + sample.bytes.verifyResponseBody),
    peakRssMiB: mib(sample.processLifetimePeakRssBytes),
    chainRssMiB: mib(sample.chainRssBytes),
  };
}

export function toCsv(rows: SummaryRow[]): string {
  const first = rows[0];
  if (first === undefined) return '';
  const headers = Object.keys(first) as (keyof SummaryRow)[];
  const cell = (value: unknown): string => (value === null ? '' : String(value));
  return `${headers.join(',')}\n${rows.map(row => headers.map(h => cell(row[h])).join(',')).join('\n')}\n`;
}

async function main(): Promise<void> {
  const parsed = parseOptions();
  if (parsed === null) {
    process.stdout.write(help);
    return;
  }
  const options: Options = parsed;
  await mkdir(options.output, { recursive: false });
  const out = (name: string): string => join(options.output, name);
  await writeFile(out('run.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'phase2-paged-discovery',
    sdkVersion: SDK_VERSION,
    sdkCommit: SDK_COMMIT,
    bun: Bun.version,
    startedAt: new Date().toISOString(),
    options: { ...options, sizePages: Object.fromEntries(options.sizePages) },
    profiles: Object.fromEntries(options.profiles.map(name => [name, LINK_PROFILES[name]])),
    hostState: await hostState(),
  }, null, 2)}\n`);
  await mkdir(out('state'));
  const rows: SummaryRow[] = [];

  async function record(sample: WalletSample, extra: Record<string, unknown>): Promise<void> {
    const { pages, ...rest } = sample;
    await appendFile(out('samples.jsonl'), `${JSON.stringify({ ...rest, ...extra, hostAfter: await hostState() })}\n`);
    await appendFile(out('pages.jsonl'), `${JSON.stringify({ count: sample.count, scenario: sample.scenario, profile: sample.profile.name, pageBlocks: sample.pageBlocks, repetition: sample.repetition, pages })}\n`);
    const row = summaryRow(sample);
    rows.push(row);
    console.error(`  -> total ${row.totalS}s (net ${row.networkS}s, scan ${row.scanS}s, verify ${row.verifyS}s), first match ${row.firstMatchS}s, ${row.matches} matches`);
  }

  async function measure(sampleOptions: WalletOptions, planned: PlannedSample | null): Promise<void> {
    const cooldown = await coolDown(options.cooldownC, options.cooldownMaxS);
    const hostBefore = await hostState();
    const monitor = startHostMonitor(options.monitorMs);
    const sample = await runWalletProcess(sampleOptions, options.walletCpus);
    const hostMonitor = await monitor.stop();
    await record(sample, { order: planned?.order ?? null, cooldown, hostBefore, hostMonitor });
  }

  const settings: Setting[] = options.matrix === null ? [] : await readMatrix(options.matrix, options.fixturesRoot);
  if (options.matrix === null) {
    for (const fixtureDir of options.fixtures) {
      const count = (await readManifest(fixtureDir)).count;
      const pages = options.sizePages.get(count) ?? options.pages;
      for (const profile of options.profiles) {
        for (const pageBlocks of pages) {
          for (const scenario of (['catchup', 'cold'] as const).filter(s => options.scenarios.includes(s))) {
            settings.push({ fixtureDir, profile, scenario, pageBlocks });
          }
        }
      }
    }
  }
  const plan = buildPlan(settings, options);
  await writeFile(out('plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  console.error(`Plan: ${settings.length} settings x ${options.repetitions} repetitions = ${plan.length} samples (${options.order}, seed ${options.seed})`);

  interface FixtureState { count: number; expectedPath: string; cachePath: string; baseCachePath: string; baseCacheReady: boolean }
  const fixtures = new Map<string, FixtureState>();
  for (const fixtureDir of new Set(settings.map(s => s.fixtureDir))) {
    const manifest = await readManifest(fixtureDir);
    const tag = `${manifest.count}-${manifest.matchEvery}`;
    const expectedPath = out(`state/expected-${tag}.json`);
    await writeFile(expectedPath, JSON.stringify(await expectedIdentities(fixtureDir)));
    fixtures.set(fixtureDir, { count: manifest.count, expectedPath, cachePath: out(`state/cache-${tag}.json`), baseCachePath: out(`state/base-cache-${tag}.json`), baseCacheReady: false });
  }

  if (options.controlFixture !== null) {
    console.error(`Control before: crypto full scan of ${options.controlFixture}`);
    await appendFile(out('controls.jsonl'), `${JSON.stringify(await runControl(options.controlFixture, options.controlCpus, 'control_before', options))}\n`);
  }

  // One chain process per (fixture, profile): started on first use, stopped after its last planned sample.
  const chains = new Map<string, ChainProcess>();
  const chainKey = (s: Setting): string => `${s.fixtureDir}|${s.profile}`;
  const lastUse = new Map(plan.map(p => [chainKey(p), p.order]));
  async function chainFor(s: Setting): Promise<ChainProcess> {
    const existing = chains.get(chainKey(s));
    if (existing !== undefined) return existing;
    console.error(`Fixture ${basename(s.fixtureDir)}, profile ${s.profile}: indexing`);
    const chain = await startChainProcess(s.fixtureDir, s.profile, options.chainCpus);
    chains.set(chainKey(s), chain);
    return chain;
  }

  try {
    for (const planned of plan) {
      const chain = await chainFor(planned);
      const fixture = fixtures.get(planned.fixtureDir);
      if (fixture === undefined) throw new Error(`unplanned fixture ${planned.fixtureDir}`);
      const wallet = {
        rpcUrl: chain.endpoints.rpcUrl,
        controlUrl: chain.endpoints.controlUrl,
        fixtureDir: planned.fixtureDir,
        expectedPath: fixture.expectedPath,
        cachePath: fixture.cachePath,
        engine: options.engine,
        startBlock: FIRST_BLOCK,
        profile: LINK_PROFILES[planned.profile],
      } as const;
      const label = `[${planned.order + 1}/${plan.length}] ${fixture.count} ${planned.profile} page ${planned.pageBlocks} rep ${planned.repetition}`;
      if (planned.scenario === 'catchup') {
        if (!fixture.baseCacheReady) {
          // Prefix sync (recorded, excluded from summaries) that builds this fixture's shared catch-up starting cache.
          const prefixHead = chain.endpoints.lastBlock - options.catchupBlocks;
          if (prefixHead < FIRST_BLOCK) throw new Error(`fixture ${fixture.count} has fewer than ${options.catchupBlocks + 1} blocks`);
          console.error(`  prefix sync to block ${prefixHead} (${(prefixHead - FIRST_BLOCK + 1) * ENTRIES_PER_BLOCK} announcements), profile ${planned.profile}`);
          await setHead(chain.endpoints.controlUrl, prefixHead);
          try {
            await measure({ ...wallet, scenario: 'prefix', pageBlocks: options.prefixPages, repetition: 1 }, null);
          } finally {
            await setHead(chain.endpoints.controlUrl, null);
          }
          await copyFile(fixture.cachePath, fixture.baseCachePath);
          fixture.baseCacheReady = true;
        }
        console.error(`${label}: catchup ${options.catchupBlocks} blocks`);
        await copyFile(fixture.baseCachePath, fixture.cachePath);
      } else {
        // The wallet process deletes the scan cache left by the previous sample, then rescans from the birthday block.
        console.error(`${label}: cold rescan`);
      }
      await measure({ ...wallet, scenario: planned.scenario, pageBlocks: planned.pageBlocks, repetition: planned.repetition }, planned);
      if (lastUse.get(chainKey(planned)) === planned.order) {
        chains.delete(chainKey(planned));
        await chain.stop();
      }
    }
  } finally {
    for (const chain of chains.values()) await chain.stop();
  }

  if (options.controlFixture !== null) {
    console.error(`Control after: crypto full scan of ${options.controlFixture}`);
    await appendFile(out('controls.jsonl'), `${JSON.stringify(await runControl(options.controlFixture, options.controlCpus, 'control_after', options))}\n`);
  }
  await writeFile(out('summary.json'), `${JSON.stringify(rows, null, 2)}\n`);
  await writeFile(out('summary.csv'), toCsv(rows));
  console.table(rows.map(r => ({ n: r.count, sc: r.scenario, prof: r.profile, page: r.pageBlocks, net: r.networkS, scan: r.scanS, verify: r.verifyS, total: r.totalS, first: r.firstMatchS, MiB: r.wireDownMiB, rss: r.peakRssMiB })));
  console.error(`Verified ${rows.length} wallet samples. Results: ${options.output}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
