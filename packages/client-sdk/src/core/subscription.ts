import type { ServerMessage, Snapshot } from '@atlas/protocol';

/**
 * - `pending`: requested while disconnected; sent when the connection opens.
 * - `snapshot-wait`: request sent, no snapshot yet. Early deltas are buffered.
 * - `live`: in sync; each frame must have `seq == last + 1`.
 * - `stale`: the connection dropped; old data is kept and shown as stale.
 * - `resyncing`: a gap (or a return from a hidden tab) sent `Resync`; waiting for the snapshot.
 */
export type SubscriptionState = 'pending' | 'snapshot-wait' | 'live' | 'stale' | 'resyncing';

export type SubscriptionKind = 'map' | 'page' | 'detail';

/** Receives the frames of one subscription, already in order and gap-free. */
export interface SubscriptionHandler {
  /** Full state of the subscription; replaces everything held before. */
  applySnapshot(snapshot: Snapshot, msg: ServerMessage): void;
  /** One `map_delta`, `page_window` or `detail_update` frame, in sequence. */
  applyDelta(msg: ServerMessage): void;
  /** State or `staleSince` changed. */
  onStateChange?(state: SubscriptionState, staleSince: number | null): void;
  /** A server `Error` about this subscription. */
  onError?(code: number, message: string): void;
}

/** What a subscription needs from its session. */
export interface SubscriptionHost {
  now(): number;
  sendResync(subId: string): void;
  /** Schedules `fn` after `ms`; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  /** The subscription's state changed (for the status stream). */
  changed(sub: Subscription): void;
  /** The subscription is now bound to a server `sub_id` (or unbound with `null`). */
  bind(sub: Subscription, subId: string | null): void;
}

export interface SubscriptionOptions {
  /** Re-send `Resync` when no snapshot arrives within this time (default 10 s). */
  resyncTimeoutMs?: number;
  /** Most frames buffered while waiting for a snapshot (default 1 024). */
  maxBuffered?: number;
}

/**
 * Sequence and state tracking for one subscription (map, page window or detail).
 *
 * Applies a frame only if `seq == last + 1`; on a gap it sends `Resync` and marks itself stale.
 * Listen first: frames that arrive before the snapshot are buffered, and those the snapshot
 * already covers (`seq <= snapshot.seq`) are dropped when it arrives.
 */
export class Subscription {
  state: SubscriptionState = 'pending';
  subId: string | null = null;
  lastSeq = 0;
  staleSince: number | null = null;
  private buffer: ServerMessage[] = [];
  private cancelResyncTimer: (() => void) | null = null;
  private readonly resyncTimeoutMs: number;
  private readonly maxBuffered: number;

  constructor(
    readonly key: string,
    readonly kind: SubscriptionKind,
    readonly handler: SubscriptionHandler,
    private readonly host: SubscriptionHost,
    options: SubscriptionOptions = {},
  ) {
    this.resyncTimeoutMs = options.resyncTimeoutMs ?? 10_000;
    this.maxBuffered = options.maxBuffered ?? 1_024;
  }

  get isStale(): boolean {
    return this.staleSince !== null;
  }

  /** The request was sent on an open connection; the snapshot is next. */
  requested(): void {
    this.unbind();
    this.buffer = [];
    this.setState('snapshot-wait');
  }

  /** The connection closed. Keeps the data, marks it stale. */
  disconnected(): void {
    this.unbind();
    this.buffer = [];
    this.clearResyncTimer();
    this.markStale();
    this.setState('stale');
  }

  /** Asks for a fresh snapshot while keeping the current data, marked stale. */
  resync(): void {
    if (this.subId === null) return;
    this.markStale();
    this.setState('resyncing');
    this.buffer = [];
    this.host.sendResync(this.subId);
    this.clearResyncTimer();
    this.cancelResyncTimer = this.host.schedule(() => {
      this.cancelResyncTimer = null;
      if (this.state === 'resyncing') this.resync();
    }, this.resyncTimeoutMs);
  }

  /**
   * A snapshot for this subscription arrived.
   *
   * @param early frames for `msg.subId` that arrived before the binding was known.
   */
  onSnapshot(msg: ServerMessage, snapshot: Snapshot, early: readonly ServerMessage[] = []): void {
    this.clearResyncTimer();
    if (this.subId !== msg.subId) this.host.bind(this, msg.subId);
    this.subId = msg.subId;
    this.lastSeq = msg.seq;
    this.handler.applySnapshot(snapshot, msg);
    this.staleSince = null;
    const pending = [...early, ...this.buffer].filter((m) => m.subId === msg.subId);
    this.buffer = [];
    this.setState('live');
    pending.sort((a, b) => a.seq - b.seq);
    for (const m of pending) {
      if (this.state !== 'live') break;
      this.onFrame(m);
    }
  }

  /** A sequenced non-snapshot frame with this subscription's `sub_id`. */
  onFrame(msg: ServerMessage): void {
    if (this.state === 'snapshot-wait' || this.state === 'resyncing') {
      if (this.buffer.length >= this.maxBuffered) this.buffer.shift();
      this.buffer.push(msg);
      return;
    }
    if (this.state !== 'live') return;
    if (msg.seq <= this.lastSeq) return; // duplicate or already covered by the snapshot
    if (msg.seq !== this.lastSeq + 1) {
      this.resync();
      return;
    }
    this.lastSeq = msg.seq;
    this.handler.applyDelta(msg);
  }

  /** Stops timers; the subscription is no longer used. */
  dispose(): void {
    this.clearResyncTimer();
    this.unbind();
    this.buffer = [];
  }

  private unbind(): void {
    if (this.subId !== null) this.host.bind(this, null);
    this.subId = null;
    this.lastSeq = 0;
  }

  private markStale(): void {
    if (this.staleSince === null) this.staleSince = this.host.now();
  }

  private clearResyncTimer(): void {
    this.cancelResyncTimer?.();
    this.cancelResyncTimer = null;
  }

  private setState(state: SubscriptionState): void {
    this.state = state;
    this.handler.onStateChange?.(state, this.staleSince);
    this.host.changed(this);
  }
}
