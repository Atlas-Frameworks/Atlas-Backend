/**
 * The map adapter boundary (contracts §7). The SDK produces {@link MapFrame}s; an adapter
 * (Cesium in @atlas/map-cesium, deck.gl in @atlas/map-deckgl) draws them. Adapters read the
 * typed arrays directly and never turn entities into objects.
 */

export interface MapFrame {
  layerId: string;
  /** Slots in use: entries `0 .. count-1` of every array are valid (hidden ones have `visible = 0`). */
  count: number;
  /** slot -> entity id (stable slots; `''` for a free slot). */
  ids: string[];
  /** lon, lat, alt per slot (degrees, degrees, metres). */
  positions: Float64Array;
  icons: Uint16Array;
  visible: Uint8Array;
  /** slot -> label, only for the labelled subset. */
  labels: Map<number, string>;
}

/**
 * How a layer is drawn. Contracts §7 names `LayerStyle` without fixing its fields; these are
 * the fields both adapters understand. Every field is optional.
 */
export interface LayerStyle {
  /** CSS color for points without an icon (default `#4fc3f7`). */
  color?: string;
  /** Point diameter in CSS pixels (default 6). */
  pixelSize?: number;
  /** Outline color and width in pixels (default none). */
  outlineColor?: string;
  outlineWidth?: number;
  /** Icon image URL per icon index (`MapFrame.icons`); registered once when the layer is created. */
  icons?: string[];
  /** Icon size in CSS pixels (default 20). */
  iconSize?: number;
  /** CSS font for labels (default `12px sans-serif`). */
  labelFont?: string;
  labelColor?: string;
  /** Whether `pick` considers this layer (default true). */
  pickable?: boolean;
  /** Draw order; higher is on top (default 0). */
  zIndex?: number;
}

export interface MapAdapter {
  createLayer(layerId: string, style: LayerStyle): void;
  applyFrame(frame: MapFrame): void;
  /** Entity id under the screen point, or null. */
  pick(screenX: number, screenY: number): string | null;
  destroy(): void;
}
