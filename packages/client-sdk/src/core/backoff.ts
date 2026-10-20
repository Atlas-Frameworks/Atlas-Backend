import type { RandomSource } from './clock.js';

export interface BackoffOptions {
  /** First ceiling in ms (default 1 000). */
  baseMs?: number;
  /** Largest ceiling in ms (default 30 000). */
  maxMs?: number;
}

/**
 * Exponential backoff with full jitter: the ceiling doubles from `baseMs` per attempt up to
 * `maxMs`, and the delay is uniform in [0, ceiling).
 *
 * @param attempt 0 for the first retry after a disconnect.
 */
export function backoffDelay(
  attempt: number,
  random: RandomSource,
  { baseMs = 1_000, maxMs = 30_000 }: BackoffOptions = {},
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}
