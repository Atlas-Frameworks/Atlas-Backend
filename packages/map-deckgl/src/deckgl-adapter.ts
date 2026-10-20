import type { LayerStyle, MapAdapter, MapFrame } from '@atlas/client-sdk';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { parseColor, type Rgba } from './color.js';
import { LayerBuffers, type BufferSet, type LabelSet } from './layer-buffers.js';

/** The part of a MapLibre or Mapbox GL `Map` the adapter uses. */
export interface OverlayHost {
  addControl(control: MapboxOverlay): unknown;
  removeControl(control: MapboxOverlay): unknown;
}

/** The part of {@link MapboxOverlay} the adapter uses (a fake one in tests). */
export interface DeckOverlay {
  setProps(props: { layers: Layer[] }): void;
  pickObject(opts: {
    x: number;
    y: number;
    radius?: number;
    layerIds?: string[];
  }): PickingInfo | null;
}

export interface DeckGlAdapterOptions {
  /**
   * Draw inside the map's WebGL context, in its layer stack (MapLibre / Mapbox v2+), instead of
   * on a canvas above it. Default false.
   */
  interleaved?: boolean;
  /** Pick tolerance in CSS pixels (default 3). */
  pickRadius?: number;
  /** Extra `MapboxOverlay` props (e.g. `useDevicePixels`). */
  overlayProps?: Omit<MapboxOverlayProps, 'layers' | 'interleaved'>;
  /** Replaces the `MapboxOverlay`; used by tests, which have no WebGL. */
  overlay?: DeckOverlay;
}

interface IconDef {
  id: string;
  url: string;
  width: number;
  height: number;
  mask: boolean;
}

interface LayerEntry {
  id: string;
  style: LayerStyle;
  buffers: LayerBuffers;
  fill: Rgba;
  outline: Rgba;
  labelColor: Rgba;
  labelSize: number;
  labelFamily: string;
  pickable: boolean;
  zIndex: number;
  order: number;
  /** One def per icon code, created once; `getIcon` returns these (no per-entity objects). */
  iconDefs: IconDef[] | null;
  /** Layers built from the last applied frame; rebuilt only when that layer gets a frame. */
  points: Layer | null;
  labels: Layer | null;
}

const DEFAULT_COLOR: Rgba = [79, 195, 247, 255];
const DEFAULT_LABEL_COLOR: Rgba = [255, 255, 255, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];
const ICON_PX = 64;

/**
 * {@link MapAdapter} drawing with deck.gl on MapLibre or Mapbox GL (both accept the same
 * `MapboxOverlay` control). Points are a `ScatterplotLayer`, or an `IconLayer` when the style has
 * icons, fed binary attributes built from the frame's typed arrays (no GeoJSON source, no object
 * per entity); labels are a `TextLayer` over the labelled subset only.
 */
export class DeckGlAdapter implements MapAdapter {
  private readonly overlay: DeckOverlay;
  private readonly owned: MapboxOverlay | null;
  private readonly layers = new Map<string, LayerEntry>();
  private readonly pickRadius: number;
  private nextOrder = 0;
  private destroyed = false;

  constructor(
    private readonly map: OverlayHost | null,
    options: DeckGlAdapterOptions = {},
  ) {
    this.pickRadius = options.pickRadius ?? 3;
    if (options.overlay) {
      this.overlay = options.overlay;
      this.owned = null;
    } else {
      const overlay = new MapboxOverlay({
        ...options.overlayProps,
        interleaved: options.interleaved ?? false,
        layers: [],
      });
      this.owned = overlay;
      this.overlay = overlay;
      map?.addControl(overlay);
    }
  }

  createLayer(layerId: string, style: LayerStyle): void {
    const font = parseFont(style.labelFont);
    const icons = style.icons?.length ? style.icons : null;
    this.layers.set(layerId, {
      id: layerId,
      style,
      buffers: this.layers.get(layerId)?.buffers ?? new LayerBuffers(),
      fill: parseColor(style.color, DEFAULT_COLOR),
      outline: parseColor(style.outlineColor, TRANSPARENT),
      labelColor: parseColor(style.labelColor, DEFAULT_LABEL_COLOR),
      labelSize: font.size,
      labelFamily: font.family,
      pickable: style.pickable ?? true,
      zIndex: style.zIndex ?? 0,
      order: this.nextOrder++,
      iconDefs: icons
        ? icons.map((url, i) => ({
            id: `${layerId}#${i}`,
            url,
            width: ICON_PX,
            height: ICON_PX,
            mask: false,
          }))
        : null,
      points: null,
      labels: null,
    });
  }

  applyFrame(frame: MapFrame): void {
    if (this.destroyed) return;
    let entry = this.layers.get(frame.layerId);
    if (!entry) {
      this.createLayer(frame.layerId, {});
      entry = this.layers.get(frame.layerId)!;
    }
    entry.buffers.apply(frame);
    entry.points = this.pointLayer(entry, entry.buffers.current);
    entry.labels = this.labelLayer(entry, entry.buffers.currentLabels);
    this.render();
  }

  pick(screenX: number, screenY: number): string | null {
    if (this.destroyed) return null;
    const layerIds: string[] = [];
    for (const entry of this.layers.values())
      if (entry.pickable && entry.points) layerIds.push(entry.id);
    if (layerIds.length === 0) return null;
    const info = this.overlay.pickObject({
      x: screenX,
      y: screenY,
      radius: this.pickRadius,
      layerIds,
    });
    const layer = info?.layer;
    if (!info || !layer) return null;
    const entry = this.layers.get(layer.id);
    return entry ? entry.buffers.idAt(layer.props.data, info.index) : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.layers.clear();
    if (this.owned) {
      this.map?.removeControl(this.owned);
      this.owned.finalize();
    } else {
      this.overlay.setProps({ layers: [] });
    }
  }

  private render(): void {
    const sorted = [...this.layers.values()].toSorted(
      (a, b) => a.zIndex - b.zIndex || a.order - b.order,
    );
    const layers: Layer[] = [];
    for (const e of sorted) if (e.points) layers.push(e.points);
    // Labels above every point layer, so a higher layer's points never hide another's labels.
    for (const e of sorted) if (e.labels) layers.push(e.labels);
    this.overlay.setProps({ layers });
  }

  private pointLayer(entry: LayerEntry, set: BufferSet): Layer {
    const { style } = entry;
    const common = {
      id: entry.id,
      // Binary data: a new `data` object (the other buffer set) per frame makes deck.gl re-upload.
      data: set.data,
      pickable: entry.pickable,
      // Frames replace positions wholesale; no interpolation between them.
      transitions: {},
      parameters: { depthCompare: 'always' as const },
    };
    if (entry.iconDefs) {
      const defs = entry.iconDefs;
      const icons = set.icons;
      return new IconLayer({
        ...common,
        getIcon: (_: unknown, { index }: { index: number }) => defs[icons[index]!] ?? defs[0]!,
        getSize: style.iconSize ?? 20,
        sizeUnits: 'pixels',
        updateTriggers: { getIcon: entry.buffers.version },
      });
    }
    const outlineWidth = style.outlineWidth ?? 0;
    return new ScatterplotLayer({
      ...common,
      radiusUnits: 'pixels',
      getRadius: (style.pixelSize ?? 6) / 2,
      getFillColor: entry.fill,
      stroked: outlineWidth > 0,
      lineWidthUnits: 'pixels',
      getLineWidth: outlineWidth,
      getLineColor: entry.outline,
    });
  }

  private labelLayer(entry: LayerEntry, labels: LabelSet): Layer | null {
    if (labels.data.length === 0) return null;
    const { positions, texts } = labels;
    const pos: [number, number, number] = [0, 0, 0];
    return new TextLayer({
      id: `${entry.id}:labels`,
      data: labels.data,
      pickable: false,
      getText: (_: unknown, { index }: { index: number }) => texts[index] ?? '',
      // deck.gl copies the value out at once, so one reused tuple serves every label.
      getPosition: (_: unknown, { index }: { index: number }) => {
        pos[0] = positions[index * 3]!;
        pos[1] = positions[index * 3 + 1]!;
        pos[2] = positions[index * 3 + 2]!;
        return pos;
      },
      getColor: entry.labelColor,
      getSize: entry.labelSize,
      sizeUnits: 'pixels',
      fontFamily: entry.labelFamily,
      characterSet: 'auto',
      getTextAnchor: 'start',
      getAlignmentBaseline: 'center',
      getPixelOffset: [((entry.style.pixelSize ?? 6) >> 1) + 4, 0],
      outlineWidth: 2,
      outlineColor: [0, 0, 0, 200],
      fontSettings: { sdf: true },
      parameters: { depthCompare: 'always' as const },
      updateTriggers: { getText: entry.buffers.version, getPosition: entry.buffers.version },
    });
  }
}

/** `"12px sans-serif"` -> size 12, family `sans-serif` (CSS shorthand; weight/style ignored). */
export function parseFont(font: string | undefined): { size: number; family: string } {
  const m = font ? /(\d+(?:\.\d+)?)px\s+(.+)$/.exec(font.trim()) : null;
  return m ? { size: Number(m[1]), family: m[2]!.trim() } : { size: 12, family: 'sans-serif' };
}
