import type { FilterTree } from './view-key.js';

/** One open stream to a client (an SSE response in step 4). */
export interface ViewListener {
  send(message: unknown): void;
}

/**
 * One distinct query: entity type + filter. Every user with the same query shares it.
 * Holds only matching IDs, never whole entities.
 */
export class View {
  /** IDs that match the filter right now. A Set for the POC; E-04's typed-array store replaces it. */
  readonly ids = new Set<string>();
  readonly listeners = new Set<ViewListener>();
  /** Sequence number of the last message sent for this view. */
  seq = 0;
  /** Number of users that opened this view and haven't closed it. */
  refCount = 0;

  constructor(
    readonly viewKey: string,
    readonly entityType: string,
    readonly filter: FilterTree,
  ) {}

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
