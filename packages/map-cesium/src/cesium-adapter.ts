/**
 * CesiumAdapter (C-05): draws SDK {@link MapFrame}s in a Cesium scene.
 *
 * Per frame it walks the slots once and only touches Cesium for what changed since the last
 * frame: visibility flips, moved positions (lon/lat/alt compared with the last drawn values) and
 * icon changes. Positions go through one scratch `Cartesian3` in double precision, so steady-state
 * frames allocate nothing per entity. Frame buffers are handed back to the worker after
 * `applyFrame` returns, so the adapter keeps its own copies of what it compares against.
 */
import type { LayerStyle, MapAdapter, MapFrame } from '@atlas/client-sdk';
import {
  Cartesian2,
  Cartesian3,
  Color,
  HorizontalOrigin,
  type Label,
  LabelCollection,
  PrimitiveCollection,
  VerticalOrigin,
} from 'cesium';
import {
  BillboardPointSet,
  BufferPointSet,
  type PointSet,
  type PointStyle,
  PrimitivePointSet,
  prop,
} from './point-sets.js';

/**
 * Which Cesium collection draws plain points. `'buffer'` is `BufferPointCollection`
 * (experimental, the default); `'primitive'` is `PointPrimitiveCollection`. Layers whose style
 * has icons always use `BillboardCollection`, because buffer points cannot draw images.
 */
export type PointCollectionKind = 'buffer' | 'primitive';

/** What the adapter needs from a Cesium `Scene` (a real `Scene` satisfies it). */
export interface CesiumSceneLike {
  readonly primitives: PrimitiveCollection;
  pick(windowPosition: Cartesian2): unknown;
  requestRender?(): void;
}

export interface CesiumAdapterOptions {
  /** Feature flag for plain point layers (default `'buffer'`). */
  points?: PointCollectionKind;
}

/** Counters for the last `applyFrame` (one object, updated in place). */
export interface ApplyFrameStats {
  layerId: string;
  count: number;
  /** Slots whose position was written to Cesium. */
  moved: number;
  /** Slots whose visibility flipped. */
  toggled: number;
  labels: number;
}

const DEFAULTS = {
  color: '#4fc3f7',
  pixelSize: 6,
  iconSize: 20,
  labelFont: '12px sans-serif',
  labelColor: '#ffffff',
};

interface Layer {
  readonly id: string;
  readonly style: LayerStyle;
  readonly pickable: boolean;
  readonly zIndex: number;
  /** Holds this layer's points and labels, so z-order is one move. */
  readonly group: PrimitiveCollection;
  readonly points: PointSet;
  readonly labels: LabelCollection;
  /** slot -> label; labels are hidden, never removed, when a slot loses its label. */
  readonly labelBySlot: Map<number, Label>;
  /** slot -> entity id as of the last applied frame. */
  ids: string[];
  count: number;
  /** Last drawn lon/lat/alt per slot (NaN = never drawn). */
  drawn: Float64Array;
  shown: Uint8Array;
  icon: Uint16Array;
}

export class CesiumAdapter implements MapAdapter {
  /** Counters for the most recent frame (mutated in place). */
  readonly stats: ApplyFrameStats = { layerId: '', count: 0, moved: 0, toggled: 0, labels: 0 };
  readonly pointKind: PointCollectionKind;

  private readonly root = new PrimitiveCollection();
  private readonly layers = new Map<string, Layer>();
  private readonly scratch = new Cartesian3();
  private readonly scratchLabel = new Cartesian3();
  private readonly scratchWindow = new Cartesian2();
  private destroyed = false;

  constructor(
    private readonly scene: CesiumSceneLike,
    options: CesiumAdapterOptions = {},
  ) {
    this.pointKind = options.points ?? 'buffer';
    scene.primitives.add(this.root);
  }

  createLayer(layerId: string, style: LayerStyle): void {
    this.removeLayer(layerId);
    const pointStyle: PointStyle = {
      color: Color.fromCssColorString(style.color ?? DEFAULTS.color),
      pixelSize: style.pixelSize ?? DEFAULTS.pixelSize,
      outlineColor: Color.fromCssColorString(style.outlineColor ?? style.color ?? DEFAULTS.color),
      outlineWidth: style.outlineWidth ?? 0,
      icons: style.icons ?? [],
      iconSize: style.iconSize ?? DEFAULTS.iconSize,
    };
    const points: PointSet =
      pointStyle.icons.length > 0
        ? new BillboardPointSet(pointStyle)
        : this.pointKind === 'buffer'
          ? new BufferPointSet(pointStyle)
          : new PrimitivePointSet(pointStyle);
    const group = new PrimitiveCollection();
    const labels = new LabelCollection();
    group.add(points.primitive);
    group.add(labels);
    this.root.add(group);
    this.layers.set(layerId, {
      id: layerId,
      style,
      pickable: style.pickable ?? true,
      zIndex: style.zIndex ?? 0,
      group,
      points,
      labels,
      labelBySlot: new Map(),
      ids: [],
      count: 0,
      drawn: new Float64Array(0),
      shown: new Uint8Array(0),
      icon: new Uint16Array(0),
    });
    this.sortLayers();
  }

  applyFrame(frame: MapFrame): void {
    if (this.destroyed) return;
    let layer = this.layers.get(frame.layerId);
    if (!layer) {
      this.createLayer(frame.layerId, {});
      layer = this.layers.get(frame.layerId)!;
    }
    const count = frame.count;
    this.ensureSlots(layer, count);

    const { points, drawn, shown, icon } = layer;
    const { positions, visible, icons } = frame;
    const hasIcons = layer.style.icons !== undefined && layer.style.icons.length > 0;
    const scratch = this.scratch;
    let moved = 0;
    let toggled = 0;

    for (let slot = 0; slot < count; slot++) {
      const vis = visible[slot] === 1 ? 1 : 0;
      if (vis === 0) {
        if (shown[slot] === 1) {
          points.setShow(slot, false);
          shown[slot] = 0;
          toggled++;
        }
        // Hidden slots keep their last drawn position; it is compared again when shown.
        continue;
      }
      const p = slot * 3;
      const lon = positions[p]!;
      const lat = positions[p + 1]!;
      const alt = positions[p + 2]!;
      if (lon !== drawn[p] || lat !== drawn[p + 1] || alt !== drawn[p + 2]) {
        points.setPosition(slot, Cartesian3.fromDegrees(lon, lat, alt, undefined, scratch));
        drawn[p] = lon;
        drawn[p + 1] = lat;
        drawn[p + 2] = alt;
        moved++;
      }
      if (hasIcons) {
        const i = icons[slot]!;
        if (i !== icon[slot]) {
          points.setIcon(slot, i);
          icon[slot] = i;
        }
      }
      if (shown[slot] === 0) {
        points.setShow(slot, true);
        shown[slot] = 1;
        toggled++;
      }
    }
    // The layer shrank: hide the slots past the end.
    for (let slot = count; slot < layer.count; slot++) {
      if (shown[slot] === 1) {
        points.setShow(slot, false);
        shown[slot] = 0;
        toggled++;
      }
    }

    const ids = layer.ids;
    const src = frame.ids;
    ids.length = count;
    for (let slot = 0; slot < count; slot++) ids[slot] = src[slot] ?? '';
    layer.count = count;

    const labelled = this.applyLabels(layer, frame);

    const s = this.stats;
    s.layerId = layer.id;
    s.count = count;
    s.moved = moved;
    s.toggled = toggled;
    s.labels = labelled;
    this.scene.requestRender?.();
  }

  pick(screenX: number, screenY: number): string | null {
    if (this.destroyed) return null;
    const w = this.scratchWindow;
    w.x = screenX;
    w.y = screenY;
    return this.resolvePick(this.scene.pick(w));
  }

  /** Maps a `scene.pick` result to an entity id through the slot table (null if not ours). */
  resolvePick(picked: unknown): string | null {
    if (picked === undefined || picked === null) return null;
    for (const layer of this.layers.values()) {
      if (!layer.pickable) continue;
      let slot = layer.points.slotOf(picked);
      if (slot < 0) slot = labelSlot(layer, picked);
      if (slot < 0) continue;
      if (slot >= layer.count || layer.shown[slot] !== 1) return null;
      return layer.ids[slot] || null;
    }
    return null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.layers.clear();
    // Removing the root destroys it and, through it, every layer's collections.
    this.scene.primitives.remove(this.root);
  }

  private removeLayer(layerId: string): void {
    const old = this.layers.get(layerId);
    if (!old) return;
    this.layers.delete(layerId);
    this.root.remove(old.group);
  }

  private sortLayers(): void {
    const ordered = [...this.layers.values()].toSorted((a, b) => a.zIndex - b.zIndex);
    for (const l of ordered) this.root.raiseToTop(l.group);
  }

  private ensureSlots(layer: Layer, count: number): void {
    const points = layer.points;
    const before = points.primitive;
    if (points.ensureCapacity(count)) {
      // A rebuilt collection starts hidden and unpositioned: forget what was drawn.
      layer.group.remove(before);
      layer.group.add(points.primitive);
      layer.group.lowerToBottom(points.primitive);
      layer.drawn.fill(Number.NaN);
      layer.shown.fill(0);
      layer.icon.fill(0);
    }
    if (count <= layer.shown.length) return;
    let cap = Math.max(1024, layer.shown.length);
    while (cap < count) cap *= 2;
    const drawn = new Float64Array(cap * 3).fill(Number.NaN);
    drawn.set(layer.drawn);
    const shown = new Uint8Array(cap);
    shown.set(layer.shown);
    const icon = new Uint16Array(cap);
    icon.set(layer.icon);
    layer.drawn = drawn;
    layer.shown = shown;
    layer.icon = icon;
  }

  /** Shows a label for each visible labelled slot; hides labels for the rest. */
  private applyLabels(layer: Layer, frame: MapFrame): number {
    const { labelBySlot, labels } = layer;
    if (frame.labels.size === 0 && labelBySlot.size === 0) return 0;
    let shownLabels = 0;
    for (const [slot, label] of labelBySlot) {
      if (label.show && (!frame.labels.has(slot) || frame.visible[slot] !== 1)) label.show = false;
    }
    const style = layer.style;
    const pos = this.scratchLabel;
    const offsetY = -((style.iconSize ?? style.pixelSize ?? DEFAULTS.pixelSize) / 2 + 4);
    for (const [slot, text] of frame.labels) {
      if (slot >= frame.count || frame.visible[slot] !== 1) continue;
      const p = slot * 3;
      Cartesian3.fromDegrees(
        frame.positions[p]!,
        frame.positions[p + 1]!,
        frame.positions[p + 2],
        undefined,
        pos,
      );
      let label = labelBySlot.get(slot);
      if (!label) {
        label = labels.add({
          id: slot,
          text,
          position: pos,
          font: style.labelFont ?? DEFAULTS.labelFont,
          fillColor: Color.fromCssColorString(style.labelColor ?? DEFAULTS.labelColor),
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, offsetY),
        });
        labelBySlot.set(slot, label);
      } else {
        if (label.text !== text) label.text = text;
        if (!Cartesian3.equals(label.position, pos)) label.position = pos;
        if (!label.show) label.show = true;
      }
      shownLabels++;
    }
    return shownLabels;
  }
}

function labelSlot(layer: Layer, picked: unknown): number {
  const id = prop(picked, 'id');
  if (typeof id !== 'number') return -1;
  const label = layer.labelBySlot.get(id);
  return label !== undefined && prop(picked, 'primitive') === label ? id : -1;
}
