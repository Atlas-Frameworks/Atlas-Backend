import type { PageWindow, ServerMessage, Snapshot } from '@atlas/protocol';
import type { CoreView } from '../core/atlas-core.js';
import type { Subscription, SubscriptionHandler, SubscriptionState } from '../core/subscription.js';
import type { LocateAnswer } from '../core/types.js';
import { toRowData } from './row-cache.js';
import type { RowCache, RowData } from './row-cache.js';

export interface GroupCountData {
  groupPath: string[];
  count: number;
}

export interface PageOptions {
  /** Group values from the outermost group; `[]` = the whole list (default). */
  groupPath?: string[];
  /** 0-based (default 0). */
  page?: number;
  /** Rows per page (default 50). */
  pageSize?: number;
  /** Also subscribe to the next page so moving forward is instant (default false). */
  prefetch?: boolean;
}

/** What the UI renders for one live page. Rows are tracked by `id`, never by position. */
export interface PageState {
  /** In display order. A row with `version === -1` has not arrived yet. */
  rows: RowData[];
  total: number;
  pageCount: number;
  /** The page shown (0-based); can be lower than requested when the list shrank. */
  page: number;
  pageSize: number;
  groupPath: string[];
  groupCounts: GroupCountData[];
  /** True until the first snapshot of the current page arrives. */
  loading: boolean;
  stale: boolean;
  staleSince: number | null;
  /** Order is frozen (the user hovers or scrolls). */
  frozen: boolean;
  /** While frozen: how many positions differ from the latest server order. */
  pendingReorder: number;
}

interface WindowData {
  page: number;
  ids: string[];
  total: number;
  pageCount: number;
  groupCounts: GroupCountData[];
  pageSize: number;
  groupPath: string[];
  loaded: boolean;
}

function emptyWindow(groupPath: string[], page: number, pageSize: number): WindowData {
  return {
    page,
    ids: [],
    total: 0,
    pageCount: 0,
    groupCounts: [],
    pageSize,
    groupPath,
    loaded: false,
  };
}

let nextWindow = 1;

/**
 * One live server-side page (C-03), with optional prefetch of the next page and reorder
 * damping. Rebuilds the page from `orderedIds` plus the shared {@link RowCache}.
 */
export class PageSubscription {
  readonly windowRef: string;
  private readonly prefetchRef: string;
  private groupPath: string[];
  private page: number;
  private readonly pageSize: number;
  private readonly prefetch: boolean;

  private main: WindowData;
  private next: WindowData | null = null;
  private displayIds: string[] = [];
  private held: string[] = [];
  private prefetchHeld: string[] = [];
  private frozen = false;
  private staleSince: number | null = null;
  private mainSub: Subscription | null = null;
  private closed = false;

  constructor(
    private readonly view: CoreView,
    private readonly cache: RowCache,
    options: PageOptions,
    private readonly onUpdate: (state: PageState) => void,
  ) {
    const n = nextWindow++;
    this.windowRef = `w${n}`;
    this.prefetchRef = `w${n}-next`;
    this.groupPath = options.groupPath ?? [];
    this.page = options.page ?? 0;
    this.pageSize = options.pageSize ?? 50;
    this.prefetch = options.prefetch ?? false;
    this.main = emptyWindow(this.groupPath, this.page, this.pageSize);
    this.openWindows();
  }

  get state(): PageState {
    const rows = this.displayIds.map((id) => this.cache.get(id) ?? { id, version: -1, fields: {} });
    return {
      rows,
      total: this.main.total,
      pageCount: this.main.pageCount,
      page: this.main.page,
      pageSize: this.pageSize,
      groupPath: this.groupPath,
      groupCounts: this.main.groupCounts,
      loading: !this.main.loaded,
      stale: this.staleSince !== null,
      staleSince: this.staleSince,
      frozen: this.frozen,
      pendingReorder: this.frozen ? countDifferences(this.displayIds, this.main.ids) : 0,
    };
  }

  /** Moves to another page (0-based). Prefetched rows show at once if available. */
  setPage(page: number): void {
    if (this.closed || page === this.page) return;
    const prefetched = this.next && this.next.loaded && this.next.page === page ? this.next : null;
    this.page = page;
    this.main = prefetched
      ? { ...prefetched, loaded: false }
      : emptyWindow(this.groupPath, page, this.pageSize);
    this.frozen = false;
    this.displayIds = prefetched ? [...prefetched.ids] : [];
    this.retainMain();
    this.openWindows();
    this.emit();
  }

  /** Shows another group (page 0). */
  setGroupPath(groupPath: string[]): void {
    if (this.closed) return;
    this.groupPath = groupPath;
    this.page = 0;
    this.main = emptyWindow(groupPath, 0, this.pageSize);
    this.frozen = false;
    this.displayIds = [];
    this.retainMain();
    this.openWindows();
    this.emit();
  }

  /**
   * While true, keep the current row order and update row data in place, reporting
   * `pendingReorder`. Set back to false to apply the latest order.
   */
  setFreezeOrder(frozen: boolean): void {
    if (this.frozen === frozen) return;
    this.frozen = frozen;
    if (!frozen) {
      this.displayIds = [...this.main.ids];
      this.retainMain();
    }
    this.emit();
  }

  /** The page `id` is on now; with `jump`, also moves there when found. */
  async locate(id: string, options: { jump?: boolean } = {}): Promise<LocateAnswer> {
    const answer = await this.view.locate(id, this.pageSize);
    if (options.jump && answer.found) {
      const samePath =
        answer.groupPath.length === this.groupPath.length &&
        answer.groupPath.every((g, i) => g === this.groupPath[i]);
      if (!samePath) this.setGroupPath(answer.groupPath);
      this.setPage(answer.page);
    }
    return answer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.view.closeWindow(this.windowRef);
    if (this.prefetch) this.view.closeWindow(this.prefetchRef);
    this.cache.retarget(this.held, []);
    this.cache.retarget(this.prefetchHeld, []);
    this.held = [];
    this.prefetchHeld = [];
  }

  // ---------------------------------------------------------------------------

  private openWindows(): void {
    this.mainSub = this.view.setWindow(
      this.windowRef,
      { groupPath: this.groupPath, page: this.page, pageSize: this.pageSize },
      this.mainHandler,
    );
    if (this.prefetch) {
      this.next = emptyWindow(this.groupPath, this.page + 1, this.pageSize);
      this.cache.retarget(this.prefetchHeld, []);
      this.prefetchHeld = [];
      this.view.setWindow(
        this.prefetchRef,
        { groupPath: this.groupPath, page: this.page + 1, pageSize: this.pageSize },
        this.prefetchHandler,
      );
    }
  }

  private readonly mainHandler: SubscriptionHandler = {
    applySnapshot: (snap: Snapshot) => {
      if (snap.state.case !== 'page') return;
      this.applyMain(snap.state.value, true);
    },
    applyDelta: (msg: ServerMessage) => {
      if (msg.body.case !== 'pageWindow') return;
      this.applyMain(msg.body.value, false);
    },
    onStateChange: (_state: SubscriptionState, staleSince) => {
      this.staleSince = staleSince;
      this.emit();
    },
  };

  private readonly prefetchHandler: SubscriptionHandler = {
    applySnapshot: (snap: Snapshot) => {
      if (snap.state.case === 'page') this.applyPrefetch(snap.state.value);
    },
    applyDelta: (msg: ServerMessage) => {
      if (msg.body.case === 'pageWindow') this.applyPrefetch(msg.body.value);
    },
  };

  private applyMain(w: PageWindow, isSnapshot: boolean): void {
    for (const r of w.rows) this.cache.put(toRowData(r));
    this.main = fromWire(w, this.groupPath, this.pageSize);
    if (isSnapshot || !this.frozen) {
      // A snapshot can be a different page (the list shrank): always show it as sent.
      if (isSnapshot) this.frozen = this.frozen && w.page === this.page;
      if (!this.frozen) this.displayIds = [...this.main.ids];
    }
    this.page = this.main.page;
    this.retainMain();
    if (!isSnapshot && this.main.ids.some((id) => !this.cache.isLoaded(id))) {
      // The server sent an id without its row: our cache diverged. Ask for a fresh snapshot.
      this.mainSub?.resync();
    }
    this.emit();
  }

  private applyPrefetch(w: PageWindow): void {
    for (const r of w.rows) this.cache.put(toRowData(r));
    this.next = fromWire(w, this.groupPath, this.pageSize);
    const ids = [...this.next.ids];
    this.cache.retarget(this.prefetchHeld, ids);
    this.prefetchHeld = ids;
  }

  /** Holds the rows shown plus the latest order's rows (they differ only while frozen). */
  private retainMain(): void {
    const ids = this.frozen
      ? [...new Set([...this.displayIds, ...this.main.ids])]
      : [...this.displayIds];
    this.cache.retarget(this.held, ids);
    this.held = ids;
  }

  private emit(): void {
    if (!this.closed) this.onUpdate(this.state);
  }
}

function fromWire(w: PageWindow, groupPath: string[], pageSize: number): WindowData {
  return {
    page: w.page,
    ids: [...w.orderedIds],
    total: w.total,
    pageCount: w.pageCount,
    groupCounts: w.groupCounts.map((g) => ({ groupPath: [...g.groupPath], count: g.count })),
    pageSize: w.pageSize || pageSize,
    groupPath: w.groupPath.length > 0 ? [...w.groupPath] : groupPath,
    loaded: true,
  };
}

/** Positions where two orders differ (over the longer of the two). */
function countDifferences(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) n++;
  return n;
}
