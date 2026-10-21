import type { Row } from './view-diff.js';

/**
 * How a sortable column compares. Postgres returns `numeric` as a string, so
 * the type is declared: as text, "100" would sort before "25".
 */
export type SortType = 'text' | 'number' | 'time';

/** A column's value, ready to compare. Null sorts last. */
export type SortValue = string | number | null;

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

/**
 * Parses "item_price:desc" or "name" (ascending). Returns an error message
 * for an unknown column or direction.
 */
export function parseSort(
  spec: string,
  sortable: Readonly<Record<string, SortType>>,
): SortSpec | string {
  const [column, dir = 'asc', ...rest] = spec.split(':');
  if (rest.length > 0 || (dir !== 'asc' && dir !== 'desc')) {
    return `sort must be <column> or <column>:asc|desc, got ${spec}`;
  }
  if (!Object.hasOwn(sortable, column)) {
    const allowed = Object.keys(sortable).join(', ') || 'none';
    return `cannot sort by ${column}; sortable: ${allowed}`;
  }
  return { column, dir };
}

/**
 * Orders two ids by a column, then by id, so ties never swap places between
 * ticks. Text compares by UTF-16 code unit (like Postgres COLLATE "C"), fast
 * and the same on every worker. Null is last in both directions.
 */
export function compareBy(
  a: SortValue,
  aId: string,
  b: SortValue,
  bId: string,
  dir: SortSpec['dir'],
): number {
  if (a !== b) {
    if (a === null) {
      return 1;
    }
    if (b === null) {
      return -1;
    }
    const order = a < b ? -1 : 1;
    return dir === 'asc' ? order : -order;
  }
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * The sortable columns' values of every id a view holds, so any sort can be
 * built and kept in order from memory. Only these columns of a row are kept.
 */
export class SortKeys {
  /** column → id → value. */
  private readonly columns = new Map<string, Map<string, SortValue>>();

  constructor(readonly types: Readonly<Record<string, SortType>>) {
    for (const column of Object.keys(types)) {
      this.columns.set(column, new Map());
    }
  }

  /** Keeps the row's sortable values. Throws if the SQL doesn't select one. */
  set(row: Row): void {
    for (const [column, values] of this.columns) {
      if (!(column in row)) {
        throw new Error(
          `sortable column ${column} is not selected by the query`,
        );
      }
      values.set(row.id, toSortValue(this.types[column], row[column]));
    }
  }

  delete(id: string): void {
    for (const values of this.columns.values()) {
      values.delete(id);
    }
  }

  clear(): void {
    for (const values of this.columns.values()) {
      values.clear();
    }
  }

  /** The column's value for an id; undefined if the id or column isn't held. */
  get(column: string, id: string): SortValue | undefined {
    return this.columns.get(column)?.get(id);
  }
}

function toSortValue(type: SortType | undefined, raw: unknown): SortValue {
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
