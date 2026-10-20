import { POSITION_STRIDE } from '@atlas/protocol';
import type { MapFrame } from '../adapters/map-adapter.js';
import type { LabelSelector } from './label-selector.js';
import type { MapLayerStore } from './layer-store.js';

/** The typed arrays of one frame; transferred to the main thread and returned after rendering. */
export interface FrameBuffers {
  positions: Float64Array<ArrayBuffer>;
  icons: Uint16Array<ArrayBuffer>;
  visible: Uint8Array<ArrayBuffer>;
  /** Slots whose id changed (first `idCount` entries valid). */
  idSlots: Uint32Array<ArrayBuffer>;
  /** Labelled slots (first `labelCount` entries valid). */
  labelSlots: Uint32Array<ArrayBuffer>;
}

/**
 * A frame as it crosses the Worker boundary. Unlike {@link MapFrame}, ids travel as changes
 * only (the main side keeps the slot table), and labels as two parallel arrays.
 */
export interface WireMapFrame {
  layerId: string;
  frameNo: number;
  count: number;
  buffers: FrameBuffers;
  /** True when the receiver must drop its slot table first (first frame, or after a reset). */
  idReset: boolean;
  idCount: number;
  /** New id per changed slot, parallel to `buffers.idSlots`; `''` = slot freed. */
  idTexts: string[];
  labelCount: number;
  labelTexts: string[];
}

/** The ArrayBuffers to transfer with `postMessage`. */
export function frameTransferables(buffers: FrameBuffers): ArrayBuffer[] {
  return [
    buffers.positions.buffer,
    buffers.icons.buffer,
    buffers.visible.buffer,
    buffers.idSlots.buffer,
    buffers.labelSlots.buffer,
  ];
}

export interface FrameBuilderOptions {
  /** Buffer sets per layer in rotation (default 3). */
  maxBuffers?: number;
  maxLabels?: number;
}

/**
 * Builds frames for one layer from its store into a small pool of reused buffer sets. A set
 * is busy from {@link build} until {@link release}; when every set is busy, `build` returns
 * null and the caller retries after a release. Nothing is allocated per frame except when the
 * store has grown.
 */
export class FrameBuilder {
  private readonly pool: FrameBuffers[] = [];
  private allocated = 0;
  private capacity = 0;
  private frameNo = 0;
  private needReset = true;
  private readonly maxBuffers: number;
  private readonly maxLabels: number;
  private readonly idTexts: string[] = [];
  private readonly labelTexts: string[] = [];

  constructor(
    readonly store: MapLayerStore,
    readonly labels: LabelSelector,
    options: FrameBuilderOptions = {},
  ) {
    this.maxBuffers = Math.max(1, options.maxBuffers ?? 3);
    this.maxLabels = options.maxLabels ?? labels.maxLabels;
  }

  /** Buffer sets currently with the main thread. */
  get inFlight(): number {
    return this.allocated - this.pool.length;
  }

  /** The next frame, or null when every buffer set is still with the main thread. */
  build(): WireMapFrame | null {
    const store = this.store;
    if (store.capacity !== this.capacity) {
      // The store grew: older sets are too small. Drop the idle ones; busy ones are dropped on return.
      this.allocated -= this.pool.length;
      this.pool.length = 0;
      this.capacity = store.capacity;
    }
    let buffers = this.pool.pop();
    if (!buffers) {
      if (this.allocated >= this.maxBuffers) return null;
      buffers = this.allocate();
    }
    const count = store.count;
    buffers.positions.set(store.positions.subarray(0, count * POSITION_STRIDE));
    buffers.icons.set(store.icons.subarray(0, count));
    buffers.visible.set(store.visible.subarray(0, count));

    const idTexts = this.idTexts;
    let idCount = 0;
    const idReset = this.needReset;
    if (idReset) {
      store.drainIdChanges(() => {});
      for (let slot = 0; slot < count; slot++) {
        buffers.idSlots[idCount] = slot;
        idTexts[idCount++] = store.ids[slot] ?? '';
      }
      this.needReset = false;
    } else {
      idCount = store.drainIdChanges((slot, id) => {
        buffers.idSlots[idCount] = slot;
        idTexts[idCount++] = id;
      });
    }
    idTexts.length = idCount;

    const labelCount = this.labels.select(store, buffers.labelSlots, this.labelTexts);
    store.frameSent();
    return {
      layerId: store.layerId,
      frameNo: ++this.frameNo,
      count,
      buffers,
      idReset,
      idCount,
      idTexts,
      labelCount,
      labelTexts: this.labelTexts,
    };
  }

  /** A buffer set came back from the main thread. */
  release(buffers: FrameBuffers): void {
    if (buffers.icons.length !== this.capacity) {
      this.allocated--; // from before the store grew
      return;
    }
    this.pool.push(buffers);
  }

  /** The receiver lost its slot table (e.g. a new adapter): the next frame resends all ids. */
  reset(): void {
    this.needReset = true;
  }

  private allocate(): FrameBuffers {
    this.allocated++;
    const cap = this.capacity;
    return {
      positions: new Float64Array(cap * POSITION_STRIDE),
      icons: new Uint16Array(cap),
      visible: new Uint8Array(cap),
      idSlots: new Uint32Array(cap),
      labelSlots: new Uint32Array(this.maxLabels),
    };
  }
}

/**
 * Main-thread side: keeps the slot -> id table per layer and turns wire frames into the
 * {@link MapFrame}s adapters consume. The returned frame's `ids` and `labels` are reused and
 * updated by the next frame.
 */
export class MapFrameAssembler {
  readonly ids: string[] = [];
  private readonly labels = new Map<number, string>();

  assemble(w: WireMapFrame): MapFrame {
    const ids = this.ids;
    if (w.idReset) ids.length = 0;
    const slots = w.buffers.idSlots;
    for (let i = 0; i < w.idCount; i++) ids[slots[i]!] = w.idTexts[i] ?? '';
    for (let i = ids.length; i < w.count; i++) ids[i] = '';
    const labels = this.labels;
    labels.clear();
    const ls = w.buffers.labelSlots;
    for (let i = 0; i < w.labelCount; i++) labels.set(ls[i]!, w.labelTexts[i] ?? '');
    return {
      layerId: w.layerId,
      count: w.count,
      ids,
      positions: w.buffers.positions,
      icons: w.buffers.icons,
      visible: w.buffers.visible,
      labels,
    };
  }
}
