import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { describe, expect, it, vi } from 'vitest';
import { DeckGlAdapter, parseFont, type DeckOverlay } from './deckgl-adapter.js';
import { parseColor } from './color.js';
import { FrameFixture } from './test-frames.js';

/** Records the layers the adapter hands deck.gl; `nextPick` is what `pickObject` returns. */
class FakeOverlay implements DeckOverlay {
  layers: Layer[] = [];
  setPropsCalls = 0;
  pickCalls: { x: number; y: number; layerIds?: string[] }[] = [];
  nextPick: { layerId: string; index: number } | null = null;

  setProps(props: { layers: Layer[] }): void {
    this.layers = props.layers;
    this.setPropsCalls++;
  }

  pickObject(opts: { x: number; y: number; layerIds?: string[] }): PickingInfo | null {
    this.pickCalls.push(opts);
    const want = this.nextPick;
    if (!want) return null;
    const layer = this.layers.find((l) => l.id === want.layerId) ?? null;
    return { layer, index: want.index, x: opts.x, y: opts.y } as PickingInfo;
  }

  byId(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }
}

function setup() {
  const overlay = new FakeOverlay();
  const map = {
    addControl: vi.fn<(c: unknown) => void>(),
    removeControl: vi.fn<(c: unknown) => void>(),
    addSource: vi.fn<(id: string, source: unknown) => void>(),
    addLayer: vi.fn<(layer: unknown) => void>(),
  };
  const adapter = new DeckGlAdapter(map, { overlay });
  return { overlay, map, adapter };
}

describe('DeckGlAdapter', () => {
  it('draws a ScatterplotLayer from binary Float64 attributes, never a GeoJSON source', () => {
    const { overlay, map, adapter } = setup();
    adapter.createLayer('planes', { color: '#ff0000', pixelSize: 8 });
    const f = new FrameFixture('planes');
    f.set(0, 'a', 34.8, 32.1, 9000);
    f.set(1, 'b', 2.35, 48.85, 0);
    f.labels.set(0, 'ELY001');
    adapter.applyFrame(f.frame());

    const points = overlay.byId('planes');
    expect(points).toBeInstanceOf(ScatterplotLayer);
    const data = points!.props.data as {
      length: number;
      attributes: Record<string, { value: unknown }>;
    };
    expect(data.length).toBe(2);
    expect(data.attributes['getPosition']!.value).toBeInstanceOf(Float64Array);
    expect(points!.props.pickable).toBe(true);
    expect(overlay.byId('planes:labels')).toBeInstanceOf(TextLayer);

    // Nothing goes through the map's own sources or layers.
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
    for (const layer of overlay.layers) {
      expect(layer.constructor.name).not.toMatch(/GeoJson/i);
      expect(Array.isArray(layer.props.data)).toBe(false);
      expect((layer.props.data as { type?: string }).type).not.toBe('FeatureCollection');
    }
  });

  it('source never uses GeoJSON sources or layers', () => {
    const dir = import.meta.dirname;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
      const src = readFileSync(join(dir, file), 'utf8');
      const hit = /GeoJsonLayer|@deck\.gl\/geo-layers|addSource\(|'geojson'|FeatureCollection/.exec(
        src,
      );
      expect({ file, hit: hit?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it('gives deck.gl a new data object per frame and leaves untouched layers alone', () => {
    const { overlay, adapter } = setup();
    adapter.createLayer('planes', {});
    adapter.createLayer('airports', { zIndex: -1 });
    const planes = new FrameFixture('planes');
    planes.set(0, 'a', 1, 1);
    const airports = new FrameFixture('airports');
    airports.set(0, 'TLV', 34.88, 32.01);
    adapter.applyFrame(airports.frame());
    adapter.applyFrame(planes.frame());
    expect(overlay.layers.map((l) => l.id)).toEqual(['airports', 'planes']);

    const airportLayer = overlay.byId('airports');
    const firstData = overlay.byId('planes')!.props.data;
    planes.set(0, 'a', 1.5, 1);
    adapter.applyFrame(planes.frame());
    expect(overlay.byId('planes')!.props.data).not.toBe(firstData);
    expect(overlay.byId('airports')).toBe(airportLayer);
  });

  it('uses an IconLayer when the style has icons, one icon def per code', () => {
    const { overlay, adapter } = setup();
    adapter.createLayer('planes', { icons: ['a.png', 'b.png'], iconSize: 24 });
    const f = new FrameFixture('planes');
    f.set(0, 'a', 1, 1, 0, 1);
    f.set(1, 'b', 2, 2, 0, 0);
    adapter.applyFrame(f.frame());
    const layer = overlay.byId('planes');
    expect(layer).toBeInstanceOf(IconLayer);
    const getIcon = (
      layer!.props as unknown as { getIcon: (o: unknown, c: { index: number }) => { url: string } }
    ).getIcon;
    expect(getIcon(null, { index: 0 }).url).toBe('b.png');
    expect(getIcon(null, { index: 1 }).url).toBe('a.png');
    expect(getIcon(null, { index: 0 })).toBe(getIcon(null, { index: 0 }));
  });

  it('pick returns the entity id through the slot table after updates and removals', () => {
    const { overlay, adapter } = setup();
    adapter.createLayer('planes', {});
    const f = new FrameFixture('planes');
    for (let i = 0; i < 20; i++) f.set(i, `p${i}`, i, 0);
    adapter.applyFrame(f.frame());
    f.remove(0);
    f.remove(5);
    f.set(5, 'reused-5', 5, 5);
    f.remove(10);
    adapter.applyFrame(f.frame());

    // Visible slots now 1..9 then 11..19: instance 4 is slot 5, instance 9 is slot 11.
    overlay.nextPick = { layerId: 'planes', index: 4 };
    expect(adapter.pick(10, 20)).toBe('reused-5');
    expect(overlay.pickCalls.at(-1)).toMatchObject({ x: 10, y: 20, layerIds: ['planes'] });
    overlay.nextPick = { layerId: 'planes', index: 9 };
    expect(adapter.pick(0, 0)).toBe('p11');
    overlay.nextPick = null;
    expect(adapter.pick(0, 0)).toBeNull();
  });

  it('enables picking only on pickable layers and skips picking when none are', () => {
    const { overlay, adapter } = setup();
    adapter.createLayer('bg', { pickable: false });
    const f = new FrameFixture('bg');
    f.set(0, 'x', 0, 0);
    f.labels.set(0, 'X');
    adapter.applyFrame(f.frame());
    expect(overlay.byId('bg')!.props.pickable).toBe(false);
    expect(overlay.byId('bg:labels')!.props.pickable).toBe(false);
    expect(adapter.pick(1, 1)).toBeNull();
    expect(overlay.pickCalls).toHaveLength(0);

    adapter.createLayer('planes', {});
    const p = new FrameFixture('planes');
    p.set(0, 'a', 0, 0);
    adapter.applyFrame(p.frame());
    adapter.pick(1, 1);
    expect(overlay.pickCalls[0]!.layerIds).toEqual(['planes']);
  });

  it('destroy clears the overlay and ignores later frames', () => {
    const { overlay, adapter } = setup();
    const f = new FrameFixture('planes');
    f.set(0, 'a', 0, 0);
    adapter.applyFrame(f.frame());
    expect(overlay.layers).toHaveLength(1);
    adapter.destroy();
    expect(overlay.layers).toHaveLength(0);
    adapter.applyFrame(f.frame());
    expect(overlay.layers).toHaveLength(0);
    expect(adapter.pick(0, 0)).toBeNull();
  });
});

describe('style parsing', () => {
  it('parses CSS colors', () => {
    const fb: [number, number, number, number] = [1, 2, 3, 4];
    expect(parseColor('#4fc3f7', fb)).toEqual([79, 195, 247, 255]);
    expect(parseColor('#f00', fb)).toEqual([255, 0, 0, 255]);
    expect(parseColor('#ff000080', fb)).toEqual([255, 0, 0, 128]);
    expect(parseColor('rgba(10, 20, 30, 0.5)', fb)).toEqual([10, 20, 30, 128]);
    expect(parseColor('rgb(10 20 30)', fb)).toEqual([10, 20, 30, 255]);
    expect(parseColor('papayawhip', fb)).toBe(fb);
    expect(parseColor(undefined, fb)).toBe(fb);
  });

  it('parses label fonts', () => {
    expect(parseFont('bold 14px Inter, sans-serif')).toEqual({
      size: 14,
      family: 'Inter, sans-serif',
    });
    expect(parseFont(undefined)).toEqual({ size: 12, family: 'sans-serif' });
  });
});
