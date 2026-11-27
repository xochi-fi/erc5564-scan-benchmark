import { readdir, readFile } from 'node:fs/promises';
import type { MemorySnapshot } from './model.ts';

export function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external };
}

/** Reads a JSON-lines file; a missing file reads as no rows. */
export async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Hottest sysfs thermal zone in °C, or null where none is readable. */
export async function maxThermalC(): Promise<number | null> {
  const zones = (await readdir('/sys/class/thermal').catch(() => [])).filter(zone => zone.startsWith('thermal_zone'));
  const temps = await Promise.all(zones.map(zone => Bun.file(`/sys/class/thermal/${zone}/temp`).text()
    .then(Number, () => NaN)));
  const valid = temps.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) / 1000 : null;
}

/** Polls every 5 s until every thermal zone is at or below `limitC`. */
export async function waitForCooldown(limitC: number): Promise<{ maxC: number | null; waitMs: number }> {
  const start = performance.now();
  let maxC = await maxThermalC();
  while (maxC !== null && maxC > limitC) {
    await Bun.sleep(5_000);
    maxC = await maxThermalC();
  }
  return { maxC, waitMs: performance.now() - start };
}
