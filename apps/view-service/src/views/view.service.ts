import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ChangeFeed } from '../changes/change-feed.js';
import {
  defaultSortOf,
  queryKey,
  type QueryDefinition,
} from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import { toStatement } from './sql.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import type { SortSpec } from './sort-keys.js';
import { sortName } from './sorted-index.js';
import { LiveWindow, windowKey, type WindowData } from './live-window.js';
import type { Row } from './view-diff.js';
import type { View, ViewEvent, ViewListener } from './view.js';

/**
 * How long a view nobody streams stays in memory, so a client that reconnects
 * or opens it again within this time gets it without a new load.
 */
export const CLOSE_AFTER_MS = 60_000;

/** Which rows to read: a sort, and a range of it. Every part is optional. */
export interface PageRequest {
  /** Default: the view's default sort, or by id. */
  sort?: SortSpec;
  /** Position of the first row, from 0. Default 0. */
  offset?: number;
  /** Default: every row from `offset` on. */
  limit?: number;
}

/** A range of a view's rows in one sort: what a route returns, and the first event of a stream. */
export interface ViewPage {
  viewKey: string;
  seq: number;
  /** "column:dir", or "id". */
  sort: string;
  offset: number;
  /** Rows in the whole view, not only in this page. */
  total: number;
  rows: Row[];
}

/**
 * Opens views for any route, and closes them once nobody streams them.
 * Routes never see the registry or the loader.
 */
@Injectable()
export class ViewService implements OnModuleDestroy {
  private readonly logger = new Logger(ViewService.name);

  constructor(
    private readonly registry: ViewRegistry,
    private readonly loader: ViewLoader,
    private readonly dependencies: DependencyIndex,
    private readonly feed: ChangeFeed,
  ) {}

  /**
   * Opens the view for a query and its params, or joins the existing one.
   * Undefined params don't change the viewKey and are left to `build` to skip.
   * Dependencies are registered and their streams' positions recorded before
   * the load, so every change from that point on is read. The view closes
   * CLOSE_AFTER_MS after this unless a client starts streaming it.
   */
  async open<P>(
    query: QueryDefinition<P>,
    params: P,
    page: PageRequest = {},
  ): Promise<ViewPage> {
    const view = this.registry.open(
      queryKey(query.name, params),
      query.entityType,
      toStatement(query.build(params)),
      query.sortable,
      defaultSortOf(query),
    );
    this.cancelClose(view);
    this.dependencies.add(view.viewKey, query.entityType, query.dependsOn);
    try {
      await this.feed.watch(
        Object.keys(this.dependencies.dependenciesOf(view.viewKey)!),
      );
      await this.loader.ensureLoaded(view);
      return await this.page(view, page);
    } catch (err) {
      this.logger.error(`opening view ${view.viewKey} failed`, err);
      throw new ServiceUnavailableException({
        code: 'RETRY',
        message: 'could not load the view, try again',
      });
    } finally {
      this.closeWhenIdle(view);
    }
  }

  /** A client started streaming the view: it stays open. */
  addListener(view: View, listener: ViewListener): void {
    view.listeners.add(listener);
    this.cancelClose(view);
  }

  /** A client stopped streaming the view: the last one starts the close timer. */
  removeListener(view: View, listener: ViewListener): void {
    view.listeners.delete(listener);
    this.closeWhenIdle(view);
  }

  /**
   * Removes the view and everything kept for it, unless a client streams it.
   * Streams that no other view reads are no longer read.
   */
  close(view: View): void {
    if (this.registry.get(view.viewKey) !== view || view.inUse()) {
      return;
    }
    this.cancelClose(view);
    this.registry.remove(view.viewKey);
    const types = Object.keys(
      this.dependencies.dependenciesOf(view.viewKey) ?? {},
    );
    this.dependencies.remove(view.viewKey);
    const stillWatched = new Set(this.dependencies.watchedTypes());
    this.feed.unwatch(types.filter((type) => !stillWatched.has(type)));
    this.logger.log(`closed view ${view.viewKey}`);
  }

  onModuleDestroy(): void {
    for (const view of this.registry.list()) {
      this.cancelClose(view);
    }
  }

  /**
   * A range of the view's rows at its current seq. Which ids, and their
   * order, come from memory at the call, with no query; then only those
   * rows are read by id. A row may already be newer than seq, or gone: the
   * deltas after seq bring the client to the same state.
   */
  page(view: View, request: PageRequest): Promise<ViewPage> {
    const spec = request.sort ?? view.defaultSort;
    const sorted = view.sorted(spec).ids;
    const offset = request.offset ?? 0;
    const ids = sorted.slice(
      offset,
      request.limit === undefined ? undefined : offset + request.limit,
    );
    const page = {
      viewKey: view.viewKey,
      seq: view.seq,
      sort: sortName(spec),
      offset,
      total: sorted.length,
    };
    return this.loader
      .fetchByIds(view, ids)
      .then((rows) => ({ ...page, rows: inOrder(rows, ids) }));
  }

  /**
   * A page of an open view, for a client that already has its viewKey. Like
   * opening it again, this restarts its close timer if nobody streams it.
   */
  async read(view: View, request: PageRequest): Promise<ViewPage> {
    this.closeWhenIdle(view);
    try {
      return await this.page(view, request);
    } catch (err) {
      this.logger.error(`reading view ${view.viewKey} failed`, err);
      throw new ServiceUnavailableException({
        code: 'RETRY',
        message: 'could not read the rows, try again',
      });
    }
  }

  /**
   * Starts streaming one range of the view. The window is shared by every
   * client on the same sort and range, and created by the first. `first`
   * resolves to the first event: the window's ids and seq taken at the call,
   * and their rows.
   */
  openWindow(
    view: View,
    request: PageRequest & { limit: number },
    listener: ViewListener,
  ): { window: LiveWindow; first: Promise<ViewEvent> } {
    const spec = request.sort ?? view.defaultSort;
    const offset = request.offset ?? 0;
    const key = windowKey(spec, offset, request.limit);
    let window = view.windows.get(key);
    if (!window) {
      window = new LiveWindow(spec, offset, request.limit);
      const sorted = view.sorted(spec).ids;
      window.ids = sorted.slice(offset, offset + request.limit);
      window.total = sorted.length;
      view.windows.set(key, window);
    }
    const { seq, ids, total } = window;
    window.listeners.add(listener);
    this.cancelClose(view);
    const first = this.loader.fetchByIds(view, ids).then((rows): ViewEvent => ({
      type: 'window',
      seq,
      data: windowData(window, total, ids, inOrder(rows, ids)),
    }));
    return { window, first };
  }

  /** A client stopped streaming a range; the last one removes the window. */
  closeWindow(view: View, window: LiveWindow, listener: ViewListener): void {
    window.listeners.delete(listener);
    if (
      window.listeners.size === 0 &&
      view.windows.get(window.key) === window
    ) {
      view.windows.delete(window.key);
    }
    this.closeWhenIdle(view);
  }

  /**
   * After a tick changed the view: sends a `window` event to each range
   * whose ids, order or total changed, or that holds a changed row. Rows
   * come from `changed` (the tick's re-check) when they can; the rest, rows
   * that slid into a range unchanged, are read in one query for the view.
   */
  async publishWindows(
    view: View,
    changed: ReadonlyMap<string, Row>,
  ): Promise<void> {
    const updates: {
      window: LiveWindow;
      ids: string[];
      total: number;
      send: string[];
    }[] = [];
    const missing = new Set<string>();
    for (const window of view.windows.values()) {
      const sorted = view.sorted(window.spec).ids;
      const ids = sorted.slice(window.offset, window.offset + window.limit);
      const sent = new Set(window.ids);
      const send = ids.filter((id) => !sent.has(id) || changed.has(id));
      const sameIds =
        ids.length === window.ids.length &&
        ids.every((id, i) => id === window.ids[i]);
      if (
        sameIds &&
        send.length === 0 &&
        sorted.length === window.total &&
        !window.stale
      ) {
        continue;
      }
      for (const id of send) {
        if (!changed.has(id)) {
          missing.add(id);
        }
      }
      updates.push({ window, ids, total: sorted.length, send });
    }
    if (updates.length === 0) {
      return;
    }
    let read: Row[];
    try {
      read = await this.loader.fetchByIds(view, [...missing]);
    } catch (err) {
      this.logger.error(
        `reading rows for windows of ${view.viewKey} failed`,
        err,
      );
      for (const { window } of updates) {
        window.stale = true;
      }
      return;
    }
    const fetched = new Map(read.map((row) => [row.id, row]));
    for (const { window, ids, total, send } of updates) {
      window.ids = ids;
      window.total = total;
      window.stale = false;
      const rows = send.flatMap(
        (id) => changed.get(id) ?? fetched.get(id) ?? [],
      );
      const event: ViewEvent = {
        type: 'window',
        seq: window.nextSeq(),
        data: windowData(window, total, ids, rows),
      };
      for (const listener of window.listeners) {
        listener.send(event);
      }
    }
  }

  /** Sends an event to everyone streaming the view, numbered with the next seq. */
  publish(view: View, type: string, data: unknown): ViewEvent {
    const event: ViewEvent = { type, seq: view.nextSeq(), data };
    for (const listener of view.listeners) {
      listener.send(event);
    }
    return event;
  }

  /** Starts (or restarts) the close timer if nobody streams the view. */
  private closeWhenIdle(view: View): void {
    if (view.inUse() || this.registry.get(view.viewKey) !== view) {
      return;
    }
    clearTimeout(view.closeTimer);
    view.closesAt = Date.now() + CLOSE_AFTER_MS;
    view.closeTimer = setTimeout(() => this.close(view), CLOSE_AFTER_MS);
    // A pending close never keeps the process alive.
    view.closeTimer.unref();
  }

  private cancelClose(view: View): void {
    clearTimeout(view.closeTimer);
    view.closeTimer = undefined;
    view.closesAt = undefined;
  }
}

/** The rows in the order of `ids`; ids whose row wasn't returned are left out. */
function inOrder(rows: Row[], ids: readonly string[]): Row[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

function windowData(
  window: LiveWindow,
  total: number,
  ids: string[],
  rows: Row[],
): WindowData {
  return {
    sort: sortName(window.spec),
    offset: window.offset,
    total,
    ids,
    rows,
  };
}
