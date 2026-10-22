/**
 * The ids a view holds, in the query's order. Any range of rows is a slice
 * of `ids`, with no query. Sorted once when built; after that a changed id is
 * taken out and put back by binary search, never by sorting again.
 */
export class SortedIndex {
  private readonly order: string[];

  constructor(
    /** Compares two held ids by their current values. */
    private readonly compare: (a: string, b: string) => number,
    ids: Iterable<string>,
  ) {
    this.order = Array.from(ids).sort(compare);
  }

  /** The ids in order. Read it at once: it changes as the view changes. */
  get ids(): readonly string[] {
    return this.order;
  }

  /** Puts an id at its place by its current values. */
  insert(id: string): void {
    this.order.splice(this.lowerBound(id), 0, id);
  }

  /**
   * Takes an id out. Call it before the id's values change: the search uses
   * the values the id was placed with.
   */
  remove(id: string): void {
    let i = this.lowerBound(id);
    if (this.order[i] !== id) {
      // Only if a value changed without a remove first: a slow, safe fallback.
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
}
