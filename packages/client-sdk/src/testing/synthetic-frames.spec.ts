import { describe, expect, it } from 'vitest';
import { seededRandom } from './fake-clock.js';
import { SyntheticFrames } from './synthetic-frames.js';

describe('SyntheticFrames', () => {
  it('moves the update budget per step and reuses freed slots one step later', () => {
    const src = new SyntheticFrames({
      layerId: 'l',
      entities: 1000,
      updatesPerSecond: 2000,
      churn: 0.1,
      labels: 10,
      random: seededRandom(7),
    });
    const f = src.frame;
    expect(f.count).toBe(1000);
    expect(f.labels.size).toBe(10);
    const before = f.positions.slice();

    src.step(100); // 200 updates, about 20 removals
    let moved = 0;
    const freed: number[] = [];
    for (let s = 0; s < f.count; s++) {
      if (f.visible[s] === 0) freed.push(s);
      else if (f.positions[s * 3] !== before[s * 3]) moved++;
    }
    expect(freed.length).toBeGreaterThan(5);
    expect(freed.map((s) => f.ids[s])).toEqual(freed.map(() => ''));
    expect(moved).toBeGreaterThan(100);

    src.step(0);
    for (const s of freed) {
      expect(f.visible[s]).toBe(1);
      expect(f.ids[s]).toMatch(/^plane-\d+$/);
      expect(Number(f.ids[s]!.slice(6))).toBeGreaterThanOrEqual(1000);
    }
    expect(new Set(f.ids).size).toBe(1000);
  });
});
