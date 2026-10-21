import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import type { Dependency } from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import type { SortType } from './sort-keys.js';
import { toStatement } from './sql.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { ViewEvent, ViewListener } from './view.js';

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
        defaultSort: view.defaultSort
          ? `${view.defaultSort.column}:${view.defaultSort.dir}`
          : null,
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
    const view = this.registry.get(key);
    if (!view?.loaded) {
      throw new NotFoundException({
        code: 'UNKNOWN_VIEW',
        message: `view ${key} is not open`,
      });
    }
    const events = new Observable<MessageEvent>((subscriber) => {
      // The snapshot's seq and the listener are taken in one synchronous step,
      // so no event can fall between them. Events published while the rows
      // are read wait, and follow the snapshot.
      let waiting: ViewEvent[] | undefined = [];
      const listener: ViewListener = {
        send: (event) =>
          waiting ? waiting.push(event) : subscriber.next(toMessage(event)),
      };
      const snapshot = this.views.snapshot(view);
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
