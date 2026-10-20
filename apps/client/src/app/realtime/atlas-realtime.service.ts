import {
  DestroyRef,
  Injectable,
  assertInInjectionContext,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Signal } from '@angular/core';
import type {
  AtlasClient,
  AtlasStatus,
  Camera,
  DetailHandle,
  DetailState,
  ErrorInfo,
  FrameListener,
  GroupCountData,
  Layout,
  MapAdapter,
  MapLayerHandle,
  Observable,
  PageHandle,
  PageOptions,
  PageState,
  RowData,
  ViewHandle,
  ViewSpec,
} from '@atlas/client-sdk';
import { AuthStore } from '../auth/auth.store';
import { ATLAS_ENV } from '../config/environment';
import { ATLAS_CLIENT_FACTORY } from './atlas-client-factory';

/** Ties a handle to a lifetime. Defaults to the caller's `DestroyRef` (needs an injection context). */
export interface LifetimeOptions {
  destroyRef?: DestroyRef;
}

/** `ViewSpec` whose scope defaults to the signed-in user's scope. */
export type LiveViewSpec = Omit<ViewSpec, 'scope'> & Partial<Pick<ViewSpec, 'scope'>>;

export interface LiveView {
  readonly handle: ViewHandle;
  /** Server errors for this view, e.g. `INVALID_FILTER`. */
  readonly error: Signal<ErrorInfo | null>;
  setLayout(layout: Layout): void;
  /** Closes the view, its pages and its map layer. Idempotent. */
  dispose(): void;
}

export interface LivePage {
  readonly handle: PageHandle;
  readonly state: Signal<PageState | null>;
  readonly rows: Signal<readonly RowData[]>;
  readonly total: Signal<number>;
  readonly groupCounts: Signal<readonly GroupCountData[]>;
  readonly loading: Signal<boolean>;
  readonly stale: Signal<boolean>;
  /** Closes the page subscription. Idempotent. */
  dispose(): void;
}

export interface LiveDetail {
  readonly handle: DetailHandle;
  readonly state: Signal<DetailState | null>;
  readonly row: Signal<RowData | null>;
  readonly removed: Signal<boolean>;
  readonly loading: Signal<boolean>;
  readonly stale: Signal<boolean>;
  /** Closes the detail subscription. Idempotent. */
  dispose(): void;
}

const IDLE_STATUS: AtlasStatus = {
  connection: 'idle',
  connections: [],
  subscriptions: [],
  staleSince: null,
  lastError: null,
  hidden: false,
};

const NO_ROWS: readonly RowData[] = [];
const NO_GROUPS: readonly GroupCountData[] = [];

/**
 * Angular face of `@atlas/client-sdk`: one SDK client (its core in a Web Worker) per signed-in
 * session, with status, pages and details as signals.
 *
 * Map frames are deliberately not signals: `attachMap` / `onFrame` hand them straight from the
 * SDK to the map adapter, so a frame never schedules change detection. Status, page and detail
 * updates arrive coalesced (at most 4 per second) and are the only things that touch signals.
 */
@Injectable({ providedIn: 'root' })
export class AtlasRealtimeService {
  private readonly env = inject(ATLAS_ENV);
  private readonly auth = inject(AuthStore);
  private readonly createClient = inject(ATLAS_CLIENT_FACTORY);

  private client: AtlasClient | null = null;
  private stopStatus: (() => void) | null = null;
  private readonly statusValue = signal<AtlasStatus>(IDLE_STATUS);

  /** The SDK's full status (connections, subscriptions, errors). */
  readonly status = this.statusValue.asReadonly();
  /** Worst connection state across services: `idle`, `connecting`, `open`, `reconnecting`, `closed`. */
  readonly connectionStatus = computed(() => this.status().connection);
  /** Earliest time (ms) any subscription went stale, or null when everything is in sync. */
  readonly staleSince = computed(() => this.status().staleSince);
  readonly stale = computed(() => this.staleSince() !== null);
  readonly lastError = computed(() => this.status().lastError);

  constructor() {
    // A new token goes to the running client; signing out tears the client down.
    effect(() => {
      const token = this.auth.token();
      untracked(() => {
        if (token === null) this.shutdown();
        else this.client?.setToken(token);
      });
    });
    inject(DestroyRef).onDestroy(() => this.shutdown());
  }

  /** Opens a live view (scope defaults to the session's). Disposed with the caller's DestroyRef. */
  openView(spec: LiveViewSpec, options?: LifetimeOptions): LiveView {
    const destroyRef = options?.destroyRef ?? injectDestroyRef();
    const scope = spec.scope ?? this.auth.session()?.scope;
    if (!scope) throw new Error('openView: no scope (not signed in)');
    const handle = this.ensureClient().openView({ ...spec, scope });
    const error = watch(handle.error);
    const children = new Set<() => void>();
    const view: LiveView = {
      handle,
      error: error.value,
      setLayout: (layout) => handle.setLayout(layout),
      dispose: onceWithLifetime(destroyRef, () => {
        for (const close of children) close();
        error.stop();
        handle.close();
      }),
    };
    views.set(view, children);
    return view;
  }

  /** Subscribes to one live page of a view; also disposed with the view. */
  subscribePage(view: LiveView, options?: PageOptions, lifetime?: LifetimeOptions): LivePage {
    const destroyRef = lifetime?.destroyRef ?? injectDestroyRef();
    const handle = view.handle.subscribePage(options);
    const state = watch(handle);
    const dispose = onceWithLifetime(destroyRef, () => {
      views.get(view)?.delete(dispose);
      state.stop();
      handle.close();
    });
    views.get(view)?.add(dispose);
    const s = state.value;
    return {
      handle,
      state: s,
      rows: computed(() => s()?.rows ?? NO_ROWS),
      total: computed(() => s()?.total ?? 0),
      groupCounts: computed(() => s()?.groupCounts ?? NO_GROUPS),
      loading: computed(() => s()?.loading ?? true),
      stale: computed(() => s()?.stale ?? false),
      dispose,
    };
  }

  /** Subscribes to one entity's live detail record. */
  openDetail(entityType: string, id: string, options?: LifetimeOptions): LiveDetail {
    const destroyRef = options?.destroyRef ?? injectDestroyRef();
    const handle = this.ensureClient().openDetail(entityType, id);
    const state = watch(handle);
    const s = state.value;
    return {
      handle,
      state: s,
      row: computed(() => s()?.row ?? null),
      removed: computed(() => s()?.removed ?? false),
      loading: computed(() => s()?.loading ?? true),
      stale: computed(() => s()?.stale ?? false),
      dispose: onceWithLifetime(destroyRef, () => {
        state.stop();
        handle.close();
      }),
    };
  }

  /** Subscribes the view's map layer (frames go to attached adapters); closed with the view. */
  subscribeMap(view: LiveView, layerId?: string): MapLayerHandle {
    const layer = view.handle.subscribeMap(layerId);
    views.get(view)?.add(() => layer.close());
    return layer;
  }

  /**
   * Hands every map frame to `adapter.applyFrame`, outside Angular: no signal, no change
   * detection. Returns the detach function.
   */
  attachMap(adapter: MapAdapter): () => void {
    return this.ensureClient().attachMap(adapter);
  }

  /** Raw frame listener (same rules as `attachMap`: keep it free of Angular state). */
  onFrame(listener: FrameListener): () => void {
    return this.ensureClient().onFrame(listener);
  }

  setCamera(camera: Camera | null): void {
    this.client?.setCamera(camera);
  }

  setSelected(id: string | null): void {
    this.client?.setSelected(id);
  }

  private ensureClient(): AtlasClient {
    if (this.client) return this.client;
    const token = this.auth.token();
    const client = this.createClient({
      services: this.env.services,
      ...(token === null ? {} : { token }),
    });
    this.client = client;
    this.statusValue.set(client.status.getSnapshot());
    this.stopStatus = client.status.subscribe((s) => this.statusValue.set(s));
    return client;
  }

  private shutdown(): void {
    this.stopStatus?.();
    this.stopStatus = null;
    this.client?.destroy();
    this.client = null;
    this.statusValue.set(IDLE_STATUS);
  }
}

/** Open views -> dispose functions of their pages and map layer. */
const views = new WeakMap<LiveView, Set<() => void>>();

/** The caller's DestroyRef; without an explicit `destroyRef`, helpers need an injection context. */
function injectDestroyRef(): DestroyRef {
  assertInInjectionContext(injectDestroyRef);
  return inject(DestroyRef);
}

/** A signal mirroring an SDK observable. */
function watch<T>(source: Observable<T>): { value: Signal<T>; stop: () => void } {
  const value = signal(source.getSnapshot());
  const stop = source.subscribe((v) => value.set(v));
  return { value: value.asReadonly(), stop };
}

/** Runs `dispose` once: when called, or when `destroyRef` is destroyed, whichever comes first. */
function onceWithLifetime(destroyRef: DestroyRef, dispose: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    unregister();
    dispose();
  };
  const unregister = destroyRef.onDestroy(run);
  return run;
}
