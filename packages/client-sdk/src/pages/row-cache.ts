import type { Row } from '@atlas/protocol';

/** One list or detail row as the app sees it. */
export interface RowData {
  id: string;
  /** Root entity version. */
  version: number;
  /** Display fields chosen by the field registry (JSON values). */
  fields: Record<string, unknown>;
}

export function toRowData(row: Row): RowData {
  return { id: row.id, version: Number(row.version), fields: { ...row.fields } };
}

interface Entry {
  row: RowData;
  refs: number;
}

/**
 * Rows of open pages, keyed by entity id and shared by every page of one entity type. Each
 * page holds a reference to the ids it shows (or prefetches); a row is evicted when no open
 * page references it, so memory stays at "rows on open pages plus prefetch".
 */
export class RowCache {
  private readonly entries = new Map<string, Entry>();

  get size(): number {
    return this.entries.size;
  }

  get(id: string): RowData | undefined {
    return this.entries.get(id)?.row;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Stores a row. An older version never replaces a newer one. */
  put(row: RowData): void {
    const e = this.entries.get(row.id);
    if (!e) this.entries.set(row.id, { row, refs: 0 });
    else if (row.version >= e.row.version) e.row = row;
  }

  /**
   * Moves one holder's references from `before` to `after`, then evicts rows nobody holds.
   * Rows put for ids that are in neither list are evicted too.
   */
  retarget(before: readonly string[], after: readonly string[]): void {
    for (const id of after) {
      const e = this.entries.get(id);
      if (e) e.refs++;
      else this.entries.set(id, { row: placeholder(id), refs: 1 });
    }
    for (const id of before) {
      const e = this.entries.get(id);
      if (e) e.refs--;
    }
    for (const [id, e] of this.entries) if (e.refs <= 0) this.entries.delete(id);
  }

  /** True if a real row (not a placeholder) is cached. */
  isLoaded(id: string): boolean {
    const e = this.entries.get(id);
    return e !== undefined && e.row.version >= 0;
  }
}

function placeholder(id: string): RowData {
  return { id, version: -1, fields: {} };
}
