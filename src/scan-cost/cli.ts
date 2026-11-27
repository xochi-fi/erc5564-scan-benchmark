import { parseArgs } from 'node:util';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { generateFixture } from '../shared/fixtures.ts';
import { SDK_COMMIT, SDK_VERSION, type Engine, type WorkerOptions } from '../shared/model.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const integer = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeInteger = integer.or(z.coerce.number().refine(value => value === 0));

const help = `Deterministic ERC-5564 local scan benchmark

Usage: bun run bench [options]

  --sizes 10000              Comma-separated announcement counts
  --cases zero,sparse        Generate no-match and/or sparse-match fixtures
  --match-every 1000          Sparse fixture matches indices 0, 1000, ...
  --engines sdk,crypto       Public SDK wrapper and/or crypto-only loop
  --modes full,incremental   Whole array and/or contiguous batches
  --batch-size 1000          Incremental batch size
  --repetitions 3            Fresh process per engine/mode/repetition
  --warmup 0                 Untimed warmup announcements per process
  --seed erc5564-scan-v1      Public test-only fixture seed
  --output PATH              New output directory; never overwrites a run
  --help                     Show this help

Full workload: bun run bench --sizes 10000,100000,1000000
Smoke run:    bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1

No RPC is used. Fixture generation, loading, decoding, setup GC, warmup and result
verification are outside the scan timer. Memory peak is process-lifetime RSS.
`;

function choices<T extends string>(value: string, allowed: readonly T[], name: string): T[] {
  const selected = value.split(',').map(item => item.trim());
  return [...new Set(selected.map(item => {
    const match = allowed.find(candidate => candidate === item);
    if (match === undefined) throw new Error(`Invalid ${name}: ${item}; expected ${allowed.join(',')}`);
    return match;
  }))];
}

function parseOptions() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      sizes: { type: 'string', default: '10000' },
      cases: { type: 'string', default: 'zero,sparse' },
      'match-every': { type: 'string', default: '1000' },
      engines: { type: 'string', default: 'sdk,crypto' },
      modes: { type: 'string', default: 'full,incremental' },
      'batch-size': { type: 'string', default: '1000' },
      repetitions: { type: 'string', default: '3' },
      warmup: { type: 'string', default: '0' },
      seed: { type: 'string', default: 'erc5564-scan-v1' },
      output: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return null;
  return {
    sizes: [...new Set(values.sizes.split(',').map(value => integer.parse(value.trim())))],
    cases: choices(values.cases, ['zero', 'sparse'], 'cases'),
    matchEvery: integer.parse(values['match-every']),
    engines: choices<Engine>(values.engines, ['sdk', 'crypto'], 'engines'),
    modes: choices(values.modes, ['full', 'incremental'], 'modes'),
    batchSize: integer.parse(values['batch-size']),
    repetitions: integer.parse(values.repetitions),
    warmupCount: nonnegativeInteger.parse(values.warmup),
    seed: z.string().min(1).parse(values.seed),
    output: resolve(values.output ?? join(root, 'results', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`)),
  };
}

const sampleSchema = z.object({
  schemaVersion: z.literal(1),
  sdkVersion: z.literal(SDK_VERSION),
  sdkCommit: z.literal(SDK_COMMIT),
  fixtureSha256: z.string().regex(/^[0-9a-f]{64}$/),
  engine: z.enum(['sdk', 'crypto']),
  mode: z.enum(['full', 'incremental']),
  count: integer,
  matchEvery: nonnegativeInteger,
  matches: nonnegativeInteger,
  repetition: integer,
  scanMs: z.number().finite().positive(),
  announcementsPerSecond: z.number().finite().positive(),
  processLifetimePeakRssBytes: z.number().finite().nonnegative(),
  verified: z.literal(true),
}).passthrough();
type Sample = z.infer<typeof sampleSchema>;

async function launchWorker(options: WorkerOptions): Promise<Sample> {
  const child = Bun.spawn([process.execPath, join(root, 'src', 'shared', 'worker.ts'), JSON.stringify(options)], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Scan worker failed (${options.engine}, batch=${options.batchSize}, repetition=${options.repetition}, exit=${exitCode}):\n${stderr || stdout}`);
  }
  if (stderr) process.stderr.write(stderr);
  return sampleSchema.parse(JSON.parse(stdout));
}

function summarize(samples: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.count, sample.matchEvery, sample.engine, sample.mode]);
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  return [...groups.values()].map(group => {
    const first = group[0];
    if (!first) throw new Error('Cannot summarize an empty sample group');
    const times = group.map(sample => sample.scanMs).sort((a, b) => a - b);
    const lower = times[Math.floor((times.length - 1) / 2)];
    const upper = times[Math.floor(times.length / 2)];
    if (lower === undefined || upper === undefined) throw new Error('Missing timing sample');
    const median = (lower + upper) / 2;
    return {
      count: first.count,
      case: first.matchEvery === 0 ? 'zero' : 'sparse',
      engine: first.engine,
      mode: first.mode,
      matches: first.matches,
      samples: group.length,
      medianMs: Number(median.toFixed(3)),
      minMs: Number(Math.min(...times).toFixed(3)),
      maxMs: Number(Math.max(...times).toFixed(3)),
      announcementsPerSecondAtMedian: Math.round(first.count * 1000 / median),
      maxProcessLifetimeRssMiB: Number((Math.max(...group.map(sample => sample.processLifetimePeakRssBytes)) / 1024 ** 2).toFixed(2)),
    };
  });
}

async function main() {
  const options = parseOptions();
  if (!options) {
    process.stdout.write(help);
    return;
  }
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.output);
  await writeFile(join(options.output, 'run.json'), `${JSON.stringify({
    schemaVersion: 1,
    sdkVersion: SDK_VERSION,
    sdkCommit: SDK_COMMIT,
    startedAt: new Date().toISOString(),
    options,
  }, null, 2)}\n`);
  const samples: Sample[] = [];
  for (const count of options.sizes) {
    for (const fixtureCase of options.cases) {
      const fixtureDir = join(options.output, 'fixtures', `${count}-${fixtureCase}`);
      console.error(`Generating ${fixtureCase} fixture: ${count} announcements`);
      const manifest = await generateFixture(fixtureDir, {
        count,
        seed: options.seed,
        matchEvery: fixtureCase === 'zero' ? 0 : options.matchEvery,
      });
      for (const engine of options.engines) {
        for (const mode of options.modes) {
          for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
            console.error(`Scanning ${count} ${fixtureCase}: ${engine}/${mode} (${repetition}/${options.repetitions})`);
            const sample = await launchWorker({
              fixtureDir,
              engine,
              batchSize: mode === 'full' ? 0 : options.batchSize,
              warmupCount: options.warmupCount,
              repetition,
            });
            if (sample.count !== count || sample.matchEvery !== manifest.matchEvery
              || sample.engine !== engine || sample.mode !== mode
              || sample.repetition !== repetition || sample.fixtureSha256 !== manifest.fixtureSha256
              || sample.matches !== manifest.expectedIndices.length) {
              throw new Error('Worker result does not match the requested fixture and scenario');
            }
            samples.push(sample);
            await appendFile(join(options.output, 'samples.jsonl'), `${JSON.stringify(sample)}\n`);
          }
        }
      }
    }
  }
  const summary = summarize(samples);
  await writeFile(join(options.output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.table(summary.map(row => ({
    count: row.count,
    case: row.case,
    engine: row.engine,
    mode: row.mode,
    matches: row.matches,
    runs: row.samples,
    'median ms': row.medianMs,
    'peak RSS MiB': row.maxProcessLifetimeRssMiB,
  })));
  console.log(`Verified ${samples.length} isolated samples. Results: ${options.output}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
