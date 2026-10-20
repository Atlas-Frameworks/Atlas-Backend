/**
 * Time and randomness are injected so every ordering and reconnect rule can be tested
 * deterministically (see testing/fake-clock.ts).
 */

/** Opaque timer handle returned by {@link Clock.setTimeout}. */
export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Returns a float in [0, 1), like `Math.random`. */
export type RandomSource = () => number;

const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
let nextSystemTimer = 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = nextSystemTimer++;
    systemTimers.set(
      id,
      globalThis.setTimeout(() => {
        systemTimers.delete(id);
        fn();
      }, ms),
    );
    return id;
  },
  clearTimeout: (handle) => {
    if (typeof handle !== 'number') return;
    const t = systemTimers.get(handle);
    if (t !== undefined) globalThis.clearTimeout(t);
    systemTimers.delete(handle);
  },
};

export const systemRandom: RandomSource = Math.random;
