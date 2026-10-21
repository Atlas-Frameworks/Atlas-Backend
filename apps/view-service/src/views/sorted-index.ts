import { compareBy, type SortSpec, type SortValue } from './sort-keys.js';

/** The name of a sort, e.g. "item_price:desc", or "id" for the order by id. */
export function sortName(spec: SortSpec | undefined): string {
  return spec ? `${spec.column}:${spec.dir}` : 'id';
}

/**
 * The ids a view holds, in one sort order. Any range of rows is a slice of
 * `ids`, with no query. Sorted once when built; after that a changed id is
 * taken out and put back by binary search, never by sorting again.
 */
export class SortedIndex {
  private readonly order: string[];

  constructor(
    /** Undefined: by id. */
    readonly spec: SortSpec | undefined,
    /** The id's current value in the sort column. */
    private readonly valueOf: (id: string) => SortValue,
    ids: Iterable<string>,
  ) {
    this.order = Array.from(ids).sort((a, b) => this.compare(a, b));
  }

  /** The ids in order. Read it at once: it changes as the view changes. */
  get ids(): readonly string[] {
    return this.order;
  }

  /** Puts an id at its place by its current value. */
  insert(id: string): void {
    this.order.splice(this.lowerBound(id), 0, id);
  }

  /**
   * Takes an id out. Call it before the id's value changes: the search uses
   * the value the id was placed with.
   */
  remove(id: string): void {
    let i = this.lowerBound(id);
    if (this.order[i] !== id) {
      // Only if the value changed without a remove first: a slow, safe fallback.
      i = this.order.indexOf(id);
    }
    if (i >= 0) {
      this.order.splice(i, 1);
    }
  }

  /** The first position whose id doesn't sort before `id`. */
  private lowerBound(id: string): number {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.order[mid], id) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private compare(a: string, b: string): number {
    if (!this.spec) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return compareBy(this.valueOf(a), a, this.valueOf(b), b, this.spec.dir);
  }
}
