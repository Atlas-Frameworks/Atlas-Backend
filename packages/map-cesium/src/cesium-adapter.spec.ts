// @vitest-environment jsdom
// (Cesium's Label parses its font through a DOM element; everything else runs in plain Node.)
import { FrameBuilder, LabelSelector, MapFrameAssembler, MapLayerStore } from '@atlas/client-sdk';
import type { LayerStyle, MapFrame } from '@atlas/client-sdk';
import { mapDelta, mapSnapshot, seededRandom } from '@atlas/client-sdk/testing';
import type { TestEntity } from '@atlas/client-sdk/testing';
import {
  BillboardCollection,
  BufferPoint,
  BufferPointCollection,
  Cartesian2,
  Cartesian3,
  LabelCollection,
  PointPrimitiveCollection,
  PrimitiveCollection,
} from 'cesium';
import { describe, expect, it } from 'vitest';
import { CesiumAdapter } from './cesium-adapter.js';
import type { CesiumSceneLike, PointCollectionKind } from './cesium-adapter.js';

/**
 * A stand-in for `Scene` that needs no WebGL. `pick(x, y)` reads the window position as
 * (lon, lat) degrees and returns the nearest *shown* point within 1 m from the real Cesium
 * collections the adapter built, shaped exactly as Cesium's pick result for that collection type:
 * `{collection, index}` for buffer points, `{primitive, collection, id}` for point primitives,
 * billboards and label glyphs. So the test checks what Cesium would draw (positions, show flags,
 * pick payloads), not the adapter's own bookkeeping.
 */
class FakeScene implements CesiumSceneLike {
  readonly primitives = new PrimitiveCollection();
  private readonly point = new BufferPoint();
  private readonly cart = new Cartesian3();
  /** When set, pick() returns a label at that slot instead of searching points. */
  pickLabelAt: Cartesian3 | null = null;

  /** Points with `show = true` across every collection in the scene. */
  shownPoints(): number {
    let n = 0;
    const visit = (p: unknown): void => {
      if (p instanceof PrimitiveCollection) {
        for (let i = 0; i < p.length; i++) visit(p.get(i));
      } else if (p instanceof BufferPointCollection) {
        for (let i = 0; i < p.primitiveCount; i++) if (p.get(i, this.point).show) n++;
      } else if (p instanceof PointPrimitiveCollection || p instanceof BillboardCollection) {
        for (let i = 0; i < p.length; i++) if (p.get(i).show) n++;
      }
    };
    visit(this.primitives);
    return n;
  }

  pick(w: Cartesian2): unknown {
    const target = Cartesian3.fromDegrees(w.x, w.y, 0);
    let best: unknown = undefined;
    let bestDist = 1;
    const visit = (p: unknown): void => {
      if (p instanceof PrimitiveCollection) {
        for (let i = 0; i < p.length; i++) visit(p.get(i));
      } else if (p instanceof BufferPointCollection) {
        for (let i = 0; i < p.primitiveCount; i++) {
          p.get(i, this.point);
          if (!this.point.show) continue;
          const d = Cartesian3.distance(this.point.getPosition(this.cart), target);
          if (d < bestDist) [best, bestDist] = [{ collection: p, index: i }, d];
        }
      } else if (p instanceof PointPrimitiveCollection || p instanceof BillboardCollection) {
        for (let i = 0; i < p.length; i++) {
          const prim = p.get(i);
          if (!prim.show) continue;
          const d = Cartesian3.distance(prim.position, target);
          if (d < bestDist) [best, bestDist] = [{ primitive: prim, collection: p, id: prim.id }, d];
        }
      } else if (p instanceof LabelCollection && this.pickLabelAt) {
        for (let i = 0; i < p.length; i++) {
          const label = p.get(i);
          if (label.show && Cartesian3.distance(label.position, target) < 1) {
            // A label is drawn as glyph billboards whose pick primitive is the label.
            best = { primitive: label, collection: {}, id: label.id };
            bestDist = 0;
          }
        }
      }
    };
    visit(this.primitives);
    return best;
  }
}

/** The SDK side for one layer: store -> frame builder -> assembler, buffers released after use. */
function sdkLayer(layerId: string, labels = new LabelSelector()) {
  const store = new MapLayerStore(layerId);
  const builder = new FrameBuilder(store, labels);
  const asm = new MapFrameAssembler();
  return {
    store,
    /** Builds a frame, hands it to `apply`, then returns the buffers (like the bridge does). */
    send(apply: (frame: MapFrame) => void): void {
      const w = builder.build();
      if (!w) throw new Error('no free frame buffer');
      try {
        apply(asm.assemble(w));
      } finally {
        builder.release(w.buffers);
      }
    },
  };
}

const LAYER = 'airplanes';
/** Entity i on a 300-wide grid of whole degrees. */
const gridEntity = (i: number) => ({
  id: `p${i}`,
  lon: (i % 300) - 150,
  lat: Math.floor(i / 300) - 40,
});
const ICON_STYLE: LayerStyle = { icons: ['plane.png', 'heli.png'] };

function stressAndPick(points: PointCollectionKind, style: LayerStyle) {
  const rnd = seededRandom(42);
  const scene = new FakeScene();
  const adapter = new CesiumAdapter(scene, { points });
  adapter.createLayer(LAYER, style);
  const sdk = sdkLayer(LAYER);
  const apply = (f: MapFrame) => adapter.applyFrame(f);

  const live = new Map<string, TestEntity>();
  const removed = new Map<string, TestEntity>();
  let next = 0;
  const spawn = (): TestEntity => {
    const e = {
      id: `plane-${next++}`,
      lon: rnd() * 340 - 170,
      lat: rnd() * 160 - 80,
      alt: 0,
      icon: Math.floor(rnd() * 2),
    };
    live.set(e.id, e);
    return e;
  };

  sdk.store.applySnapshot(mapSnapshot(Array.from({ length: 1500 }, spawn)).snap);
  sdk.send(apply);

  for (let round = 0; round < 150; round++) {
    const ids = [...live.keys()];
    const upserts: TestEntity[] = [];
    for (let i = 0; i < 120; i++) {
      const e = live.get(ids[Math.floor(rnd() * ids.length)]!)!;
      e.lon = Math.max(-179, Math.min(179, e.lon + (rnd() - 0.5)));
      e.lat = Math.max(-85, Math.min(85, e.lat + (rnd() - 0.5)));
      upserts.push({ ...e });
    }
    const removeIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = ids[Math.floor(rnd() * ids.length)]!;
      const e = live.get(id);
      if (!e) continue;
      live.delete(id);
      removed.set(id, e);
      removeIds.push(id);
    }
    // Some of the removed are moved in the same delta first (upsert + remove of one id).
    for (let i = 0; i < 15; i++) upserts.push(spawn());
    sdk.store.applyDelta(
      mapDelta(
        upserts.filter((u) => live.has(u.id)),
        removeIds,
        round + 2,
      ),
    );
    sdk.send(apply);
  }
  return { scene, adapter, sdk, live, removed, rnd, apply };
}

describe.each([
  ['buffer points', 'buffer', {}],
  ['point primitives', 'primitive', {}],
  ['billboards (icons)', 'buffer', ICON_STYLE],
] as const)('CesiumAdapter pick with %s', (_name, points, style) => {
  it('returns the right id for every live entity after many updates and removals', () => {
    const { scene, adapter, live, removed } = stressAndPick(points, style);
    expect(removed.size).toBeGreaterThan(2000);
    // Exactly the live entities are drawn: removed ones are hidden, not left on the map.
    expect(scene.shownPoints()).toBe(live.size);
    expect(adapter.stats.count).toBeGreaterThanOrEqual(live.size);

    for (const e of live.values()) expect(adapter.pick(e.lon, e.lat)).toBe(e.id);
    // Removed entities are hidden: nothing is picked where they were last drawn.
    let picked = 0;
    for (const e of removed.values()) if (adapter.pick(e.lon, e.lat) !== null) picked++;
    expect(picked).toBe(0);
  });

  it('a freed slot reused by a new entity picks the new id, never the old one', () => {
    const { adapter, sdk, live, apply } = stressAndPick(points, style);
    const victim = [...live.values()][7]!;
    const slot = sdk.store.slotOfId(victim.id)!;
    sdk.store.applyDelta(mapDelta([], [victim.id], 1000));
    sdk.send(apply);
    expect(adapter.pick(victim.lon, victim.lat)).toBeNull();

    // The next new entity takes the freed slot (at a different place).
    const fresh = { id: 'reuser', lon: 12.5, lat: 41.9, alt: 0, icon: 1 };
    sdk.store.applyDelta(mapDelta([fresh], [], 1001));
    expect(sdk.store.slotOfId('reuser')).toBe(slot);
    sdk.send(apply);
    expect(adapter.pick(fresh.lon, fresh.lat)).toBe('reuser');
    expect(adapter.pick(victim.lon, victim.lat)).toBeNull();
  });
});

describe('CesiumAdapter', () => {
  it('only writes the slots that changed', () => {
    const scene = new FakeScene();
    const adapter = new CesiumAdapter(scene);
    adapter.createLayer(LAYER, {});
    const sdk = sdkLayer(LAYER);
    const entities = Array.from({ length: 3000 }, (_, i) => ({
      id: `p${i}`,
      lon: i / 100,
      lat: 1,
    }));
    sdk.store.applySnapshot(mapSnapshot(entities).snap);
    sdk.send((f) => adapter.applyFrame(f));
    expect(adapter.stats).toMatchObject({ count: 3000, moved: 3000, toggled: 3000 });

    sdk.store.applyDelta(mapDelta([{ id: 'p5', lon: 50, lat: 2 }], ['p6']));
    sdk.send((f) => adapter.applyFrame(f));
    expect(adapter.stats).toMatchObject({ moved: 1, toggled: 1 });
    sdk.send((f) => adapter.applyFrame(f));
    expect(adapter.stats).toMatchObject({ moved: 0, toggled: 0 });
  });

  it('grows a buffer collection past its first capacity without losing points', () => {
    const scene = new FakeScene();
    const adapter = new CesiumAdapter(scene, { points: 'buffer' });
    adapter.createLayer(LAYER, {});
    const sdk = sdkLayer(LAYER);
    sdk.store.applySnapshot(mapSnapshot(Array.from({ length: 500 }, (_, i) => gridEntity(i))).snap);
    sdk.send((f) => adapter.applyFrame(f));
    sdk.store.applyDelta(mapDelta(Array.from({ length: 3000 }, (_, i) => gridEntity(i + 500))));
    sdk.send((f) => adapter.applyFrame(f));
    for (const i of [0, 499, 500, 1500, 3499])
      expect(adapter.pick(gridEntity(i).lon, gridEntity(i).lat)).toBe(`p${i}`);
  });

  it('labels only the labelled subset and picks through a label', () => {
    const scene = new FakeScene();
    const adapter = new CesiumAdapter(scene, { points: 'primitive' });
    adapter.createLayer(LAYER, {});
    const selector = new LabelSelector();
    selector.selectedId = 'a';
    const sdk = sdkLayer(LAYER, selector);
    sdk.store.applySnapshot(
      mapSnapshot([
        { id: 'a', lon: 1, lat: 1, label: 'AAL1' },
        { id: 'b', lon: 2, lat: 2 },
        { id: 'c', lon: 3, lat: 3, label: 'BAW2' },
      ]).snap,
    );
    sdk.send((f) => {
      expect([...f.labels.values()]).toEqual(['AAL1']);
      adapter.applyFrame(f);
    });
    expect(adapter.stats.labels).toBe(1);

    scene.pickLabelAt = Cartesian3.fromDegrees(1, 1);
    expect(adapter.resolvePick(scene.pick(new Cartesian2(1, 1)))).toBe('a');

    // Removing a labelled entity hides its label (and its point).
    sdk.store.applyDelta(mapDelta([], ['a']));
    sdk.send((f) => adapter.applyFrame(f));
    expect(adapter.resolvePick(scene.pick(new Cartesian2(1, 1)))).toBeNull();
  });

  it('locates an entity by id through the last frame (layer and drawn position)', () => {
    const scene = new FakeScene();
    const adapter = new CesiumAdapter(scene);
    adapter.createLayer(LAYER, {});
    adapter.createLayer('other', {});
    const sdk = sdkLayer(LAYER);
    sdk.store.applySnapshot(
      mapSnapshot([
        { id: 'a', lon: 1, lat: 2, alt: 3 },
        { id: 'b', lon: 4, lat: 5 },
      ]).snap,
    );
    sdk.send((f) => adapter.applyFrame(f));
    expect(adapter.locate('a')).toEqual({ layerId: LAYER, lon: 1, lat: 2, alt: 3 });
    expect(adapter.locate('a', 'other')).toBeNull();
    expect(adapter.locate('nope')).toBeNull();

    sdk.store.applyDelta(mapDelta([{ id: 'b', lon: 6, lat: 7 }], ['a']));
    sdk.send((f) => adapter.applyFrame(f));
    expect(adapter.locate('a')).toBeNull();
    expect(adapter.locate('b', LAYER)).toEqual({ layerId: LAYER, lon: 6, lat: 7, alt: 0 });
  });

  it('ignores layers that are not pickable and cleans up on destroy', () => {
    const scene = new FakeScene();
    const adapter = new CesiumAdapter(scene);
    adapter.createLayer(LAYER, { pickable: false });
    const sdk = sdkLayer(LAYER);
    sdk.store.applySnapshot(mapSnapshot([{ id: 'a', lon: 1, lat: 1 }]).snap);
    sdk.send((f) => adapter.applyFrame(f));
    expect(adapter.pick(1, 1)).toBeNull();
    expect(scene.primitives.length).toBe(1);
    adapter.destroy();
    expect(scene.primitives.length).toBe(0);
    expect(adapter.pick(1, 1)).toBeNull();
  });
});
