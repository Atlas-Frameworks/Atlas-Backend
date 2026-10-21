import type { SortSpec } from './sort-keys.js';
import { sortName } from './sorted-index.js';
import type { ViewListener } from './view.js';

/** The data of a `window` event: one range of a view in one sort. */
export interface WindowData {
  sort: string;
  offset: number;
  /** Rows in the whole view. */
  total: number;
  /** Every id in the range, in order. */
  ids: string[];
  /** Full rows: all of them in the first event; later, only ids new to the range or changed. */
  rows: unknown[];
}

/**
 * One range of a view kept live, e.g. rows 7–26 by price. Every client
 * streaming the same view, sort and range shares it. It has its own seq,
 * because it gets an event only when its own range changes.
 */
export class LiveWindow {
  readonly listeners = new Set<ViewListener>();
  /** The ids last sent, in order. */
  ids: string[] = [];
  /** The total last sent. */
  total = 0;
  /** Sequence number of the last event sent. */
  seq = 0;
  /** The last update couldn't read its rows: compare again next tick. */
  stale = false;

  constructor(
    /** Undefined: by id. */
    readonly spec: SortSpec | undefined,
    readonly offset: number,
    readonly limit: number,
  ) {}

  get key(): string {
    return windowKey(this.spec, this.offset, this.limit);
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}

export function windowKey(
  spec: SortSpec | undefined,
  offset: number,
  limit: number,
): string {
  return `${sortName(spec)}|${offset}|${limit}`;
}
