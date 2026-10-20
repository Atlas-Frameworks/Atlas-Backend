import { describe, expect, it } from 'vitest';
import type { MapFrame } from '../adapters/map-adapter.js';
import { FakeClock, seededRandom } from '../testing/fake-clock.js';
import { mapDelta, mapSnapshot } from '../testing/map-fixtures.js';
import type { TestEntity } from '../testing/map-fixtures.js';
import { FrameBuilder, MapFrameAssembler } from './frame.js';
import type { WireMapFrame } from './frame.js';
import { FrameScheduler } from './frame-scheduler.js';
import { LabelSelector } from './label-selector.js';
import { MapLayerStore } from './layer-store.js';

const e = (id: string, lon = 0, lat = 0, extra: Partial<TestEntity> = {}): TestEntity => ({
  id,
  lon,
  lat,
  ...extra,
});

function snapshot(store: MapLayerStore, entities: TestEntity[]): void {
  store.applySnapshot(mapSnapshot(entities).snap);
}

/** Simulates the main thread: assemble frames, then hand buffers back. */
function pipeline(store: MapLayerStore, labels = new LabelSelector()) {
  const builder = new FrameBuilder(store, labels);
  const asm = new MapFrameAssembler();
  return {
    builder,
    asm,
    /** Build, assemble and return the frame (buffers are released right away). */
    frame(): MapFrame {
      const w = builder.build();
      if (!w) throw new Error('no buffer');
      const f = asm.assemble(w);
      const copy = { ...f, ids: [...f.ids], labels: new Map(f.labels) };
      builder.release(w.buffers);
      return copy;
    },
  };
}

describe('MapLayerStore (C-02)', () => {
  it('stores entities in stable slots and applies deltas', () => {
    const store = new MapLayerStore('planes');
    snapshot(store, [e('a', 1, 2, { alt: 3, icon: 4, label: 'A' }), e('b', 5, 6)]);
    expect(store.size).toBe(2);
    expect(store.count).toBe(2);
    const a = store.slotOfId('a') ?? -1;
    expect([...store.positions.subarray(a * 3, a * 3 + 3)]).toEqual([1, 2, 3]);
    expect(store.icons[a]).toBe(4);
    expect(store.labels.get(a)).toBe('A');

    store.applyDelta(mapDelta([e('a', 10, 20, { label: '' })], ['b']));
    expect(store.slotOfId('a')).toBe(a);
    expect(store.positions[a * 3]).toBe(10);
    expect(store.labels.has(a)).toBe(false);
    expect(store.size).toBe(1);
    expect(store.visible[store.count - 1]).toBe(0);
  });

  it('grows by doubling and keeps data', () => {
    const store = new MapLayerStore('planes', { initialCapacity: 16 });
    const many = Array.from({ length: 40 }, (_, i) => e(`p${i}`, i, -i));
    snapshot(store, many);
    expect(store.capacity).toBe(64);
    expect(store.positions[(store.slotOfId('p39') ?? 0) * 3]).toBe(39);
  });

  it('a snapshot keeps the slots of entities that are still present', () => {
    const store = new MapLayerStore('planes');
    snapshot(store, [e('a'), e('b'), e('c')]);
    const b = store.slotOfId('b');
    snapshot(store, [e('b'), e('d')]);
    expect(store.slotOfId('b')).toBe(b);
    expect(store.slotOfId('a')).toBeUndefined();
    expect(store.size).toBe(2);
  });

  it('picking: slot -> id stays valid across removals and reuse', () => {
    const store = new MapLayerStore('planes');
    const p = pipeline(store);
    snapshot(store, [e('a'), e('b'), e('c')]);
    const f1 = p.frame();
    const slotB = store.slotOfId('b') ?? -1;
    expect(f1.ids[slotB]).toBe('b');

    // b is removed; a new entity arrives before the next frame is sent.
    store.applyDelta(mapDelta([e('x')], ['b']));
    expect(store.slotOfId('x')).not.toBe(slotB); // freed slot not reused yet
    // A pick against frame 1 (still on screen) must not give a wrong id for slot B.
    expect(f1.ids[slotB]).toBe('b');
    const f2 = p.frame();
    expect(f2.ids[slotB]).toBe('');
    expect(f2.visible[slotB]).toBe(0);
    expect(f2.ids[store.slotOfId('x') ?? -1]).toBe('x');

    // After that frame was sent the slot may be reused.
    store.applyDelta(mapDelta([e('y')]));
    expect(store.slotOfId('y')).toBe(slotB);
    const f3 = p.frame();
    expect(f3.ids[slotB]).toBe('y');
    expect(f3.visible[slotB]).toBe(1);
  });

  it('picking stays correct after many random updates and removals', () => {
    const store = new MapLayerStore('planes', { initialCapacity: 16 });
    const p = pipeline(store);
    const rnd = seededRandom(42);
    const alive = new Set<string>();
    let next = 0;
    let frame: MapFrame | null = null;
    const violations: string[] = [];
    for (let round = 0; round < 300; round++) {
      const ups: TestEntity[] = [];
      const rem: string[] = [];
      for (let k = 0; k < 20; k++) {
        const r = rnd();
        if (r < 0.4 || alive.size === 0) {
          const id = `n${next++}`;
          alive.add(id);
          ups.push(e(id, rnd() * 360 - 180, rnd() * 180 - 90));
        } else if (r < 0.7) {
          const id = [...alive][Math.floor(rnd() * alive.size)] as string;
          if (!rem.includes(id)) ups.push(e(id, rnd(), rnd()));
        } else {
          const id = [...alive][Math.floor(rnd() * alive.size)] as string;
          if (!ups.some((u) => u.id === id) && !rem.includes(id)) {
            alive.delete(id);
            rem.push(id);
          }
        }
      }
      store.applyDelta(mapDelta(ups, rem));
      if (round % 3 === 0) frame = p.frame();
      if (frame) {
        // Every visible slot of the last frame names an entity, and the store agrees
        // unless the entity was removed after that frame.
        for (let slot = 0; slot < frame.count; slot++) {
          const id = frame.ids[slot] ?? '';
          if (frame.visible[slot] !== 1) continue;
          if (id === '' || (store.idAt(slot) !== id && alive.has(id))) {
            violations.push(`round ${round} slot ${slot}: frame ${id}, store ${store.idAt(slot)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
    const last = p.frame();
    const visibleIds = new Set<string>();
    for (let slot = 0; slot < last.count; slot++) {
      if (last.visible[slot] === 1) visibleIds.add(last.ids[slot] ?? '');
    }
    expect(visibleIds).toEqual(alive);
  });
});

describe('FrameBuilder (C-02)', () => {
  it('rotates a fixed set of buffers and returns null when all are busy', () => {
    const store = new MapLayerStore('planes');
    snapshot(store, [e('a', 1, 1)]);
    const builder = new FrameBuilder(store, new LabelSelector(), { maxBuffers: 3 });
    const frames = [builder.build(), builder.build(), builder.build()];
    expect(frames.every(Boolean)).toBe(true);
    expect(builder.build()).toBeNull();
    builder.release((frames[0] as WireMapFrame).buffers);
    const again = builder.build();
    expect(again?.buffers).toBe(frames[0]?.buffers); // same objects, nothing new allocated
    expect(builder.inFlight).toBe(3);
  });

  it('sends every id on the first frame, then only changes', () => {
    const store = new MapLayerStore('planes');
    snapshot(store, [e('a'), e('b')]);
    const builder = new FrameBuilder(store, new LabelSelector());
    const f1 = builder.build() as WireMapFrame;
    expect(f1.idReset).toBe(true);
    expect(f1.idTexts).toEqual(['a', 'b']);
    builder.release(f1.buffers);
    store.applyDelta(mapDelta([e('a', 3, 3), e('c')]));
    const f2 = builder.build() as WireMapFrame;
    expect(f2.idReset).toBe(false);
    expect(f2.idTexts).toEqual(['c']);
    builder.reset();
    builder.release(f2.buffers);
    const f3 = builder.build() as WireMapFrame;
    expect(f3.idReset).toBe(true);
    expect(f3.idTexts).toEqual(['a', 'b', 'c']);
  });
});

describe('LabelSelector (C-02)', () => {
  const store = new MapLayerStore('planes');
  snapshot(
    store,
    Array.from({ length: 50 }, (_, i) => e(`p${i}`, i, 0, { label: `P${i}` })),
  );
  const slots = new Uint32Array(500);
  const texts: string[] = [];

  it('labels only the selected entity when zoomed out or without a camera', () => {
    const sel = new LabelSelector();
    sel.selectedId = 'p7';
    expect(sel.select(store, slots, texts)).toBe(1);
    expect(texts).toEqual(['P7']);
    sel.camera = { lon: 0, lat: 0, height: 10_000_000 };
    expect(sel.select(store, slots, texts)).toBe(1);
  });

  it('labels the selected entity plus the nearest ones, at most maxLabels', () => {
    const sel = new LabelSelector({ maxLabels: 5 });
    sel.selectedId = 'p40';
    sel.camera = { lon: 10.2, lat: 0, height: 100_000 };
    expect(sel.select(store, slots, texts)).toBe(5);
    expect(texts[0]).toBe('P40');
    expect(texts.slice(1).toSorted()).toEqual(['P10', 'P11', 'P12', 'P9']);
  });

  it('defaults to 500 labels', () => {
    const big = new MapLayerStore('big');
    snapshot(
      big,
      Array.from({ length: 2_000 }, (_, i) => e(`b${i}`, i / 100, 0, { label: 'x' })),
    );
    const sel = new LabelSelector();
    sel.camera = { lon: 0, lat: 0 };
    expect(sel.select(big, new Uint32Array(500), [])).toBe(500);
  });
});

function setupScheduler(maxFps = 10) {
  const clock = new FakeClock();
  const frames: WireMapFrame[] = [];
  const times: number[] = [];
  const sched = new FrameScheduler(
    clock,
    (f) => {
      frames.push(f);
      times.push(clock.now());
    },
    { maxFps },
  );
  const store = sched.addLayer('planes');
  return { clock, frames, times, sched, store };
}

describe('FrameScheduler (C-02)', () => {
  it('emits only when data changed, at most maxFps per second', () => {
    const { clock, frames, times, sched, store } = setupScheduler(10);
    clock.advance(0);
    expect(frames).toHaveLength(1); // initial (empty) frame
    clock.advance(1_000);
    expect(frames).toHaveLength(1); // nothing changed
    for (let i = 0; i < 100; i++) {
      store.applyDelta(mapDelta([e('a', i, 0)]));
      clock.advance(10);
      const f = frames.at(-1) as WireMapFrame;
      sched.release('planes', f.buffers);
    }
    // 100 changes from t=1000 to t=1990: frames at t=1000, 1100, ... 2000 (both ends included),
    // never closer than 100 ms.
    expect(times.slice(1)).toEqual(
      Array.from({ length: 11 }, (_, i) => times[0]! + 1_000 + i * 100),
    );
    const last = frames.at(-1) as WireMapFrame;
    expect(last.buffers.positions[0]).toBeGreaterThanOrEqual(90);
  });

  it('stops while paused and emits the latest state on resume', () => {
    const { clock, frames, sched, store } = setupScheduler();
    clock.advance(0);
    sched.release('planes', (frames[0] as WireMapFrame).buffers);
    sched.setPaused(true);
    store.applyDelta(mapDelta([e('a', 1, 0)]));
    store.applyDelta(mapDelta([e('a', 2, 0)]));
    clock.advance(5_000);
    expect(frames).toHaveLength(1);
    sched.setPaused(false);
    clock.advance(0);
    expect(frames).toHaveLength(2);
    expect((frames[1] as WireMapFrame).buffers.positions[0]).toBe(2);
  });

  it('waits for returned buffers instead of allocating more', () => {
    const { clock, frames, sched, store } = setupScheduler(1_000);
    for (let i = 0; i < 10; i++) {
      store.applyDelta(mapDelta([e('a', i, 0)]));
      clock.advance(5);
    }
    expect(frames).toHaveLength(3); // three buffer sets, none returned
    sched.release('planes', (frames[0] as WireMapFrame).buffers);
    clock.advance(5);
    expect(frames).toHaveLength(4);
    expect((frames[3] as WireMapFrame).buffers.positions[0]).toBe(9);
  });

  it('re-emits when the camera or selection changes labels', () => {
    const { clock, frames, sched, store } = setupScheduler();
    store.applyDelta(mapDelta([e('a', 1, 0, { label: 'A' })]));
    clock.advance(200);
    const n = frames.length;
    for (const f of frames) sched.release('planes', f.buffers);
    sched.setSelected('a');
    clock.advance(200);
    expect(frames.length).toBe(n + 1);
    expect(frames.at(-1)?.labelTexts).toEqual(['A']);
  });
});
