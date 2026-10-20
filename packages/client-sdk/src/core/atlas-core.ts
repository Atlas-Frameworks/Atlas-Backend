import type { BackoffOptions } from './backoff.js';
import { systemClock, systemRandom } from './clock.js';
import type { Clock, RandomSource } from './clock.js';
import { ServiceSession } from './session.js';
import type { Subscription, SubscriptionHandler } from './subscription.js';
import { webSocketTransport } from './transport.js';
import type { TransportFactory } from './transport.js';
import type {
  AtlasStatus,
  ConnectionState,
  ErrorInfo,
  Layout,
  LocateAnswer,
  ViewSpec,
  WindowSpec,
} from './types.js';

export interface CoreConfig {
  /** Entity type → view-service WebSocket URL (S-10: one service per group of types). */
  services: Record<string, string>;
  /** Dev JWT (A-01). Can be replaced later with {@link AtlasCore.setToken}. */
  token?: string;
  transport?: TransportFactory;
  clock?: Clock;
  random?: RandomSource;
  backoff?: BackoffOptions;
  resyncTimeoutMs?: number;
  locateTimeoutMs?: number;
}

/** A view opened through {@link AtlasCore.openView}. */
export interface CoreView {
  readonly viewRef: string;
  readonly spec: ViewSpec;
  setLayout(layout: Layout): void;
  subscribeMap(handler: SubscriptionHandler): Subscription;
  unsubscribeMap(): void;
  /** Opens or moves the window `windowRef` (for example `"main"` or `"prefetch"`). */
  setWindow(windowRef: string, spec: WindowSpec, handler: SubscriptionHandler): Subscription;
  closeWindow(windowRef: string): void;
  locate(id: string, pageSize?: number): Promise<LocateAnswer>;
  close(): void;
}

export interface CoreDetail {
  readonly subscription: Subscription;
  close(): void;
}

const CONNECTION_RANK: Record<ConnectionState, number> = {
  closed: 0,
  idle: 1,
  open: 2,
  connecting: 3,
  reconnecting: 4,
};

/**
 * The SDK core: one {@link ServiceSession} per service URL, routing by entity type, the
 * hidden-tab rule and the status stream. Runs in the Worker (or on the main thread in tests).
 */
export class AtlasCore {
  private readonly sessions = new Map<string, ServiceSession>();
  private readonly statusListeners = new Set<(s: AtlasStatus) => void>();
  private readonly hiddenListeners = new Set<(hidden: boolean) => void>();
  private token: string;
  private hidden = false;
  private nextViewRef = 1;
  readonly clock: Clock;
  readonly random: RandomSource;
  private readonly transport: TransportFactory;

  constructor(private config: CoreConfig) {
    this.token = config.token ?? '';
    this.clock = config.clock ?? systemClock;
    this.random = config.random ?? systemRandom;
    this.transport = config.transport ?? webSocketTransport;
  }

  /** Changes the routing table. Sessions already open keep running. */
  configure(services: Record<string, string>): void {
    this.config = { ...this.config, services };
  }

  setToken(token: string): void {
    this.token = token;
    for (const s of this.sessions.values()) s.reauth();
  }

  /** The service URL for an entity type. */
  urlFor(entityType: string): string {
    const url = this.config.services[entityType] ?? this.config.services['*'];
    if (!url) throw new Error(`no service configured for entity type "${entityType}"`);
    return url;
  }

  /**
   * Opens a view on the service for its entity type.
   *
   * @param viewRef the client-chosen id sent as `OpenView.viewRef` (default `v1`, `v2`, ...);
   *   must be unique within this core.
   */
  openView(spec: ViewSpec, onError?: (info: ErrorInfo) => void, viewRef?: string): CoreView {
    const session = this.session(this.urlFor(spec.entityType));
    viewRef ??= `v${this.nextViewRef++}`;
    session.openView(viewRef, spec, onError);
    return {
      viewRef,
      spec,
      setLayout: (layout) => session.setLayout(viewRef, layout),
      subscribeMap: (handler) => session.subscribeMap(viewRef, handler),
      unsubscribeMap: () => session.unsubscribeMap(viewRef),
      setWindow: (windowRef, w, handler) => session.setWindow(viewRef, windowRef, w, handler),
      closeWindow: (windowRef) => session.closeWindow(viewRef, windowRef),
      locate: (id, pageSize) => session.locate(viewRef, id, pageSize),
      close: () => session.closeView(viewRef),
    };
  }

  openDetail(entityType: string, id: string, handler: SubscriptionHandler): CoreDetail {
    const session = this.session(this.urlFor(entityType));
    const subscription = session.openDetail(entityType, id, handler);
    return { subscription, close: () => session.closeDetail(entityType, id) };
  }

  /**
   * Hidden tab: listeners (the frame scheduler and the bridge) stop emitting and keep only the
   * latest state. Visible again: every subscription is re-snapshotted, and its old data is shown
   * as stale until the snapshot arrives.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (!hidden) for (const s of this.sessions.values()) s.resyncAll();
    for (const l of this.hiddenListeners) l(hidden);
    this.emitStatus();
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  onHiddenChange(cb: (hidden: boolean) => void): () => void {
    this.hiddenListeners.add(cb);
    return () => this.hiddenListeners.delete(cb);
  }

  getStatus(): AtlasStatus {
    let connection: ConnectionState = 'idle';
    let staleSince: number | null = null;
    let lastError: ErrorInfo | null = null;
    const connections = [];
    const subscriptions = [];
    for (const session of this.sessions.values()) {
      const st = session.status();
      connections.push(st);
      if (CONNECTION_RANK[st.state] > CONNECTION_RANK[connection]) connection = st.state;
      if (st.lastError && (!lastError || st.lastError.at >= lastError.at)) lastError = st.lastError;
      for (const sub of session.subscriptions()) {
        subscriptions.push({
          key: sub.key,
          kind: sub.kind,
          state: sub.state,
          staleSince: sub.staleSince,
        });
        if (sub.staleSince !== null && (staleSince === null || sub.staleSince < staleSince)) {
          staleSince = sub.staleSince;
        }
      }
    }
    return {
      connection,
      connections,
      subscriptions,
      staleSince,
      lastError,
      hidden: this.hidden,
    };
  }

  /** Called on every status change (unthrottled; the bridge batches). */
  onStatus(cb: (s: AtlasStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    this.emitStatus();
  }

  private session(url: string): ServiceSession {
    let s = this.sessions.get(url);
    if (!s) {
      s = new ServiceSession({
        url,
        transport: this.transport,
        clock: this.clock,
        random: this.random,
        getToken: () => this.token,
        ...(this.config.backoff ? { backoff: this.config.backoff } : {}),
        ...(this.config.resyncTimeoutMs !== undefined
          ? { resyncTimeoutMs: this.config.resyncTimeoutMs }
          : {}),
        ...(this.config.locateTimeoutMs !== undefined
          ? { locateTimeoutMs: this.config.locateTimeoutMs }
          : {}),
        onChange: () => this.emitStatus(),
      });
      this.sessions.set(url, s);
    }
    return s;
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const status = this.getStatus();
    for (const l of this.statusListeners) l(status);
  }
}
