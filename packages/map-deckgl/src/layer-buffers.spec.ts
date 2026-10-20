import { describe, expect, it } from 'vitest';
import { LayerBuffers } from './layer-buffers.js';
import { FrameFixture } from './test-frames.js';

describe('LayerBuffers', () => {
  it('packs visible slots densely and keeps full double precision', () => {
    const f = new FrameFixture('planes');
    f.set(0, 'a', 34.123456789012, 32.000000001, 1000);
    f.set(1, 'b', 2.35, 48.85);
    f.set(2, 'c', -0.12, 51.5, 0, 3);
    f.remove(1);
    const b = new LayerBuffers(4);
    b.apply(f.frame());

    expect(b.length).toBe(2);
    const set = b.current;
    expect(set.data.length).toBe(2);
    expect(set.data.attributes.getPosition.value).toBeInstanceOf(Float64Array);
    expect(set.data.attributes.getPosition.size).toBe(3);
    expect([...set.positions.subarray(0, 6)]).toEqual([
      34.123456789012, 32.000000001, 1000, -0.12, 51.5, 0,
    ]);
    expect([...set.slotOf.subarray(0, 2)]).toEqual([0, 2]);
    expect([...set.icons.subarray(0, 2)]).toEqual([0, 3]);
  });

  it('alternates buffer sets so deck.gl sees a new data object per frame, without allocating', () => {
    const f = new FrameFixture('planes');
    for (let i = 0; i < 10; i++) f.set(i, `p${i}`, i, i);
    const b = new LayerBuffers(16);
    b.apply(f.frame());
    const first = b.current;
    b.apply(f.frame());
    const second = b.current;
    b.apply(f.frame());
    expect(second).not.toBe(first);
    expect(second.data).not.toBe(first.data);
    expect(second.data.attributes.getPosition.value).not.toBe(
      first.data.attributes.getPosition.value,
    );
    // Third frame reuses the first set's arrays and objects.
    expect(b.current).toBe(first);
    expect(b.current.data.attributes.getPosition.value).toBe(first.positions);
    expect(b.version).toBe(3);
  });

  it('grows when the layer outgrows its capacity', () => {
    const f = new FrameFixture('planes');
    for (let i = 0; i < 100; i++) f.set(i, `p${i}`, i / 10, -i / 10);
    const b = new LayerBuffers(4);
    b.apply(f.frame());
    expect(b.length).toBe(100);
    expect(b.current.positions[99 * 3]).toBeCloseTo(9.9, 12);
    expect(b.current.data.attributes.getPosition.value).toBe(b.current.positions);
  });

  it('resolves picks to the right id after many updates, removals and slot reuse', () => {
    const f = new FrameFixture('planes');
    const b = new LayerBuffers(8);
    for (let i = 0; i < 50; i++) f.set(i, `p${i}`, i, 0);
    b.apply(f.frame());

    // Remove every third, move the rest, reuse a few freed slots for new entities.
    for (let i = 0; i < 50; i += 3) f.remove(i);
    for (let round = 0; round < 20; round++) {
      for (let i = 1; i < 50; i += 3) f.set(i, `p${i}`, i + round * 0.01, round);
      b.apply(f.frame());
    }
    f.set(3, 'new-3', 3, 3);
    f.set(48, 'new-48', 48, 48);
    b.apply(f.frame());

    const set = b.current;
    const seen = new Map<string, number>();
    for (let k = 0; k < set.data.length; k++) {
      const id = b.idAt(set.data, k);
      expect(id).not.toBeNull();
      const slot = set.slotOf[k]!;
      expect(id).toBe(f.ids[slot]);
      // Position of instance k is the slot's position.
      expect(set.positions[k * 3]).toBe(f.positions[slot * 3]);
      seen.set(id!, slot);
    }
    expect(seen.get('new-3')).toBe(3);
    expect(seen.get('new-48')).toBe(48);
    expect(seen.has('p0')).toBe(false);
    expect(seen.has('p6')).toBe(false);
    // 50 slots, 17 removed, 2 reused.
    expect(set.data.length).toBe(35);
  });

  it('resolves a pick against the previous set (the one still on screen)', () => {
    const f = new FrameFixture('planes');
    f.set(0, 'a', 0, 0);
    f.set(1, 'b', 1, 1);
    const b = new LayerBuffers(4);
    b.apply(f.frame());
    const onScreen = b.current.data;
    f.remove(0);
    f.set(2, 'c', 2, 2);
    b.apply(f.frame());
    // Instance 1 of the old set is slot 1 ('b'); in the new set instance 1 is slot 2 ('c').
    expect(b.idAt(onScreen, 1)).toBe('b');
    expect(b.idAt(b.current.data, 1)).toBe('c');
    // Instance 0 of the old set was 'a', now freed: no id.
    expect(b.idAt(onScreen, 0)).toBeNull();
    expect(b.idAt({ length: 1 }, 0)).toBeNull();
    expect(b.idAt(b.current.data, 5)).toBeNull();
  });

  it('labels only the labelled, visible subset', () => {
    const f = new FrameFixture('planes');
    for (let i = 0; i < 5; i++) f.set(i, `p${i}`, i, i * 2, 100);
    f.labels.set(1, 'ELY001');
    f.labels.set(3, 'AFR22');
    f.labels.set(4, 'BAW7');
    f.visible[4] = 0;
    const b = new LayerBuffers(4);
    b.apply(f.frame());
    const labels = b.currentLabels;
    expect(labels.data.length).toBe(2);
    expect(labels.texts.slice(0, 2)).toEqual(['ELY001', 'AFR22']);
    expect([...labels.positions.subarray(0, 6)]).toEqual([1, 2, 100, 3, 6, 100]);
  });
});
