import type { MapFrame } from '../adapters/map-adapter.js';

export interface SyntheticFramesOptions {
  layerId: string;
  /** Entities (default 30,000). */
  entities?: number;
  /** Position updates per second, spread over the frames (default 6,000). */
  updatesPerSecond?: number;
  /** Share of updates that remove an entity; a new one takes the slot a frame later (default 0.01). */
  churn?: number;
  /** The first `labels` slots are labelled with their id (default 200). */
  labels?: number;
  /** Random source in [0, 1) (default `Math.random`). */
  random?: () => number;
}

/**
 * A map benchmark source shaped like the SDK's frames: stable slots, a reused slot -> id table,
 * removed entities hidden with their id cleared, and a freed slot reused (by a new id) only in
 * the following frame. Entities move along fixed headings. Used by the C-05 / C-06 bench pages
 * and the app's `/dev/map-bench` route; the caller decides the frame rate.
 */
export class SyntheticFrames {
  /** The one frame object, mutated in place by {@link step}. */
  readonly frame: MapFrame;
  private readonly heading: Float32Array;
  private readonly random: () => number;
  private readonly ups: number;
  private readonly churn: number;
  private readonly labelled: number;
  private free: number[] = [];
  private freedThisFrame: number[] = [];
  private nextId = 0;
  private budget = 0;

  constructor(options: SyntheticFramesOptions) {
    const n = options.entities ?? 30_000;
    this.random = options.random ?? Math.random;
    this.ups = options.updatesPerSecond ?? 6_000;
    this.churn = options.churn ?? 0.01;
    this.labelled = options.labels ?? 200;
    this.frame = {
      layerId: options.layerId,
      count: n,
      ids: Array.from({ length: n }, () => ''),
      positions: new Float64Array(n * 3),
      icons: new Uint16Array(n),
      visible: new Uint8Array(n),
      labels: new Map(),
    };
    this.heading = new Float32Array(n);
    for (let slot = 0; slot < n; slot++) this.spawn(slot);
  }

  /**
   * Applies `elapsedMs` worth of updates (at most one second's) and returns the frame. Slots
   * freed by the previous step get new entities first.
   */
  step(elapsedMs: number): MapFrame {
    const f = this.frame;
    const random = this.random;
    this.budget = Math.min(this.ups, this.budget + (this.ups * elapsedMs) / 1000);
    for (const slot of this.free) this.spawn(slot);
    this.free.length = 0;
    for (; this.budget >= 1; this.budget--) {
      const slot = (random() * f.count) | 0;
      if (f.visible[slot] !== 1) continue;
      if (random() < this.churn) {
        f.visible[slot] = 0;
        f.ids[slot] = '';
        f.labels.delete(slot);
        this.freedThisFrame.push(slot);
        continue;
      }
      const h = this.heading[slot]!;
      const p = slot * 3;
      f.positions[p] = ((f.positions[p]! + 0.05 * Math.sin(h) + 540) % 360) - 180;
      f.positions[p + 1] = Math.max(-85, Math.min(85, f.positions[p + 1]! + 0.05 * Math.cos(h)));
    }
    // Swap the lists instead of copying: freed now, reusable next step.
    const t = this.free;
    this.free = this.freedThisFrame;
    this.freedThisFrame = t;
    return f;
  }

  private spawn(slot: number): void {
    const f = this.frame;
    const random = this.random;
    const id = `plane-${this.nextId++}`;
    f.ids[slot] = id;
    f.positions[slot * 3] = random() * 360 - 180;
    f.positions[slot * 3 + 1] = Math.asin(random() * 2 - 1) * (180 / Math.PI) * 0.95;
    f.positions[slot * 3 + 2] = 10_000;
    f.icons[slot] = random() < 0.8 ? 0 : 1;
    f.visible[slot] = 1;
    this.heading[slot] = random() * Math.PI * 2;
    if (slot < this.labelled) f.labels.set(slot, id);
  }
}
