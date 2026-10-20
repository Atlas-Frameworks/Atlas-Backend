import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  afterEveryRender,
  afterNextRender,
  computed,
  effect,
  inject,
  isDevMode,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { Camera, LayerStyle, MapAdapter, MapFrame, MapLayerHandle } from '@atlas/client-sdk';
import { ATLAS_ENV } from '../config/environment';
import { clockTime } from '../workspace/connection-status';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import type { LiveView } from '../realtime/atlas-realtime.service';
import { WorkspaceStore } from '../workspace/workspace.store';
import type { EntityRequest } from '../workspace/workspace.store';
import { MAP_ENGINE_FACTORY } from './map-engine';
import type { MapEngine } from './map-engine';

/** How often the camera goes to the SDK at most (label selection near the camera point). */
export const CAMERA_THROTTLE_MS = 250;
/** A fly-to whose entity is not on the map yet waits for it this long. */
const FLY_TO_WAIT_MS = 10_000;

const LAYER_STYLES: Record<string, LayerStyle> = {
  airplanes: { color: '#4fc3f7', pixelSize: 5, labelColor: '#ffe082', zIndex: 1 },
  airports: { color: '#ffb74d', pixelSize: 7 },
};
const DEFAULT_STYLE: LayerStyle = { color: '#b39ddb', pixelSize: 5 };

interface MapLayer {
  readonly view: LiveView;
  readonly handle: MapLayerHandle;
}

/** Counters for measuring that map frames cause no Angular work (exposed in dev mode). */
export interface MapViewCounters {
  /** Frames applied to the adapter. */
  frames: number;
  /** Angular application renders (change detection passes) seen by this component. */
  appRenders: number;
  /** Cesium renders. */
  mapRenders: number;
}

/**
 * The workspace map (A-03): a Cesium globe with one layer per live view in WorkspaceStore (layer
 * id = `view.handle.id`). Frames go from the SDK straight to the Cesium adapter; the render loop,
 * the frames and the camera all run outside Angular and write no signals. Signals are written
 * only on a user click (selection) and read for views, selection, fly-to and staleness.
 */
@Component({
  selector: 'app-map-view',
  template: `
    <div #globe class="globe"></div>
    @if (loadError(); as error) {
      <p class="notice error" role="alert">Map failed to load: {{ error }}</p>
    }
    @if (stale(); as s) {
      <div class="stale" role="status" aria-live="polite">
        <span class="badge">{{ s }}</span>
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      height: 100%;
    }

    .globe {
      position: absolute;
      inset: 0;
    }

    .stale {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: rgb(90 90 100 / 35%);
      backdrop-filter: grayscale(0.85);
    }

    .badge {
      position: absolute;
      top: var(--atlas-space-3);
      left: 50%;
      padding: var(--atlas-space-1) var(--atlas-space-3);
      font-size: var(--atlas-font-sm);
      color: var(--atlas-text-strong);
      background: var(--atlas-surface-overlay);
      border: 1px solid var(--atlas-stale);
      border-radius: var(--atlas-radius);
      transform: translateX(-50%);
    }

    .notice {
      position: absolute;
      top: 40%;
      width: 100%;
      text-align: center;
      color: var(--atlas-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapView {
  private readonly realtime = inject(AtlasRealtimeService);
  private readonly store = inject(WorkspaceStore);
  private readonly basemap = inject(ATLAS_ENV).basemap;
  private readonly createEngine = inject(MAP_ENGINE_FACTORY);
  private readonly zone = inject(NgZone);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('globe');

  /** Set once, when the (lazy-loaded) map is ready. */
  private readonly engine = signal<MapEngine | null>(null);
  protected readonly loadError = signal<string | null>(null);

  /** Badge text while data is stale or the connection is down, else null. */
  protected readonly stale = computed(() => {
    const connection = this.realtime.connectionStatus();
    if (connection === 'reconnecting' || connection === 'connecting')
      return 'Reconnecting… showing last known positions';
    const since = this.realtime.staleSince();
    return since === null ? null : `Stale since ${clockTime(since)}`;
  });

  /** Layers this component subscribed, by layer id. Plain state: never read by a template. */
  private readonly layers = new Map<string, MapLayer>();
  private pendingFlyTo: EntityRequest | null = null;
  readonly counters: MapViewCounters = { frames: 0, appRenders: 0, mapRenders: 0 };

  constructor() {
    const destroyRef = inject(DestroyRef);
    let destroyed = false;
    let teardown: (() => void) | null = null;
    destroyRef.onDestroy(() => {
      destroyed = true;
      teardown?.();
    });

    afterNextRender(() => {
      this.zone.runOutsideAngular(() => {
        this.createEngine(this.container().nativeElement, { basemap: this.basemap }).then(
          (engine) => {
            if (destroyed) {
              engine.destroy();
              return;
            }
            teardown = this.start(engine);
            this.engine.set(engine);
          },
          (error: unknown) => {
            console.error('map: failed to create the map', error);
            this.loadError.set(error instanceof Error ? error.message : String(error));
          },
        );
      });
    });

    // One layer per live view.
    effect(() => {
      const engine = this.engine();
      const views = this.store.views();
      if (engine) untracked(() => this.syncLayers(engine.adapter, views));
    });

    // The selected entity (map click or list row) is always labelled.
    effect(() => {
      const id = this.store.selected()?.id ?? null;
      untracked(() => this.realtime.setSelected(id));
    });

    effect(() => {
      const request = this.store.flyTo();
      const engine = this.engine();
      if (!request || !engine) return;
      this.pendingFlyTo = request;
      untracked(() => this.tryFlyTo(engine));
    });

    if (isDevMode()) {
      afterEveryRender(() => this.counters.appRenders++);
      Object.assign(globalThis, { atlasMap: this });
    }
  }

  /** Wires the engine to the SDK; returns the teardown. Runs outside Angular. */
  private start(engine: MapEngine): () => void {
    const adapter = engine.adapter;
    // The SDK calls applyFrame from its Worker message handler; nothing here touches signals.
    const sink: MapAdapter = {
      createLayer: (layerId, style) => adapter.createLayer(layerId, style),
      applyFrame: (frame) => {
        adapter.applyFrame(frame);
        this.counters.frames++;
        if (this.pendingFlyTo) this.tryFlyTo(engine);
      },
      pick: (x, y) => adapter.pick(x, y),
      destroy: () => adapter.destroy(),
    };
    const detach = this.realtime.attachMap(sink);
    const camera = throttle((c: Camera) => this.realtime.setCamera(c), CAMERA_THROTTLE_MS);
    const offCamera = engine.onCameraChange((c) => camera.call(c));
    const offClick = engine.onClick((x, y) => this.onMapClick(engine, x, y));
    const offRender = engine.onRender(() => this.counters.mapRenders++);
    return () => {
      offRender();
      offClick();
      offCamera();
      camera.cancel();
      detach();
      for (const layer of this.layers.values()) layer.handle.close();
      this.layers.clear();
      this.realtime.setCamera(null);
      engine.destroy();
    };
  }

  private syncLayers(adapter: MapAdapter, views: readonly LiveView[]): void {
    const wanted = new Map(views.map((v) => [v.handle.id, v]));
    for (const [layerId, layer] of this.layers) {
      if (wanted.get(layerId) === layer.view) continue;
      layer.handle.close();
      this.layers.delete(layerId);
      // MapAdapter has no removeLayer: an empty frame hides every point and label of the layer.
      adapter.applyFrame(emptyFrame(layerId));
    }
    for (const [layerId, view] of wanted) {
      if (this.layers.has(layerId)) continue;
      adapter.createLayer(layerId, LAYER_STYLES[view.handle.spec.entityType] ?? DEFAULT_STYLE);
      this.layers.set(layerId, { view, handle: this.realtime.subscribeMap(view, layerId) });
    }
  }

  private onMapClick(engine: MapEngine, x: number, y: number): void {
    const id = engine.adapter.pick(x, y);
    if (id === null) return;
    const layerId = engine.locate(id)?.layerId;
    const view = layerId === undefined ? undefined : this.layers.get(layerId)?.view;
    if (!view) return;
    this.store.select({ entityType: view.handle.spec.entityType, id });
  }

  /** Flies to the pending request's entity if it is on the map (else waits for a later frame). */
  private tryFlyTo(engine: MapEngine): void {
    const request = this.pendingFlyTo;
    if (!request) return;
    if (Date.now() - request.at > FLY_TO_WAIT_MS) {
      this.pendingFlyTo = null;
      return;
    }
    for (const [layerId, layer] of this.layers) {
      if (layer.view.handle.spec.entityType !== request.entityType) continue;
      const at = engine.locate(request.id, layerId);
      if (!at) continue;
      this.pendingFlyTo = null;
      engine.flyTo(at.lon, at.lat);
      return;
    }
  }
}

function emptyFrame(layerId: string): MapFrame {
  return {
    layerId,
    count: 0,
    ids: [],
    positions: new Float64Array(0),
    icons: new Uint16Array(0),
    visible: new Uint8Array(0),
    labels: new Map(),
  };
}

/** Calls `fn` at most once per `ms`, always with the latest value (leading and trailing). */
export function throttle<T>(fn: (value: T) => void, ms: number) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    last = Date.now();
    fn(value);
  };
  return {
    call(value: T): void {
      pending = { value };
      if (timer !== null) return;
      const wait = last + ms - Date.now();
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
