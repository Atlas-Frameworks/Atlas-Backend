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
import type { Row } from './view-diff.js';
import type { View, ViewEvent, ViewListener } from './view.js';

/**
 * How long a view nobody streams stays in memory, so a client that reconnects
 * or opens it again within this time gets it without a new load.
 */
export const CLOSE_AFTER_MS = 60_000;

/** What a route returns after opening a view, and the first event of its stream. */
export interface ViewSnapshot {
  viewKey: string;
  seq: number;
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
  async open<P>(query: QueryDefinition<P>, params: P): Promise<ViewSnapshot> {
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
      return await this.snapshot(view);
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
    if (this.registry.get(view.viewKey) !== view || view.listeners.size > 0) {
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
   * The view's rows at its current seq. The ids and seq are taken at the
   * call; the rows are then read by id. A row may already be newer than seq,
   * or gone: the deltas after seq bring the client to the same state.
   */
  snapshot(view: View): Promise<ViewSnapshot> {
    const { viewKey, seq } = view;
    const total = view.ids.size;
    return this.loader
      .fetchByIds(view, [...view.ids.keys()])
      .then((rows) => ({ viewKey, seq, total, rows }));
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
    if (view.listeners.size > 0 || this.registry.get(view.viewKey) !== view) {
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
