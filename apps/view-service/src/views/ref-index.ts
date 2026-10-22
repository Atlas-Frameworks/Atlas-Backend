import type { Row } from './view-diff.js';

/**
 * For each `via` column of a view (e.g. `item_id`): related id → ids of the
 * held rows that reference it. A change to an item then finds the orders it
 * shows in from memory, with no link query.
 */
export class RefIndex {
  /** column → related id → held ids. */
  private readonly columns = new Map<string, Map<string, Set<string>>>();

  constructor(columns: readonly string[]) {
    for (const column of columns) {
      this.columns.set(column, new Map());
    }
  }

  /** Records the row's references; `prev` is the row held before, if any. Throws if a via column isn't selected. */
  set(row: Row, prev: Row | undefined): void {
    for (const [column, refs] of this.columns) {
      if (!(column in row)) {
        throw new Error(`via column ${column} is not selected by the query`);
      }
      const next = refOf(row[column]);
      const before = prev ? refOf(prev[column]) : undefined;
      if (prev && before === next) {
        continue;
      }
      if (before !== undefined) {
        remove(refs, before, row.id);
      }
      if (next !== undefined) {
        let ids = refs.get(next);
        if (!ids) {
          ids = new Set();
          refs.set(next, ids);
        }
        ids.add(row.id);
      }
    }
  }

  /** Forgets a row the view no longer holds. */
  delete(row: Row): void {
    for (const [column, refs] of this.columns) {
      const ref = refOf(row[column]);
      if (ref !== undefined) {
        remove(refs, ref, row.id);
      }
    }
  }

  clear(): void {
    for (const refs of this.columns.values()) {
      refs.clear();
    }
  }

  /** Ids of held rows whose `column` is `relatedId`. */
  heldBy(column: string, relatedId: string): ReadonlySet<string> {
    return this.columns.get(column)?.get(relatedId) ?? EMPTY;
  }
}

const EMPTY: ReadonlySet<string> = new Set();

function refOf(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function remove(refs: Map<string, Set<string>>, ref: string, id: string): void {
  const ids = refs.get(ref);
  ids?.delete(id);
  if (ids?.size === 0) {
    refs.delete(ref);
  }
}
