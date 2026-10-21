import { SortKeys, type SortSpec, type SortType } from './sort-keys.js';
import type { SortedIndex } from './sorted-index.js';
import type { LiveWindow } from './live-window.js';
import type { SqlStatement } from './sql.js';
import type { Membership } from './view-diff.js';

/** A message for everyone streaming a view. `seq` grows by one per event. */
export interface ViewEvent {
  type: string;
  seq: number;
  data: unknown;
}

/** One open stream to a client (an SSE response). */
export interface ViewListener {
  send(event: ViewEvent): void;
}

/**
 * One distinct query. Every user with the same viewKey shares it.
 * Holds matching IDs with a version and a row hash, never whole rows:
 * rows are read from Postgres by id when they are sent.
 */
export class View implements Membership {
  /**
   * IDs that match the query right now, with the entity version last seen.
   * A Map for the POC; E-04's typed-array store replaces it.
   */
  readonly ids = new Map<string, number>();
  /** id → hash of the row last seen, to notice a changed column. */
  readonly hashes = new Map<string, number>();
  readonly sortKeys: SortKeys;
  /** Streams of the whole view: a snapshot, then every delta. */
  readonly listeners = new Set<ViewListener>();
  /** Live ranges of the view, by window key; each has its own listeners. */
  readonly windows = new Map<string, LiveWindow>();
  /** Sequence number of the last message sent for this view. */
  seq = 0;
  /** Set while nobody streams the view: it is removed when this fires. */
  closeTimer: NodeJS.Timeout | undefined;
  /** When the close timer fires (ms since epoch), for debugging. */
  closesAt: number | undefined;
  /** The first load from Postgres; shared by everyone who opens the view meanwhile. */
  loading: Promise<void> | undefined;
  /** True once `ids` holds the result of the full query. */
  loaded = false;

  constructor(
    readonly viewKey: string,
    readonly entityType: string,
    /** The full query: returns id, version and the columns sent to clients. */
    readonly statement: SqlStatement,
    sortable: Readonly<Record<string, SortType>> = {},
    /** The sort when a client asks for none; undefined: by id. */
    readonly defaultSort?: SortSpec,
  ) {
    this.sortKeys = new SortKeys(sortable);
  }

  /**
   * The held ids in this sort (by id when undefined). Built from memory on
   * first use, then kept in order as the view changes.
   */
  sorted(spec: SortSpec | undefined): SortedIndex {
    return this.sortKeys.index(spec, this.ids.keys());
  }

  /** True while any client streams the view, whole or a range of it. */
  inUse(): boolean {
    return this.listeners.size > 0 || this.windows.size > 0;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
