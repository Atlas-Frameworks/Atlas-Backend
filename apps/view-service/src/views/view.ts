import type { SqlStatement } from './sql.js';

/** One open stream to a client (an SSE response in step 4). */
export interface ViewListener {
  send(message: unknown): void;
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
  /** Number of users that opened this view and haven't closed it. */
  refCount = 0;
  /** The first load from Postgres; shared by everyone who opens the view meanwhile. */
  loading: Promise<void> | undefined;

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
