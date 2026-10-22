import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ChangeFeed } from '../changes/change-feed.js';
import {
  queryKey,
  viaColumnsOf,
  type QueryDefinition,
} from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import { toStatement } from './sql.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { checkMatch, matchOf } from './match.js';
import { orderName, orderOf } from './order.js';
import { LiveWindow, windowKey, type WindowData } from './live-window.js';
import type { Row } from './view-diff.js';
import type { View, ViewEvent, ViewListener } from './view.js';

/**
 * How long a view nobody streams stays in memory, so a client that reconnects
 * or opens it again within this time gets it without a new load.
 */
export const CLOSE_AFTER_MS = 60_000;

/** Which rows to read: a range of the query's order. Every part is optional. */
export interface PageRequest {
  /** Position of the first row, from 0. Default 0. */
  offset?: number;
  /** Default: every row from `offset` on. */
  limit?: number;
}

/** A range of a view's rows, in the query's order: what a route returns, and the first event of a stream. */
export interface ViewPage {
  viewKey: string;
  seq: number;
  /** The query's ORDER BY, e.g. "item_price desc, name asc", or "id". */
  orderBy: string;
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
    const built = query.build(params);
    const match = query.match && matchOf(query.match(params));
    if (match) {
      checkMatch(match, query.dependsOn[query.entityType], query.name);
    }
    const view = this.registry.open(
      queryKey(query.name, params),
      query.entityType,
      toStatement(built),
      orderOf(built),
      viaColumnsOf(query),
    );
    this.cancelClose(view);
    this.dependencies.add(
      view.viewKey,
      query.entityType,
      query.dependsOn,
      match,
    );
    try {
      await this.feed.watch(
        Object.keys(this.dependencies.dependenciesOf(view.viewKey)!),
      );
      // Runs the query only for a new view; an open view answers from memory.
      await this.loader.ensureLoaded(view);
      return this.page(view, page);
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

  /** A range of the view's rows at its current seq, from memory: no query. */
  page(view: View, request: PageRequest): ViewPage {
    const sorted = view.sorted();
    const offset = request.offset ?? 0;
    const ids = sorted.slice(
      offset,
      request.limit === undefined ? undefined : offset + request.limit,
    );
    return {
      viewKey: view.viewKey,
      seq: view.seq,
      orderBy: orderName(view.order),
      offset,
      total: sorted.length,
      rows: rowsOf(view, ids),
    };
  }

  /**
   * A page of an open view, for a client that already has its viewKey. Like
   * opening it again, this restarts its close timer if nobody streams it.
   */
  read(view: View, request: PageRequest): ViewPage {
    this.closeWhenIdle(view);
    return this.page(view, request);
  }

  /**
   * Starts streaming one range of the view. The window is shared by every
   * client on the same range, and created by the first. `first` is
   * the first event: the window's ids at its current seq, with their rows.
   */
  openWindow(
    view: View,
    request: PageRequest & { limit: number },
    listener: ViewListener,
  ): { window: LiveWindow; first: ViewEvent } {
    const offset = request.offset ?? 0;
    const key = windowKey(offset, request.limit);
    let window = view.windows.get(key);
    if (!window) {
      window = new LiveWindow(offset, request.limit);
      const sorted = view.sorted();
      window.ids = sorted.slice(offset, offset + request.limit);
      window.total = sorted.length;
      view.windows.set(key, window);
    }
    window.listeners.add(listener);
    this.cancelClose(view);
    const first: ViewEvent = {
      type: 'window',
      seq: window.seq,
      data: windowData(
        view,
        window,
        window.total,
        window.ids,
        rowsOf(view, window.ids),
      ),
    };
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
   * whose ids, order or total changed, or that holds a row in `changed`.
   * The rows sent, changed or slid into the range, come from memory.
   */
  publishWindows(view: View, changed: ReadonlySet<string>): void {
    for (const window of view.windows.values()) {
      const sorted = view.sorted();
      const ids = sorted.slice(window.offset, window.offset + window.limit);
      const sent = new Set(window.ids);
      const send = ids.filter((id) => !sent.has(id) || changed.has(id));
      const sameIds =
        ids.length === window.ids.length &&
        ids.every((id, i) => id === window.ids[i]);
      if (sameIds && send.length === 0 && sorted.length === window.total) {
        continue;
      }
      window.ids = ids;
      window.total = sorted.length;
      const event: ViewEvent = {
        type: 'window',
        seq: window.nextSeq(),
        data: windowData(view, window, window.total, ids, rowsOf(view, send)),
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

/** The held rows of these ids, in this order. */
function rowsOf(view: View, ids: readonly string[]): Row[] {
  return ids.map((id) => view.rows.get(id)!);
}

function windowData(
  view: View,
  window: LiveWindow,
  total: number,
  ids: string[],
  rows: Row[],
): WindowData {
  return {
    orderBy: orderName(view.order),
    offset: window.offset,
    total,
    ids,
    rows,
  };
}
