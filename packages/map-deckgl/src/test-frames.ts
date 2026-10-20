import type { MapFrame } from '@atlas/client-sdk';

/**
 * A mutable MapFrame shaped like the SDK's: stable slots, a reused slot -> id table, hidden
 * slots with `visible = 0`. Test helper only (not exported from the package).
 */
export class FrameFixture {
  readonly ids: string[] = [];
  positions: Float64Array;
  icons: Uint16Array;
  visible: Uint8Array;
  readonly labels = new Map<number, string>();
  count = 0;

  constructor(
    readonly layerId: string,
    capacity = 16,
  ) {
    this.positions = new Float64Array(capacity * 3);
    this.icons = new Uint16Array(capacity);
    this.visible = new Uint8Array(capacity);
  }

  /** Puts `id` in `slot` (growing the arrays if needed). */
  set(slot: number, id: string, lon: number, lat: number, alt = 0, icon = 0): void {
    if (slot >= this.icons.length) {
      const cap = Math.max(slot + 1, this.icons.length * 2);
      const p = new Float64Array(cap * 3);
      p.set(this.positions);
      const i = new Uint16Array(cap);
      i.set(this.icons);
      const v = new Uint8Array(cap);
      v.set(this.visible);
      this.positions = p;
      this.icons = i;
      this.visible = v;
    }
    this.ids[slot] = id;
    this.positions[slot * 3] = lon;
    this.positions[slot * 3 + 1] = lat;
    this.positions[slot * 3 + 2] = alt;
    this.icons[slot] = icon;
    this.visible[slot] = 1;
    if (slot >= this.count) {
      for (let s = this.count; s < slot; s++) this.ids[s] ??= '';
      this.count = slot + 1;
    }
  }

  /** Frees a slot the way the SDK does: hidden, id cleared. */
  remove(slot: number): void {
    this.visible[slot] = 0;
    this.ids[slot] = '';
    this.labels.delete(slot);
  }

  frame(): MapFrame {
    return {
      layerId: this.layerId,
      count: this.count,
      ids: this.ids,
      positions: this.positions,
      icons: this.icons,
      visible: this.visible,
      labels: this.labels,
    };
  }
}
