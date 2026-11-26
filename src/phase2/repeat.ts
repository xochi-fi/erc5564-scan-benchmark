/**
 * Repeat-run support for the phase-2 sweep: matrix files, a seeded
 * interleaved run order, and median/min/max summaries.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { LINK_PROFILE_NAMES, type LinkProfileName } from './model.ts';

export type Scenario = 'cold' | 'catchup';

/** One measured configuration: a fixture served behind one link profile, synced one way. */
export interface Setting {
  fixtureDir: string;
  profile: LinkProfileName;
  scenario: Scenario;
  pageBlocks: number;
}

export interface PlannedSample extends Setting {
  repetition: number;
  /** 0-based position in the whole run, recorded with the sample. */
  order: number;
}

const matrixEntrySchema = z.object({
  fixture: z.string().min(1),
  profiles: z.array(z.enum(LINK_PROFILE_NAMES as [LinkProfileName, ...LinkProfileName[]])).min(1),
  scenarios: z.array(z.enum(['cold', 'catchup'])).min(1),
  pages: z.array(z.number().int().min(1)).min(1),
}).strict();

export const matrixSchema = z.object({
  description: z.string().optional(),
  entries: z.array(matrixEntrySchema).min(1),
}).strict();
export type Matrix = z.infer<typeof matrixSchema>;

const settingKey = (s: Setting): string => `${s.fixtureDir}|${s.profile}|${s.scenario}|${s.pageBlocks}`;

/** Expands matrix entries into distinct settings; relative fixture names resolve against fixturesRoot. */
export function matrixSettings(matrix: Matrix, fixturesRoot: string): Setting[] {
  const seen = new Map<string, Setting>();
  for (const entry of matrix.entries) {
    const fixtureDir = isAbsolute(entry.fixture) ? entry.fixture : resolve(fixturesRoot, entry.fixture);
    for (const profile of entry.profiles) {
      for (const scenario of entry.scenarios) {
        for (const pageBlocks of entry.pages) {
          const setting = { fixtureDir, profile, scenario, pageBlocks };
          seen.set(settingKey(setting), setting);
        }
      }
    }
  }
  return [...seen.values()];
}

export async function readMatrix(path: string, fixturesRoot: string): Promise<Setting[]> {
  return matrixSettings(matrixSchema.parse(JSON.parse(await readFile(path, 'utf8'))), fixturesRoot);
}

/** mulberry32 seeded from a string (FNV-1a), so a run order is reproducible from its seed. */
export function seededRandom(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/**
 * grouped: every repetition of a setting group back to back (the original single-run order).
 * shuffled: repetition-major blocks, each a fresh seeded permutation of all settings, so slow
 * host drift spreads across settings instead of lining up with one of them.
 */
export function buildPlan(settings: readonly Setting[], options: {
  repetitions: number;
  firstRepetition: number;
  order: 'grouped' | 'shuffled';
  seed: string;
}): PlannedSample[] {
  const reps = Array.from({ length: options.repetitions }, (_, i) => options.firstRepetition + i);
  const random = seededRandom(options.seed);
  const blocks = reps.map(repetition =>
    (options.order === 'shuffled' ? shuffled(settings, random) : [...settings]).map(s => ({ ...s, repetition })));
  return blocks.flat().map((sample, order) => ({ ...sample, order }));
}

export interface Spread {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function spread(values: readonly (number | null | undefined)[]): Spread {
  const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const n = numbers.length;
  if (n === 0) return { n: 0, median: null, min: null, max: null };
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? numbers[mid] as number : ((numbers[mid - 1] as number) + (numbers[mid] as number)) / 2;
  return { n, median, min: numbers[0] as number, max: numbers[n - 1] as number };
}
