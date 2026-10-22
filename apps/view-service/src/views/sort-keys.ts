import type { OrderKey, SortType } from './order.js';
import { SortedIndex } from './sorted-index.js';
import type { Row } from './view-diff.js';

/** A column's value, ready to compare. Null sorts last. */
export type SortValue = string | number | null;

/**
 * Compares one ORDER BY key. Null is last in both directions, as NULLS LAST
 * in the SQL. Text compares by UTF-16 code unit, which matches COLLATE "C"
 * except for characters beyond U+FFFF.
 */
export function compareValues(
  a: SortValue,
  b: SortValue,
  dir: OrderKey['dir'],
): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  const order = a < b ? -1 : 1;
  return dir === 'asc' ? order : -order;
}

/**
 * The ORDER BY columns' values of every id a view holds, and the index of
 * the ids in that order. Only these columns of a row are kept here. The index
 * is built on first use and then kept in order by `set` and `delete`.
 */
export class SortKeys {
  /** column → id → value. */
  private readonly columns = new Map<string, Map<string, SortValue>>();
  private index: SortedIndex | undefined;

  constructor(readonly order: readonly OrderKey[]) {
    for (const key of order) {
      this.columns.set(key.column, new Map());
    }
  }

  /** The held ids in order. Built from `ids` (every id held) on first use. */
  sorted(ids: Iterable<string>): SortedIndex {
    this.index ??= new SortedIndex((a, b) => this.compare(a, b), ids);
    return this.index;
  }

  /**
   * Keeps the row's order values, and moves it in the index if one changed
   * (`isNew`: adds it). Throws if the SQL doesn't select an ORDER BY column.
   */
  set(row: Row, isNew: boolean): void {
    let moved = isNew;
    const next = new Map<string, SortValue>();
    for (const key of this.order) {
      if (!(key.column in row)) {
        throw new Error(
          `order column ${key.column} is not selected by the query`,
        );
      }
      const value = toSortValue(key.type, row[key.column]);
      next.set(key.column, value);
      if (!isNew && this.columns.get(key.column)!.get(row.id) !== value) {
        moved = true;
      }
    }
    // Out before the values change: remove finds the id by its old values.
    if (moved && !isNew) {
      this.index?.remove(row.id);
    }
    for (const [column, value] of next) {
      this.columns.get(column)!.set(row.id, value);
    }
    if (moved) {
      this.index?.insert(row.id);
    }
  }

  delete(id: string): void {
    this.index?.remove(id);
    for (const values of this.columns.values()) {
      values.delete(id);
    }
  }

  /** Forgets every value, and drops the index: it is built again on next use. */
  clear(): void {
    for (const values of this.columns.values()) {
      values.clear();
    }
    this.index = undefined;
  }

  /** The column's value for an id; undefined if the id or column isn't held. */
  get(column: string, id: string): SortValue | undefined {
    return this.columns.get(column)?.get(id);
  }

  /** Orders two held ids like the query's ORDER BY: each key, then the id. */
  compare(a: string, b: string): number {
    for (const key of this.order) {
      const values = this.columns.get(key.column)!;
      const c = compareValues(
        values.get(a) ?? null,
        values.get(b) ?? null,
        key.dir,
      );
      if (c !== 0) {
        return c;
      }
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

function toSortValue(type: SortType, raw: unknown): SortValue {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    }
    case 'time': {
      const t = (raw instanceof Date ? raw : new Date(String(raw))).getTime();
      return Number.isNaN(t) ? null : t;
    }
    default:
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
}
