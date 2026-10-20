import {
  ErrorCode,
  PROTOCOL_VERSION,
  SortDirection,
  SubscriptionKind,
  decodeServer,
  encodeClient,
} from '@atlas/protocol';
import type { ClientMessageInit, ServerMessage, Snapshot } from '@atlas/protocol';
import { backoffDelay } from './backoff.js';
import type { BackoffOptions } from './backoff.js';
import type { Clock, RandomSource } from './clock.js';
import { Subscription } from './subscription.js';
import type { SubscriptionHandler, SubscriptionHost, SubscriptionOptions } from './subscription.js';
import type { Transport, TransportFactory } from './transport.js';
import type {
  ConnectionState,
  ErrorInfo,
  Layout,
  LocateAnswer,
  SessionStatus,
  ViewSpec,
  WindowSpec,
} from './types.js';

export interface SessionOptions extends SubscriptionOptions {
  url: string;
  transport: TransportFactory;
  clock: Clock;
  random: RandomSource;
  getToken: () => string;
  backoff?: BackoffOptions;
  /** A connection that stayed open this long resets the backoff (default 5 s). */
  stableAfterMs?: number;
  /** `locate` gives up after this long (default 10 s). */
  locateTimeoutMs?: number;
  /** Called on any status or subscription state change. */
  onChange?: () => void;
}

interface SessionWindow {
  spec: WindowSpec;
  sub: Subscription;
}

interface SessionView {
  spec: ViewSpec;
  layout: Layout | null;
  map: Subscription | null;
  windows: Map<string, SessionWindow>;
  onError?: (info: ErrorInfo) => void;
}

interface PendingLocate {
  resolve: (a: LocateAnswer) => void;
  reject: (e: Error) => void;
  cancelTimer: () => void;
}

const MAX_ORPHAN_SUBS = 64;
const MAX_ORPHAN_FRAMES = 512;

const ERROR_NAMES: Record<number, string> = {
  [ErrorCode.INVALID_FILTER]: 'INVALID_FILTER',
  [ErrorCode.LIMIT]: 'LIMIT',
  [ErrorCode.AUTH]: 'AUTH',
  [ErrorCode.RETRY]: 'RETRY',
};

/**
 * One connection to one view service: connect then `Auth`, jittered exponential reconnect (or
 * the server's `Reconnect` hint), and every view, window, map and detail subscription re-opened
 * after each reconnect.
 */
export class ServiceSession {
  readonly url: string;
  private transport: Transport | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private nextRetryAt: number | null = null;
  private lastError: ErrorInfo | null = null;
  private openedAt = 0;
  private everConnected = false;
  private receivedOnThisConnection = false;
  private reconnectHintAt: number | null = null;
  private cancelRetry: (() => void) | null = null;
  private cancelHint: (() => void) | null = null;

  private readonly views = new Map<string, SessionView>();
  private readonly details = new Map<string, Subscription>();
  private readonly subsById = new Map<string, Subscription[]>();
  private readonly orphans = new Map<string, ServerMessage[]>();
  private readonly locates = new Map<string, PendingLocate[]>();
  private readonly host: SubscriptionHost;

  constructor(private readonly opts: SessionOptions) {
    this.url = opts.url;
    this.host = {
      now: () => opts.clock.now(),
      sendResync: (subId) => this.send({ body: { case: 'resync', value: { subId } } }),
      schedule: (fn, ms) => this.schedule(fn, ms),
      changed: () => this.opts.onChange?.(),
      bind: (sub, subId) => this.bind(sub, subId),
    };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  status(): SessionStatus {
    return {
      url: this.url,
      state: this.state,
      attempt: this.attempt,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
    };
  }

  /** Every subscription of this session (for the status stream). */
  subscriptions(): Subscription[] {
    const out: Subscription[] = [];
    for (const v of this.views.values()) {
      if (v.map) out.push(v.map);
      for (const w of v.windows.values()) out.push(w.sub);
    }
    out.push(...this.details.values());
    return out;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  openView(viewRef: string, spec: ViewSpec, onError?: (info: ErrorInfo) => void): void {
    const view: SessionView = { spec, layout: null, map: null, windows: new Map() };
    if (onError) view.onError = onError;
    this.views.set(viewRef, view);
    this.ensureConnected();
    this.send(openViewMessage(viewRef, spec));
  }

  setLayout(viewRef: string, layout: Layout): void {
    const view = this.mustView(viewRef);
    view.layout = layout;
    this.send(setLayoutMessage(viewRef, layout));
    // A new layout changes every page: re-request each window so its snapshot replaces the rows.
    for (const [windowRef, w] of view.windows) {
      this.request(w.sub, setWindowMessage(viewRef, windowRef, w.spec));
    }
  }

  subscribeMap(viewRef: string, handler: SubscriptionHandler): Subscription {
    const view = this.mustView(viewRef);
    view.map?.dispose();
    const sub = new Subscription(`map|${viewRef}`, 'map', handler, this.host, this.opts);
    view.map = sub;
    this.request(sub, { body: { case: 'subscribeMap', value: { viewRef } } });
    return sub;
  }

  unsubscribeMap(viewRef: string): void {
    const view = this.views.get(viewRef);
    if (!view?.map) return;
    view.map.dispose();
    view.map = null;
    this.send({ body: { case: 'unsubscribeMap', value: { viewRef } } });
    this.opts.onChange?.();
  }

  /** Opens a window, or moves it if `windowRef` is already open on this view. */
  setWindow(
    viewRef: string,
    windowRef: string,
    spec: WindowSpec,
    handler: SubscriptionHandler,
  ): Subscription {
    const view = this.mustView(viewRef);
    const existing = view.windows.get(windowRef);
    if (existing && existing.sub.handler === handler) {
      existing.spec = spec;
      this.request(existing.sub, setWindowMessage(viewRef, windowRef, spec));
      return existing.sub;
    }
    existing?.sub.dispose();
    const sub = new Subscription(
      `page|${viewRef}|${windowRef}`,
      'page',
      handler,
      this.host,
      this.opts,
    );
    view.windows.set(windowRef, { spec, sub });
    this.request(sub, setWindowMessage(viewRef, windowRef, spec));
    return sub;
  }

  closeWindow(viewRef: string, windowRef: string): void {
    const view = this.views.get(viewRef);
    const w = view?.windows.get(windowRef);
    if (!view || !w) return;
    w.sub.dispose();
    view.windows.delete(windowRef);
    this.send(
      setWindowMessage(viewRef, windowRef, { groupPath: w.spec.groupPath, page: 0, pageSize: 0 }),
    );
    this.opts.onChange?.();
  }

  closeView(viewRef: string): void {
    const view = this.views.get(viewRef);
    if (!view) return;
    view.map?.dispose();
    for (const w of view.windows.values()) w.sub.dispose();
    this.views.delete(viewRef);
    this.send({ body: { case: 'closeView', value: { viewRef } } });
    for (const [key, list] of this.locates) {
      if (!key.startsWith(`${viewRef}|`)) continue;
      for (const p of list) {
        p.cancelTimer();
        p.reject(new Error('view closed'));
      }
      this.locates.delete(key);
    }
    this.opts.onChange?.();
  }

  openDetail(entityType: string, id: string, handler: SubscriptionHandler): Subscription {
    const key = detailKey(entityType, id);
    this.details.get(key)?.dispose();
    const sub = new Subscription(`detail|${key}`, 'detail', handler, this.host, this.opts);
    this.details.set(key, sub);
    this.ensureConnected();
    this.request(sub, { body: { case: 'openDetail', value: { entityType, id } } });
    return sub;
  }

  closeDetail(entityType: string, id: string): void {
    const key = detailKey(entityType, id);
    const sub = this.details.get(key);
    if (!sub) return;
    sub.dispose();
    this.details.delete(key);
    this.send({ body: { case: 'closeDetail', value: { entityType, id } } });
    this.opts.onChange?.();
  }

  /** Asks which page `id` is on now (answered by `LocateResult`). */
  locate(viewRef: string, id: string, pageSize = 0): Promise<LocateAnswer> {
    this.mustView(viewRef);
    if (!this.isOpen) return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      const key = `${viewRef}|${id}`;
      const entry: PendingLocate = {
        resolve,
        reject,
        cancelTimer: this.schedule(() => {
          this.removeLocate(key, entry);
          reject(new Error('locate timed out'));
        }, this.opts.locateTimeoutMs ?? 10_000),
      };
      const list = this.locates.get(key) ?? [];
      list.push(entry);
      this.locates.set(key, list);
      this.send({ body: { case: 'locate', value: { viewRef, id, pageSize } } });
    });
  }

  /** Re-sends `Auth`, e.g. with a refreshed token. */
  reauth(): void {
    if (this.isOpen) this.sendAuth();
  }

  /** Re-snapshots every live subscription (return from a hidden tab). Old data stays, stale. */
  resyncAll(): void {
    for (const sub of this.subscriptions()) if (sub.state === 'live') sub.resync();
  }

  /** Closes the connection for good. */
  close(): void {
    this.state = 'closed';
    this.cancelRetry?.();
    this.cancelHint?.();
    for (const sub of this.subscriptions()) sub.dispose();
    this.views.clear();
    this.details.clear();
    this.rejectLocates('session closed');
    const t = this.transport;
    this.transport = null;
    t?.close(1000, 'client closed');
    this.opts.onChange?.();
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  private ensureConnected(): void {
    if (this.state === 'idle') this.connect();
  }

  private connect(): void {
    this.cancelRetry = null;
    this.nextRetryAt = null;
    this.state = this.everConnected ? 'reconnecting' : 'connecting';
    this.receivedOnThisConnection = false;
    const t = this.opts.transport(this.url);
    this.transport = t;
    t.onOpen(() => {
      if (this.transport !== t) return;
      this.state = 'open';
      this.everConnected = true;
      this.openedAt = this.opts.clock.now();
      this.sendAuth();
      this.replay();
      this.opts.onChange?.();
    });
    t.onMessage((data) => {
      if (this.transport !== t) return;
      this.receivedOnThisConnection = true;
      let msg: ServerMessage;
      try {
        msg = decodeServer(data);
      } catch (e) {
        this.setError(
          'TRANSPORT',
          `undecodable frame: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      this.onServerMessage(msg);
    });
    t.onClose((info) => {
      if (this.transport !== t) return;
      this.transport = null;
      this.onDisconnected(info.code, info.reason);
    });
    this.opts.onChange?.();
  }

  private onDisconnected(code: number, reason: string): void {
    if (this.state === 'closed') return;
    const wasStable =
      this.state === 'open' &&
      (this.receivedOnThisConnection ||
        this.opts.clock.now() - this.openedAt >= (this.opts.stableAfterMs ?? 5_000));
    if (wasStable) this.attempt = 0;
    if (code !== 1000 && code !== 4000) {
      this.setError('TRANSPORT', `connection closed (${code}${reason ? `: ${reason}` : ''})`);
    }
    for (const sub of this.subscriptions()) sub.disconnected();
    this.orphans.clear();
    this.rejectLocates('connection closed');
    this.cancelHint?.();
    this.cancelHint = null;

    const now = this.opts.clock.now();
    let delay: number;
    if (this.reconnectHintAt !== null) {
      delay = Math.max(0, this.reconnectHintAt - now);
      this.reconnectHintAt = null;
    } else {
      delay = backoffDelay(this.attempt, this.opts.random, this.opts.backoff);
      this.attempt++;
    }
    this.state = 'reconnecting';
    this.nextRetryAt = now + delay;
    this.cancelRetry = this.schedule(() => this.connect(), delay);
    this.opts.onChange?.();
  }

  private sendAuth(): void {
    this.send({
      body: {
        case: 'auth',
        value: { token: this.opts.getToken(), protocolVersion: PROTOCOL_VERSION },
      },
    });
  }

  /** Re-opens every view and subscription on a fresh connection. */
  private replay(): void {
    for (const [viewRef, view] of this.views) {
      this.send(openViewMessage(viewRef, view.spec));
      if (view.layout) this.send(setLayoutMessage(viewRef, view.layout));
      if (view.map) this.request(view.map, { body: { case: 'subscribeMap', value: { viewRef } } });
      for (const [windowRef, w] of view.windows) {
        this.request(w.sub, setWindowMessage(viewRef, windowRef, w.spec));
      }
    }
    for (const [key, sub] of this.details) {
      const [entityType, id] = splitDetailKey(key);
      this.request(sub, { body: { case: 'openDetail', value: { entityType, id } } });
    }
  }

  private request(sub: Subscription, msg: ClientMessageInit): void {
    this.ensureConnected();
    if (!this.isOpen) return; // sent by replay() once the connection opens
    this.send(msg);
    sub.requested();
  }

  private send(msg: ClientMessageInit): void {
    if (this.isOpen) this.transport?.send(encodeClient(msg));
  }

  private schedule(fn: () => void, ms: number): () => void {
    const h = this.opts.clock.setTimeout(fn, ms);
    return () => this.opts.clock.clearTimeout(h);
  }

  // ---------------------------------------------------------------------------
  // Incoming frames
  // ---------------------------------------------------------------------------

  private onServerMessage(msg: ServerMessage): void {
    const body = msg.body;
    switch (body.case) {
      case 'snapshot':
        this.onSnapshot(msg, body.value);
        return;
      case 'mapDelta':
      case 'pageWindow':
      case 'detailUpdate': {
        const subs = this.subsById.get(msg.subId);
        if (subs) for (const s of subs) s.onFrame(msg);
        else this.keepOrphan(msg);
        return;
      }
      case 'locateResult': {
        const r = body.value;
        const key = `${r.viewRef}|${r.id}`;
        const list = this.locates.get(key);
        const p = list?.shift();
        if (list && list.length === 0) this.locates.delete(key);
        if (p) {
          p.cancelTimer();
          p.resolve({ found: r.found, groupPath: [...r.groupPath], page: r.page });
        }
        return;
      }
      case 'reconnect':
        this.onReconnectHint(body.value.afterMs);
        return;
      case 'error':
        this.onError(msg, body.value.code, body.value.message, body.value.viewRef);
        return;
      default:
        return;
    }
  }

  private onSnapshot(msg: ServerMessage, snap: Snapshot): void {
    const sub = this.findForSnapshot(snap);
    if (!sub) return; // closed meanwhile, or a stale binding: ignore
    const early = this.orphans.get(msg.subId) ?? [];
    this.orphans.delete(msg.subId);
    sub.onSnapshot(msg, snap, early);
  }

  private findForSnapshot(snap: Snapshot): Subscription | undefined {
    switch (snap.kind) {
      case SubscriptionKind.MAP:
        return this.views.get(snap.viewRef)?.map ?? undefined;
      case SubscriptionKind.PAGE:
        return this.views.get(snap.viewRef)?.windows.get(snap.windowRef)?.sub;
      case SubscriptionKind.DETAIL: {
        if (snap.state.case !== 'detail') return undefined;
        const d = snap.state.value;
        return this.details.get(detailKey(d.entityType, d.id));
      }
      default:
        return undefined;
    }
  }

  /** Listen first: keep frames for a `sub_id` whose snapshot has not bound it yet. */
  private keepOrphan(msg: ServerMessage): void {
    let list = this.orphans.get(msg.subId);
    if (!list) {
      if (this.orphans.size >= MAX_ORPHAN_SUBS) {
        const oldest = this.orphans.keys().next().value;
        if (oldest !== undefined) this.orphans.delete(oldest);
      }
      list = [];
      this.orphans.set(msg.subId, list);
    }
    if (list.length >= MAX_ORPHAN_FRAMES) list.shift();
    list.push(msg);
  }

  private bind(sub: Subscription, subId: string | null): void {
    if (sub.subId !== null) {
      const list = this.subsById.get(sub.subId)?.filter((s) => s !== sub);
      if (list && list.length > 0) this.subsById.set(sub.subId, list);
      else this.subsById.delete(sub.subId);
    }
    if (subId !== null) {
      const list = this.subsById.get(subId) ?? [];
      list.push(sub);
      this.subsById.set(subId, list);
    }
  }

  private onReconnectHint(afterMs: number): void {
    const t = this.transport;
    this.reconnectHintAt = this.opts.clock.now() + afterMs;
    this.cancelHint?.();
    this.cancelHint = this.schedule(() => {
      this.cancelHint = null;
      // Still on the connection that asked: move now (the hint delay has passed).
      if (this.transport === t && t) t.close(4000, 'reconnect hint');
    }, afterMs);
  }

  private onError(msg: ServerMessage, code: ErrorCode, message: string, viewRef: string): void {
    const info = this.setError(ERROR_NAMES[code] ?? `CODE_${code}`, message, viewRef, msg.subId);
    if (viewRef) this.views.get(viewRef)?.onError?.(info);
    if (msg.subId) {
      for (const s of this.subsById.get(msg.subId) ?? []) {
        s.handler.onError?.(code, message);
        if (code === ErrorCode.RETRY) s.resync();
      }
    }
  }

  private setError(code: string, message: string, viewRef?: string, subId?: string): ErrorInfo {
    const info: ErrorInfo = { code, message, at: this.opts.clock.now(), url: this.url };
    if (viewRef) info.viewRef = viewRef;
    if (subId) info.subId = subId;
    this.lastError = info;
    this.opts.onChange?.();
    return info;
  }

  private rejectLocates(reason: string): void {
    for (const list of this.locates.values()) {
      for (const p of list) {
        p.cancelTimer();
        p.reject(new Error(reason));
      }
    }
    this.locates.clear();
  }

  private removeLocate(key: string, entry: PendingLocate): void {
    const list = this.locates.get(key)?.filter((p) => p !== entry);
    if (list && list.length > 0) this.locates.set(key, list);
    else this.locates.delete(key);
  }

  private mustView(viewRef: string): SessionView {
    const v = this.views.get(viewRef);
    if (!v) throw new Error(`unknown view ${viewRef}`);
    return v;
  }
}

function detailKey(entityType: string, id: string): string {
  return `${entityType}|${id}`;
}

function splitDetailKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

function openViewMessage(viewRef: string, spec: ViewSpec): ClientMessageInit {
  const filter =
    spec.filter === undefined || spec.filter === null
      ? ''
      : typeof spec.filter === 'string'
        ? spec.filter
        : JSON.stringify(spec.filter);
  const scope =
    'connectionId' in spec.scope
      ? { case: 'connectionId' as const, value: spec.scope.connectionId }
      : { case: 'countries' as const, value: { countryIds: spec.scope.countries } };
  return {
    body: { case: 'openView', value: { viewRef, entityType: spec.entityType, filter, scope } },
  };
}

function setLayoutMessage(viewRef: string, layout: Layout): ClientMessageInit {
  return {
    body: {
      case: 'setLayout',
      value: {
        viewRef,
        groupBy: layout.groupBy,
        ...(layout.sort
          ? {
              sort: {
                field: layout.sort.field,
                dir: layout.sort.dir === 'desc' ? SortDirection.DESC : SortDirection.ASC,
              },
            }
          : {}),
      },
    },
  };
}

function setWindowMessage(viewRef: string, windowRef: string, spec: WindowSpec): ClientMessageInit {
  return {
    body: {
      case: 'setWindow',
      value: {
        viewRef,
        windowRef,
        groupPath: spec.groupPath,
        page: spec.page,
        pageSize: spec.pageSize,
      },
    },
  };
}
