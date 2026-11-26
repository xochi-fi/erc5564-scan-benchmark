/**
 * Finds the largest eth_getLogs block span an endpoint accepts, with an
 * exponential bracket and then a binary search. Pure apart from the supplied
 * `accepts` callback, so tests drive it with recorded or synthetic endpoints.
 */

export type Verdict = 'ok' | 'fail';

export interface SearchStep { blocks: number; verdict: Verdict; note: string | null }

export interface RangeSearchResult {
  /** Largest span (blocks, inclusive) that succeeded; 0 if none did. */
  maxOk: number;
  /** Smallest span that failed; null if `ceiling` itself succeeded. */
  minFail: number | null;
  /** true when ceiling (the whole history span) succeeded. */
  unbounded: boolean;
  steps: SearchStep[];
}

export interface RangeSearchOptions {
  start: number;            // first span to try
  ceiling: number;          // never test above this (e.g. deploy -> head)
  /** Stop the binary search once minFail - maxOk <= max(1, maxOk * relativePrecision). */
  relativePrecision?: number;
  maxSteps?: number;
}

/** Common provider limits; tested first inside the bracket so exact limits are hit quickly. */
export const ROUND_LIMITS = [100, 500, 1000, 2000, 3000, 5000, 10_000, 20_000, 50_000, 100_000, 500_000, 1_000_000, 10_000_000];

export async function searchMaxRange(
  accepts: (blocks: number) => Promise<{ verdict: Verdict; note: string | null }>,
  options: RangeSearchOptions,
): Promise<RangeSearchResult> {
  const precision = options.relativePrecision ?? 0;
  const maxSteps = options.maxSteps ?? 60;
  const ceiling = Math.max(1, options.ceiling);
  const steps: SearchStep[] = [];
  const tested = new Map<number, Verdict>();
  const test = async (blocks: number): Promise<Verdict> => {
    const cached = tested.get(blocks);
    if (cached !== undefined) return cached;
    const { verdict, note } = await accepts(blocks);
    tested.set(blocks, verdict);
    steps.push({ blocks, verdict, note });
    return verdict;
  };

  let maxOk = 0;
  let minFail: number | null = null;
  let span = Math.min(Math.max(1, options.start), ceiling);
  // Bracket upward.
  if ((await test(span)) === 'ok') {
    maxOk = span;
    while (maxOk < ceiling && steps.length < maxSteps) {
      const next = Math.min(ceiling, maxOk * 4);
      if ((await test(next)) === 'ok') maxOk = next;
      else { minFail = next; break; }
    }
    if (minFail === null && maxOk === ceiling) return { maxOk, minFail: null, unbounded: true, steps };
  } else {
    minFail = span;
    // Bracket downward.
    while (span > 1 && steps.length < maxSteps) {
      span = Math.max(1, Math.floor(span / 4));
      if ((await test(span)) === 'ok') { maxOk = span; break; }
      minFail = span;
    }
    if (maxOk === 0) return { maxOk: 0, minFail, unbounded: false, steps };
  }
  if (minFail === null) return { maxOk, minFail: null, unbounded: false, steps };

  // Round provider limits inside the bracket, then plain bisection.
  for (const round of ROUND_LIMITS) {
    if (round <= maxOk || round >= minFail) continue;
    if (steps.length >= maxSteps) break;
    if ((await test(round)) === 'ok') maxOk = round;
    else { minFail = round; break; }
  }
  // A round limit L is typically accepted with L+1 rejected; check that cheaply.
  if (ROUND_LIMITS.includes(maxOk) && minFail > maxOk + 1 && steps.length < maxSteps) {
    if ((await test(maxOk + 1)) === 'fail') minFail = maxOk + 1;
    else maxOk = maxOk + 1;
  }
  while (minFail - maxOk > Math.max(1, Math.floor(maxOk * precision)) && steps.length < maxSteps) {
    const mid = Math.floor((maxOk + minFail) / 2);
    if ((await test(mid)) === 'ok') maxOk = mid;
    else minFail = mid;
  }
  return { maxOk, minFail, unbounded: false, steps };
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? null;
}
