import type { SqlStatement } from './sql.js';

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
 * Holds only matching IDs, never whole entities.
 */
export class View {
  /**
   * IDs that match the query right now, with the entity version last seen.
   * A Map for the POC; E-04's typed-array store replaces it.
   */
  readonly ids = new Map<string, number>();
  readonly listeners = new Set<ViewListener>();
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
    /** The full query: returns id and version of every matching entity. */
    readonly statement: SqlStatement,
  ) {}

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
