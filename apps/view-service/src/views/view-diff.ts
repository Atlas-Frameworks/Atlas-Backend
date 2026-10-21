import { createHash } from 'node:crypto';
import type { SortKeys } from './sort-keys.js';

/** One row of a view's query: `id`, `version`, and the columns the developer selected. */
export type Row = { id: string; version: number } & Record<string, unknown>;

/**
 * What a view keeps per entity. No row data: only what is needed to tell
 * whether a row it sees again has changed.
 */
export interface Membership {
  /** id → version. */
  readonly ids: Map<string, number>;
  /** id → hash of the row last seen. A changed column, also one joined from a related entity, changes it. */
  readonly hashes: Map<string, number>;
  /** The sortable columns' values of every id held. */
  readonly sortKeys: SortKeys;
}

/** What changed in a view in one tick. Sent to clients as one `delta` event. */
export interface ViewDiff {
  /** Now matches, and wasn't in the view: the full row. */
  added: Row[];
  /** Still matches, and the row changed: the full row. */
  updated: Row[];
  /** No longer matches, or was deleted: the id. */
  removed: string[];
}

export const emptyDiff = (): ViewDiff => ({
  added: [],
  updated: [],
  removed: [],
});

export const isEmpty = (diff: ViewDiff): boolean =>
  diff.added.length + diff.updated.length + diff.removed.length === 0;

/** 48 bits of the row's SHA-1: fits a number, and a collision is not a practical concern. */
export function hashRow(row: Row): number {
  return createHash('sha1')
    .update(JSON.stringify(row))
    .digest()
    .readUIntBE(0, 6);
}

/** Stores a row the view now holds, or a newer version of it. */
export function hold(view: Membership, row: Row, hash = hashRow(row)): void {
  view.ids.set(row.id, row.version);
  view.hashes.set(row.id, hash);
  view.sortKeys.set(row);
}

/** Forgets an id the view no longer holds. */
function drop(view: Membership, id: string): void {
  view.ids.delete(id);
  view.hashes.delete(id);
  view.sortKeys.delete(id);
}

/** Removes deleted entities from the view. No query is needed. */
export function applyDeletes(
  view: Membership,
  deleted: Iterable<string>,
  diff: ViewDiff,
): void {
  for (const id of deleted) {
    if (view.ids.has(id)) {
      drop(view, id);
      diff.removed.push(id);
    }
  }
}

/**
 * Applies the result of re-checking some ids. `expected` holds each re-checked
 * id with the lowest version the result must have (0 when any will do); `rows`
 * are the ids that still match. A row older than expected comes from a replica
 * that is behind: it is left out and returned in `retry`, for the next tick.
 */
export function applyRecheck(
  view: Membership,
  expected: ReadonlyMap<string, number>,
  rows: readonly Row[],
  diff: ViewDiff,
): Map<string, number> {
  const matching = new Map<string, Row>();
  for (const row of rows) {
    matching.set(row.id, row);
  }
  const retry = new Map<string, number>();
  for (const [id, minVersion] of expected) {
    const row = matching.get(id);
    if (row && row.version < minVersion) {
      retry.set(id, minVersion);
    } else {
      apply(view, id, row, diff);
    }
  }
  return retry;
}

/** Replaces the view's ids with the result of its full query. */
export function applyFull(
  view: Membership,
  rows: readonly Row[],
  diff: ViewDiff,
): void {
  const matching = new Set<string>();
  for (const row of rows) {
    matching.add(row.id);
    apply(view, row.id, row, diff);
  }
  for (const id of view.ids.keys()) {
    if (!matching.has(id)) {
      apply(view, id, undefined, diff);
    }
  }
}

/** `row` is the matching row, or undefined when the id doesn't match. */
function apply(
  view: Membership,
  id: string,
  row: Row | undefined,
  diff: ViewDiff,
): void {
  const held = view.ids.get(id);
  if (!row) {
    if (held !== undefined) {
      drop(view, id);
      diff.removed.push(id);
    }
  } else if (held === undefined) {
    hold(view, row);
    diff.added.push(row);
  } else if (row.version >= held) {
    // An older row than the one held is a lagging replica: keep what we have.
    const hash = hashRow(row);
    if (row.version > held || hash !== view.hashes.get(id)) {
      hold(view, row, hash);
      diff.updated.push(row);
    }
  }
}
