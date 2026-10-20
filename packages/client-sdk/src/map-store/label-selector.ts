import type { MapLayerStore } from './layer-store.js';

export interface Camera {
  lon: number;
  lat: number;
  /** Camera height above ground in metres (Cesium) or an equivalent; optional. */
  height?: number;
}

export interface LabelOptions {
  /** Most labels per frame (default 500). */
  maxLabels?: number;
  /**
   * Above this camera height only the selected entity is labelled (default 2 000 km). Below
   * it, the entities nearest the camera point are labelled.
   */
  zoomThresholdM?: number;
}

/**
 * Chooses the small subset of entities that get labels: the selected entity, then the ones
 * nearest the camera point (when zoomed in far enough), at most `maxLabels`.
 *
 * Nearest-N uses a fixed-size max-heap in typed arrays: no allocation per frame.
 */
export class LabelSelector {
  readonly maxLabels: number;
  readonly zoomThresholdM: number;
  camera: Camera | null = null;
  selectedId: string | null = null;
  private readonly heapDist: Float64Array;
  private readonly heapSlot: Int32Array;
  private heapSize = 0;

  constructor(options: LabelOptions = {}) {
    this.maxLabels = options.maxLabels ?? 500;
    this.zoomThresholdM = options.zoomThresholdM ?? 2_000_000;
    this.heapDist = new Float64Array(this.maxLabels);
    this.heapSlot = new Int32Array(this.maxLabels);
  }

  /**
   * Writes the chosen slots and texts into `slots` / `texts` (reused arrays) and returns how
   * many were written.
   */
  select(store: MapLayerStore, slots: Uint32Array, texts: string[]): number {
    const max = Math.min(this.maxLabels, slots.length);
    let n = 0;
    let selectedSlot = -1;
    if (this.selectedId !== null && max > 0) {
      const slot = store.slotOfId(this.selectedId);
      const text = slot === undefined ? undefined : store.labels.get(slot);
      if (slot !== undefined && text !== undefined && store.visible[slot] === 1) {
        slots[0] = slot;
        texts[0] = text;
        n = 1;
        selectedSlot = slot;
      }
    }
    const cam = this.camera;
    const zoomedIn =
      cam !== null && (cam.height === undefined || cam.height <= this.zoomThresholdM);
    if (!zoomedIn || n >= max) return this.finish(texts, n);

    // Nearest (max - n) labelled, visible entities by equirectangular distance.
    const k = max - n;
    this.heapSize = 0;
    const cosLat = Math.cos((cam.lat * Math.PI) / 180);
    const pos = store.positions;
    const visible = store.visible;
    for (const slot of store.labels.keys()) {
      if (slot === selectedSlot || visible[slot] !== 1) continue;
      let dLon = Math.abs(pos[slot * 3]! - cam.lon);
      if (dLon > 180) dLon = 360 - dLon;
      const dx = dLon * cosLat;
      const dy = pos[slot * 3 + 1]! - cam.lat;
      this.offer(dx * dx + dy * dy, slot, k);
    }
    for (let i = 0; i < this.heapSize; i++) {
      const slot = this.heapSlot[i]!;
      slots[n] = slot;
      texts[n] = store.labels.get(slot) ?? '';
      n++;
    }
    return this.finish(texts, n);
  }

  private finish(texts: string[], n: number): number {
    texts.length = n;
    return n;
  }

  /** Keeps the k smallest distances in a max-heap. */
  private offer(dist: number, slot: number, k: number): void {
    const d = this.heapDist;
    const s = this.heapSlot;
    if (this.heapSize < k) {
      let i = this.heapSize++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (d[parent]! >= dist) break;
        d[i] = d[parent]!;
        s[i] = s[parent]!;
        i = parent;
      }
      d[i] = dist;
      s[i] = slot;
      return;
    }
    if (dist >= d[0]!) return;
    // Replace the root (largest) and sift down.
    let i = 0;
    const size = this.heapSize;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      const r = l + 1;
      const c = r < size && d[r]! > d[l]! ? r : l;
      if (d[c]! <= dist) break;
      d[i] = d[c]!;
      s[i] = s[c]!;
      i = c;
    }
    d[i] = dist;
    s[i] = slot;
  }
}
