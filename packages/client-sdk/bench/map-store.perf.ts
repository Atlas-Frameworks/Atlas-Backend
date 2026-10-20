/**
 * C-02 benchmark: `npm run bench -w @atlas/client-sdk` (not part of `npm test`, timing-sensitive).
 *
 * - applying a MapDelta of 5,000 changed positions into a 30,000-entity store: target < 2 ms;
 * - building a frame: target < 1 ms, with no new buffers (heap growth per frame and GC count).
 */
import { PerformanceObserver } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { FrameBuilder } from '../src/map-store/frame.js';
import { LabelSelector } from '../src/map-store/label-selector.js';
import { MapLayerStore } from '../src/map-store/layer-store.js';
import { mapDelta, mapSnapshot } from '../src/testing/map-fixtures.js';
import type { TestEntity } from '../src/testing/map-fixtures.js';

const N = 30_000;
const CHANGED = 5_000;

function percentile(xs: number[], p: number): number {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
}

describe('map store benchmark (C-02)', () => {
  const entities: TestEntity[] = Array.from({ length: N }, (_, i) => ({
    id: `plane-${i.toString(36)}-${(i * 7919).toString(36)}`,
    lon: (i % 360) - 180,
    lat: ((i / 360) % 170) - 85,
    alt: 10_000,
    icon: i % 8,
    label: `LY${i}`,
  }));
  const store = new MapLayerStore('bench', { initialCapacity: 1_024 });
  store.applySnapshot(mapSnapshot(entities).snap);

  // 20 different deltas of 5,000 changed positions each (decoded, as the SDK receives them).
  const deltas = Array.from({ length: 20 }, (_, d) =>
    mapDelta(
      Array.from({ length: CHANGED }, (_, k) => {
        const src = entities[(d * 1_499 + k * 6) % N] as TestEntity;
        return { ...src, lon: src.lon + 0.01 * d, lat: src.lat - 0.01 * d };
      }),
    ),
  );

  it('applies a 5,000-position delta into 30,000 entities in < 2 ms', () => {
    for (let i = 0; i < 200; i++) store.applyDelta(deltas[i % deltas.length]!); // warm up
    const times: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = performance.now();
      store.applyDelta(deltas[i % deltas.length]!);
      times.push(performance.now() - t0);
    }
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    console.log(`applyDelta 5k/30k: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`);
    expect(store.size).toBe(N);
    expect(p50).toBeLessThan(2);
  });

  it('builds a frame in < 1 ms with no new buffers', async () => {
    const labels = new LabelSelector();
    labels.camera = { lon: 0, lat: 0, height: 500_000 };
    labels.selectedId = entities[5]!.id;
    const builder = new FrameBuilder(store, labels);
    // Warm up and allocate the 3 buffer sets.
    for (let i = 0; i < 200; i++) {
      store.applyDelta(deltas[i % deltas.length]!);
      const f = builder.build()!;
      builder.release(f.buffers);
    }
    const seen = new Set<unknown>();
    let gcs = 0;
    const obs = new PerformanceObserver((list) => {
      gcs += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['gc'] });
    const times = new Float64Array(1_000);
    for (let i = 0; i < times.length; i++) {
      store.version++; // data changed (deltas are applied outside the measured section)
      const t0 = performance.now();
      const f = builder.build()!;
      times[i] = performance.now() - t0;
      seen.add(f.buffers);
      builder.release(f.buffers);
    }
    // Heap growth per frame, measured over short windows with no GC in between.
    const perFrame: number[] = [];
    for (let attempt = 0; attempt < 50 && perFrame.length < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
      const gcBefore = gcs;
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100; i++) {
        const f = builder.build()!;
        builder.release(f.buffers);
      }
      const h1 = process.memoryUsage().heapUsed;
      await new Promise((r) => setTimeout(r, 0));
      if (gcs === gcBefore) perFrame.push((h1 - h0) / 100);
    }
    obs.disconnect();
    const heapPerFrame = percentile(perFrame, 50);
    const p50 = percentile([...times], 50);
    const p95 = percentile([...times], 95);
    console.log(
      `build frame 30k (500 labels): p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms; ` +
        `buffer sets used ${seen.size}; heap growth ${heapPerFrame.toFixed(0)} B/frame (median of ${perFrame.length} GC-free windows)`,
    );
    expect(seen.size).toBe(1); // released right away: the same set is reused every time
    expect(p50).toBeLessThan(1);
    // One frame's buffers are ~1 MB; a few hundred bytes per frame are the small frame object.
    expect(heapPerFrame).toBeLessThan(2_000);
  });
});
