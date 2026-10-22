import type { OrderKey } from './order.js';
import { SortKeys } from './sort-keys.js';
import type { LiveWindow } from './live-window.js';
import { RefIndex } from './ref-index.js';
import type { SqlStatement } from './sql.js';
import type { Membership, Row } from './view-diff.js';

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
 * Holds the rows of its result, so any page or snapshot is answered from
 * memory; the tick keeps them current.
 */
export class View implements Membership {
  /**
   * IDs that match the query right now, with the entity version last seen.
   * A Map for the POC; E-04's typed-array store replaces it.
   */
  readonly ids = new Map<string, number>();
  /** id → the row as the query last returned it. */
  readonly rows = new Map<string, Row>();
  readonly sortKeys: SortKeys;
  /** Related id → held ids, for each `via` column of the query's dependencies. */
  readonly refs: RefIndex;
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
    /** The query's ORDER BY; empty: by id. */
    order: readonly OrderKey[] = [],
    /** Columns holding related ids, from the dependencies' `via`. */
    via: readonly string[] = [],
  ) {
    this.sortKeys = new SortKeys(order);
    this.refs = new RefIndex(via);
  }

  /** The query's ORDER BY. */
  get order(): readonly OrderKey[] {
    return this.sortKeys.order;
  }

  /**
   * The held ids in the query's order. Built from memory on first use, then
   * kept in order as the view changes. Read it at once: it changes with the view.
   */
  sorted(): readonly string[] {
    return this.sortKeys.sorted(this.ids.keys()).ids;
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
