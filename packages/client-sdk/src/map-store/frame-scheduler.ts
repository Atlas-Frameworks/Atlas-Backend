import type { Clock } from '../core/clock.js';
import { FrameBuilder } from './frame.js';
import type { FrameBuffers, FrameBuilderOptions, WireMapFrame } from './frame.js';
import { LabelSelector } from './label-selector.js';
import type { Camera, LabelOptions } from './label-selector.js';
import { MapLayerStore } from './layer-store.js';
import type { LayerStoreOptions } from './layer-store.js';

export interface FrameSchedulerOptions extends FrameBuilderOptions, LabelOptions {
  /** Most frames per second per layer (default 10). */
  maxFps?: number;
}

interface Layer {
  store: MapLayerStore;
  builder: FrameBuilder;
  sentVersion: number;
  /** Something other than the data changed (labels, reset). */
  forced: boolean;
  /** Every buffer set is with the main thread; wait for release(). */
  blocked: boolean;
  lastEmit: number;
}

/**
 * Owns the map layers of the SDK and decides when each emits a frame: only when its data (or
 * its label subset) changed, at most `maxFps` per second, never while paused (hidden tab), and
 * never while all of its buffer sets are with the main thread.
 */
export class FrameScheduler {
  private readonly layers = new Map<string, Layer>();
  private readonly labels: LabelSelector;
  private timer: unknown = null;
  private timerAt = 0;
  private paused = false;
  private readonly intervalMs: number;

  constructor(
    private readonly clock: Clock,
    private readonly emit: (frame: WireMapFrame) => void,
    private readonly options: FrameSchedulerOptions = {},
  ) {
    this.intervalMs = 1_000 / Math.max(0.1, options.maxFps ?? 10);
    this.labels = new LabelSelector(options);
  }

  /** Creates the store for a map subscription; pass it as the subscription's handler. */
  addLayer(layerId: string, storeOptions: LayerStoreOptions = {}): MapLayerStore {
    this.removeLayer(layerId);
    const store = new MapLayerStore(layerId, {
      ...storeOptions,
      onChange: () => {
        storeOptions.onChange?.();
        this.schedule();
      },
    });
    const builder = new FrameBuilder(store, this.labels, this.options);
    this.layers.set(layerId, {
      store,
      builder,
      sentVersion: -1,
      forced: true,
      blocked: false,
      lastEmit: -Infinity,
    });
    this.schedule();
    return store;
  }

  removeLayer(layerId: string): void {
    this.layers.delete(layerId);
  }

  getStore(layerId: string): MapLayerStore | undefined {
    return this.layers.get(layerId)?.store;
  }

  /** Buffers returned by the main thread after rendering. */
  release(layerId: string, buffers: FrameBuffers): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    layer.builder.release(buffers);
    layer.blocked = false;
    if (this.isDue(layer)) this.schedule();
  }

  /** The main thread lost its slot tables (for example a new adapter): resend every id. */
  resetLayer(layerId: string): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    layer.builder.reset();
    layer.forced = true;
    this.schedule();
  }

  setCamera(camera: Camera | null): void {
    this.labels.camera = camera;
    this.forceAll();
  }

  setSelected(id: string | null): void {
    this.labels.selectedId = id;
    this.forceAll();
  }

  /** Hidden tab: stop emitting, keep applying data. Emits the latest state on resume. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.schedule();
  }

  /** Emits every due frame now, ignoring the rate limit (tests and benchmarks). */
  flushNow(): void {
    this.cancelTimer();
    for (const layer of this.layers.values()) this.emitLayer(layer);
  }

  private forceAll(): void {
    for (const layer of this.layers.values()) layer.forced = true;
    this.schedule();
  }

  private isDue(layer: Layer): boolean {
    return layer.forced || layer.store.version !== layer.sentVersion;
  }

  private schedule(): void {
    if (this.paused) return;
    const now = this.clock.now();
    let at = Infinity;
    for (const layer of this.layers.values()) {
      if (!this.isDue(layer) || layer.blocked) continue;
      at = Math.min(at, Math.max(now, layer.lastEmit + this.intervalMs));
    }
    if (at === Infinity) return;
    if (this.timer !== null && this.timerAt <= at) return;
    this.cancelTimer();
    this.timerAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, at - now);
  }

  private tick(): void {
    if (this.paused) return;
    const now = this.clock.now();
    for (const layer of this.layers.values()) {
      if (now >= layer.lastEmit + this.intervalMs) this.emitLayer(layer);
    }
    this.schedule();
  }

  private emitLayer(layer: Layer): void {
    if (!this.isDue(layer)) return;
    const frame = layer.builder.build();
    if (!frame) {
      layer.blocked = true; // all buffers busy: retried on release()
      return;
    }
    layer.sentVersion = layer.store.version;
    layer.forced = false;
    layer.lastEmit = this.clock.now();
    this.emit(frame);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
