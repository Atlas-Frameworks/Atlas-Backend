import type { DetailUpdate, ServerMessage, Snapshot } from '@atlas/protocol';
import type { CoreDetail } from '../core/atlas-core.js';
import type { SubscriptionHandler, SubscriptionState } from '../core/subscription.js';
import { toRowData } from './row-cache.js';
import type { RowData } from './row-cache.js';

/** One entity's live detail record (C-03). */
export interface DetailState {
  entityType: string;
  id: string;
  /** The latest row, or null before the first snapshot or after removal. */
  row: RowData | null;
  /** The entity was deleted (or left the user's scope). */
  removed: boolean;
  loading: boolean;
  stale: boolean;
  staleSince: number | null;
}

/** Applies `DetailUpdate` frames for one entity: live row or `removed`. */
export class DetailSubscription implements SubscriptionHandler {
  private row: RowData | null = null;
  private removed = false;
  private loaded = false;
  private staleSince: number | null = null;
  core: CoreDetail | null = null;

  constructor(
    readonly entityType: string,
    readonly id: string,
    private readonly onUpdate: (state: DetailState) => void,
  ) {}

  get state(): DetailState {
    return {
      entityType: this.entityType,
      id: this.id,
      row: this.row,
      removed: this.removed,
      loading: !this.loaded,
      stale: this.staleSince !== null,
      staleSince: this.staleSince,
    };
  }

  applySnapshot(snap: Snapshot): void {
    if (snap.state.case === 'detail') this.apply(snap.state.value);
  }

  applyDelta(msg: ServerMessage): void {
    if (msg.body.case === 'detailUpdate') this.apply(msg.body.value);
  }

  onStateChange(_state: SubscriptionState, staleSince: number | null): void {
    this.staleSince = staleSince;
    this.onUpdate(this.state);
  }

  close(): void {
    this.core?.close();
    this.core = null;
  }

  private apply(d: DetailUpdate): void {
    this.loaded = true;
    if (d.state.case === 'row') {
      const next = toRowData(d.state.value);
      if (!this.row || next.version >= this.row.version || this.removed) this.row = next;
      this.removed = false;
    } else if (d.state.case === 'removed') {
      this.row = null;
      this.removed = true;
    }
    this.onUpdate(this.state);
  }
}
