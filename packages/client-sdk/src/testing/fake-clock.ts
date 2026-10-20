import type { Clock, RandomSource, TimerHandle } from '../core/clock.js';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Manual clock for deterministic tests: time moves only through {@link advance}. */
export class FakeClock implements Clock {
  private time: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start = Date.UTC(2026, 9, 20, 12, 0, 0)) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer = { id: this.nextId++, at: this.time + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Pending timers, soonest first (for assertions). */
  pending(): { at: number; inMs: number }[] {
    return this.timers
      .toSorted((a, b) => a.at - b.at || a.id - b.id)
      .map((t) => ({ at: t.at, inMs: t.at - this.time }));
  }

  /** Moves time forward, firing due timers in order (including ones they schedule). */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= end)
        .toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = end;
  }
}

/** Deterministic PRNG (mulberry32), returning values in [0, 1). */
export function seededRandom(seed = 1): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random source that returns the given values in turn (then repeats the last one). */
export function scriptedRandom(...values: number[]): RandomSource {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}
