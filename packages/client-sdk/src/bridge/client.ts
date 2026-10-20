import type { MapAdapter, MapFrame } from '../adapters/map-adapter.js';
import type { AtlasStatus, ErrorInfo, Layout, LocateAnswer, ViewSpec } from '../core/types.js';
import { MapFrameAssembler } from '../map-store/frame.js';
import type { Camera } from '../map-store/label-selector.js';
import type { DetailState } from '../pages/detail-subscription.js';
import type { PageOptions, PageState } from '../pages/page-subscription.js';
import { inProcessChannel } from './endpoint.js';
import type { Endpoint } from './endpoint.js';
import type { Command, FromWorker, Query, ToWorker, WorkerConfig } from './messages.js';
import { Store } from './observable.js';
import type { Observable } from './observable.js';
import { WorkerHost } from './worker-host.js';
import type { HostInjections } from './worker-host.js';

export interface AtlasClientConfig extends WorkerConfig {
  /**
   * Where the SDK core runs:
   * - a `Worker` (or a function creating one), the default for apps, e.g.
   *   `() => new Worker(new URL('./sdk.worker', import.meta.url), { type: 'module' })`;
   * - `'main-thread'`: in this thread (tests, or browsers without Workers).
   * Without it, the core runs on the main thread.
   */
  worker?: Worker | (() => Worker) | 'main-thread';
  /** Main-thread mode only: transport, clock and random source (tests). */
  inject?: HostInjections;
  /** Track `document.visibilitychange` and pause while hidden (default true in browsers). */
  trackVisibility?: boolean;
}

/** Called with each map frame. The frame's buffers go back to the SDK when it returns. */
export type FrameListener = (frame: MapFrame) => void;

export interface PageHandle extends Observable<PageState | null> {
  readonly id: string;
  setPage(page: number): void;
  setGroupPath(groupPath: string[]): void;
  /** While true (hover or scroll), rows keep their order; `pendingReorder` counts changes. */
  setFreezeOrder(frozen: boolean): void;
  /** The page `id` is on; with `jump`, also moves this page there. */
  locate(id: string, options?: { jump?: boolean }): Promise<LocateAnswer>;
  close(): void;
}

export interface MapLayerHandle {
  readonly layerId: string;
  close(): void;
}

export interface ViewHandle {
  readonly id: string;
  readonly spec: ViewSpec;
  /** The last server error about this view (e.g. `INVALID_FILTER`), or null. */
  readonly error: Observable<ErrorInfo | null>;
  setLayout(layout: Layout): void;
  /** Streams this view's map into the layer `layerId` (default: the view id). */
  subscribeMap(layerId?: string): MapLayerHandle;
  subscribePage(options?: PageOptions): PageHandle;
  locate(id: string, pageSize?: number): Promise<LocateAnswer>;
  close(): void;
}

export interface DetailHandle extends Observable<DetailState | null> {
  readonly entityType: string;
  readonly id: string;
  close(): void;
}

export interface AtlasClient {
  /** Connection state, stale time and last error, at most 4 updates per second. */
  readonly status: Observable<AtlasStatus>;
  setToken(token: string): void;
  openView(spec: ViewSpec): ViewHandle;
  openDetail(entityType: string, id: string): DetailHandle;
  /** Map frames of every layer. Returns an unsubscribe function. */
  onFrame(listener: FrameListener): () => void;
  /** Sends every frame to `adapter.applyFrame`. Returns a detach function. */
  attachMap(adapter: MapAdapter): () => void;
  /** For label selection (nearest to the camera). Throttle on the caller side. */
  setCamera(camera: Camera | null): void;
  /** The selected entity always gets a label. */
  setSelected(id: string | null): void;
  /** Hidden tab: pause frames and updates (called automatically with `trackVisibility`). */
  setHidden(hidden: boolean): void;
  destroy(): void;
}

const INITIAL_STATUS: AtlasStatus = {
  connection: 'idle',
  connections: [],
  subscriptions: [],
  staleSince: null,
  lastError: null,
  hidden: false,
};

let clientCounter = 0;

function noop(): void {}

/**
 * Creates the main-thread API. All realtime work runs behind it (in the Worker when one is
 * given); this side only forwards calls, routes batched updates to observables and hands map
 * frames to listeners, then returns their buffers.
 */
export function createAtlasClient(config: AtlasClientConfig): AtlasClient {
  const prefix = `c${++clientCounter}`;
  let port: Endpoint<FromWorker, ToWorker>;
  let worker: Worker | null = null;
  let inProcessHost: WorkerHost | null = null;
  if (config.worker && config.worker !== 'main-thread') {
    worker = typeof config.worker === 'function' ? config.worker() : config.worker;
    port = worker;
  } else {
    const ch = inProcessChannel<ToWorker, FromWorker>();
    inProcessHost = new WorkerHost(ch.b, config.inject ?? {});
    port = ch.a;
  }

  const status = new Store<AtlasStatus>(INITIAL_STATUS);
  const pages = new Map<string, Store<PageState | null>>();
  const details = new Map<string, Store<DetailState | null>>();
  const viewErrors = new Map<string, Store<ErrorInfo | null>>();
  const assemblers = new Map<string, MapFrameAssembler>();
  const frameListeners = new Set<FrameListener>();
  const calls = new Map<
    number,
    { resolve: (a: LocateAnswer) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;
  let destroyed = false;

  const send = (command: Command) => {
    if (!destroyed) port.postMessage({ kind: 'command', command });
  };
  const ask = (query: Query) =>
    new Promise<LocateAnswer>((resolve, reject) => {
      const callId = nextId++;
      calls.set(callId, { resolve, reject });
      port.postMessage({ kind: 'query', callId, query });
    });

  port.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.kind) {
      case 'frame': {
        const w = msg.frame;
        let asm = assemblers.get(w.layerId);
        if (!asm) assemblers.set(w.layerId, (asm = new MapFrameAssembler()));
        const frame = asm.assemble(w);
        try {
          for (const l of frameListeners) l(frame);
        } finally {
          const b = w.buffers;
          port.postMessage({ kind: 'release', layerId: w.layerId, buffers: b }, [
            b.positions.buffer,
            b.icons.buffer,
            b.visible.buffer,
            b.idSlots.buffer,
            b.labelSlots.buffer,
          ]);
        }
        return;
      }
      case 'updates':
        for (const u of msg.updates) {
          if (u.kind === 'status') status.set(u.status);
          else if (u.kind === 'page') pages.get(u.pageId)?.set(u.state);
          else if (u.kind === 'detail') details.get(u.detailId)?.set(u.state);
          else viewErrors.get(u.viewId)?.set(u.error);
        }
        return;
      case 'answer': {
        const call = calls.get(msg.callId);
        calls.delete(msg.callId);
        if (!call) return;
        if (msg.ok) call.resolve(msg.value);
        else call.reject(new Error(msg.error));
        return;
      }
    }
  });

  const { worker: _w, inject: _i, trackVisibility, ...workerConfig } = config;
  send({ op: 'configure', config: workerConfig });

  let stopVisibility: () => void = noop;
  if (trackVisibility !== false && typeof document !== 'undefined') {
    const onVisibility = () =>
      send({ op: 'setHidden', hidden: document.visibilityState === 'hidden' });
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'hidden') onVisibility();
    stopVisibility = () => document.removeEventListener('visibilitychange', onVisibility);
  }

  const client: AtlasClient = {
    status,
    setToken: (token) => send({ op: 'setToken', token }),

    openView(spec) {
      const viewId = `${prefix}v${nextId++}`;
      const error = new Store<ErrorInfo | null>(null);
      viewErrors.set(viewId, error);
      send({ op: 'openView', viewId, spec });
      let layer: string | null = null;
      const pageIds = new Set<string>();
      return {
        id: viewId,
        spec,
        error,
        setLayout: (layout) => send({ op: 'setLayout', viewId, layout }),
        subscribeMap(layerId = viewId) {
          layer = layerId;
          send({ op: 'subscribeMap', viewId, layerId });
          return {
            layerId,
            close: () => {
              if (layer !== layerId) return;
              layer = null;
              send({ op: 'unsubscribeMap', viewId });
            },
          };
        },
        subscribePage(options = {}) {
          const pageId = `${viewId}/p${nextId++}`;
          const store = new Store<PageState | null>(null);
          pages.set(pageId, store);
          pageIds.add(pageId);
          send({ op: 'subscribePage', viewId, pageId, options });
          return {
            id: pageId,
            subscribe: (l) => store.subscribe(l),
            getSnapshot: () => store.getSnapshot(),
            setPage: (page) => send({ op: 'setPage', pageId, page }),
            setGroupPath: (groupPath) => send({ op: 'setGroupPath', pageId, groupPath }),
            setFreezeOrder: (frozen) => send({ op: 'setFreezeOrder', pageId, frozen }),
            locate: (id, o = {}) => ask({ op: 'locatePage', pageId, id, jump: o.jump ?? false }),
            close: () => {
              if (!pages.delete(pageId)) return;
              pageIds.delete(pageId);
              send({ op: 'closePage', pageId });
            },
          };
        },
        locate: (id, pageSize) =>
          ask({ op: 'locate', viewId, id, ...(pageSize !== undefined ? { pageSize } : {}) }),
        close() {
          if (!viewErrors.delete(viewId)) return;
          for (const p of pageIds) pages.delete(p);
          if (layer) assemblers.delete(layer);
          send({ op: 'closeView', viewId });
        },
      };
    },

    openDetail(entityType, id) {
      const detailId = `${prefix}d${nextId++}`;
      const store = new Store<DetailState | null>(null);
      details.set(detailId, store);
      send({ op: 'openDetail', detailId, entityType, id });
      return {
        entityType,
        id,
        subscribe: (l) => store.subscribe(l),
        getSnapshot: () => store.getSnapshot(),
        close: () => {
          if (!details.delete(detailId)) return;
          send({ op: 'closeDetail', detailId });
        },
      };
    },

    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },

    attachMap(adapter) {
      // Frames always carry the full slot -> id table (kept here), so a new adapter needs no reset.
      return client.onFrame((frame) => adapter.applyFrame(frame));
    },

    setCamera: (camera) => send({ op: 'setCamera', camera }),
    setSelected: (id) => send({ op: 'setSelected', id }),
    setHidden: (hidden) => send({ op: 'setHidden', hidden }),

    destroy() {
      if (destroyed) return;
      for (const call of calls.values()) call.reject(new Error('client destroyed'));
      calls.clear();
      stopVisibility();
      frameListeners.clear();
      send({ op: 'destroy' });
      destroyed = true;
      worker?.terminate();
    },
  };
  if (inProcessHost) inProcessHosts.set(client, inProcessHost);
  return client;
}

/** Main-thread mode: the host lives exactly as long as its client. */
const inProcessHosts = new WeakMap<AtlasClient, WorkerHost>();
