/** One row of a view's query: a matching entity and its version. */
export interface VersionRow {
  id: string;
  version: number;
}

/** What changed in a view in one tick. Sent to clients as one `delta` event. */
export interface ViewDiff {
  /** Now matches, and wasn't in the view. */
  added: string[];
  /** Still matches, with a newer version. */
  updated: string[];
  /** No longer matches, or was deleted. */
  removed: string[];
}

export const emptyDiff = (): ViewDiff => ({
  added: [],
  updated: [],
  removed: [],
});

export const isEmpty = (diff: ViewDiff): boolean =>
  diff.added.length + diff.updated.length + diff.removed.length === 0;

/** Removes deleted entities from the view. No query is needed. */
export function applyDeletes(
  ids: Map<string, number>,
  deleted: Iterable<string>,
  diff: ViewDiff,
): void {
  for (const id of deleted) {
    if (ids.delete(id)) {
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
  ids: Map<string, number>,
  expected: ReadonlyMap<string, number>,
  rows: readonly VersionRow[],
  diff: ViewDiff,
): Map<string, number> {
  const matching = new Map<string, number>();
  for (const row of rows) {
    matching.set(row.id, row.version);
  }
  const retry = new Map<string, number>();
  for (const [id, minVersion] of expected) {
    const version = matching.get(id);
    if (version !== undefined && version < minVersion) {
      retry.set(id, minVersion);
    } else {
      apply(ids, id, version, diff);
    }
  }
  return retry;
}

/** Replaces the view's ids with the result of its full query. */
export function applyFull(
  ids: Map<string, number>,
  rows: readonly VersionRow[],
  diff: ViewDiff,
): void {
  const matching = new Set<string>();
  for (const row of rows) {
    matching.add(row.id);
    apply(ids, row.id, row.version, diff);
  }
  for (const id of ids.keys()) {
    if (!matching.has(id)) {
      apply(ids, id, undefined, diff);
    }
  }
}

/** `version` is the matching row's version, or undefined when it doesn't match. */
function apply(
  ids: Map<string, number>,
  id: string,
  version: number | undefined,
  diff: ViewDiff,
): void {
  const held = ids.get(id);
  if (version === undefined) {
    if (held !== undefined) {
      ids.delete(id);
      diff.removed.push(id);
    }
  } else if (held === undefined) {
    ids.set(id, version);
    diff.added.push(id);
  } else if (version > held) {
    ids.set(id, version);
    diff.updated.push(id);
  }
}
