import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import type { Dependency } from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import { optionalSort, pageRequest } from '../http/query-params.js';
import type { SortType, SortValue } from './sort-keys.js';
import { sortName } from './sorted-index.js';
import { toStatement } from './sql.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService, type ViewPage } from './view.service.js';
import type { View, ViewEvent, ViewListener } from './view.js';

/** A comment line every 15 s keeps idle proxies from closing the stream. */
export const HEARTBEAT_MS = 15_000;

/** Streams a view's events over SSE, for any route that opened it, plus a debug listing. */
@Controller('views')
export class ViewsController {
  constructor(
    private readonly registry: ViewRegistry,
    private readonly views: ViewService,
    private readonly dependencies: DependencyIndex,
  ) {}

  /** GET /views — debug: every open view and the changes it is registered for. */
  @Get()
  list(): ViewsDebug {
    return {
      watchedTypes: this.dependencies.watchedTypes(),
      views: this.registry.list().map((view) => ({
        viewKey: view.viewKey,
        entityType: view.entityType,
        loaded: view.loaded,
        total: view.ids.size,
        seq: view.seq,
        closesAt:
          view.closesAt === undefined
            ? null
            : new Date(view.closesAt).toISOString(),
        listeners: view.listeners.size,
        sortable: view.sortKeys.types,
        defaultSort: view.defaultSort ? sortName(view.defaultSort) : null,
        sorts: view.sortKeys.indexNames(),
        dependsOn: describe(this.dependencies.dependenciesOf(view.viewKey)),
      })),
    };
  }

  /**
   * GET /views/:viewKey/events. The first event is a snapshot of the view
   * with its rows; every later event has the next seq, sent as the SSE id.
   * If the rows can't be read, the stream ends and the client reconnects.
   */
  @Sse(':viewKey/events')
  events(@Param('viewKey') key: string): Observable<MessageEvent> {
    const view = this.loadedView(key);
    const events = new Observable<MessageEvent>((subscriber) => {
      // The snapshot's seq and the listener are taken in one synchronous step,
      // so no event can fall between them. Events published while the rows
      // are read wait, and follow the snapshot.
      let waiting: ViewEvent[] | undefined = [];
      const listener: ViewListener = {
        send: (event) =>
          waiting ? waiting.push(event) : subscriber.next(toMessage(event)),
      };
      const snapshot = this.views.page(view, {});
      this.views.addListener(view, listener);
      snapshot.then(
        (data) => {
          subscriber.next(toMessage({ type: 'snapshot', seq: data.seq, data }));
          for (const event of waiting ?? []) {
            subscriber.next(toMessage(event));
          }
          waiting = undefined;
        },
        (err: unknown) => subscriber.error(err),
      );
      return () => this.views.removeListener(view, listener);
    });
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ comment: 'ping' })),
    );
    return merge(events, heartbeat);
  }

  /**
   * GET /views/:viewKey/rows?sort=item_price:desc&offset=7&limit=20 — a page
   * of a view a client already opened, e.g. a second list in the client on
   * the same data. Every param is optional; no limit: every row.
   */
  @Get(':viewKey/rows')
  rows(
    @Param('viewKey') key: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ViewPage> {
    const view = this.loadedView(key);
    return this.views.read(view, pageRequest(view.sortKeys.types, query));
  }

  /**
   * GET /views/:viewKey/order?sort=item_price:desc — debug: the view's ids in
   * a sort order with their sort value, read from memory. No sort: the view's
   * default sort.
   */
  @Get(':viewKey/order')
  order(
    @Param('viewKey') key: string,
    @Query('sort') sort?: string,
  ): OrderDebug {
    const view = this.loadedView(key);
    const spec =
      optionalSort('sort', sort, view.sortKeys.types) ?? view.defaultSort;
    const { ids } = view.sorted(spec);
    return {
      sort: sortName(spec),
      total: ids.length,
      order: ids.map((id) => ({
        id,
        value: spec ? (view.sortKeys.get(spec.column, id) ?? null) : id,
      })),
    };
  }

  private loadedView(key: string): View {
    const view = this.registry.get(key);
    if (!view?.loaded) {
      throw new NotFoundException({
        code: 'UNKNOWN_VIEW',
        message: `view ${key} is not open`,
      });
    }
    return view;
  }
}

export interface OrderDebug {
  /** "column:dir", or "id". */
  sort: string;
  total: number;
  order: { id: string; value: SortValue }[];
}

export interface ViewsDebug {
  watchedTypes: string[];
  views: {
    viewKey: string;
    entityType: string;
    loaded: boolean;
    total: number;
    seq: number;
    /** When the view closes because nobody streams it; null while streamed. */
    closesAt: string | null;
    listeners: number;
    sortable: Readonly<Record<string, SortType>>;
    /** "column:dir", or null when the view sorts by id. */
    defaultSort: string | null;
    /** Sorted indexes built so far. */
    sorts: string[];
    dependsOn: Record<string, DependencyDebug>;
  }[];
}

export interface DependencyDebug {
  fields: string[] | 'all';
  /** The link SQL text, for a related type. */
  link?: string;
}

/** Dependencies as JSON, with each link shown as its SQL text. */
function describe(
  deps: Record<string, Dependency> | undefined,
): Record<string, DependencyDebug> {
  const out: Record<string, DependencyDebug> = {};
  for (const [type, dep] of Object.entries(deps ?? {})) {
    out[type] = {
      fields: dep.fields ?? 'all',
      ...(dep.link && { link: toStatement(dep.link([])).text }),
    };
  }
  return out;
}

function toMessage(event: ViewEvent): MessageEvent {
  return {
    type: event.type,
    id: String(event.seq),
    data: event.data as object,
  };
}
