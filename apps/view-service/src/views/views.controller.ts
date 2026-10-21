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
        refCount: view.refCount,
        listeners: view.listeners.size,
        dependsOn: describe(this.dependencies.dependenciesOf(view.viewKey)),
      })),
    };
  }

  /**
   * GET /views/:viewKey/events. The first event is a snapshot of the view;
   * every later event has the next seq, sent as the SSE id.
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
      // Snapshot and listener are added in one synchronous step,
      // so no event can fall between them.
      subscriber.next(
        toMessage({
          type: 'snapshot',
          seq: view.seq,
          data: this.views.snapshot(view),
        }),
      );
      const listener: ViewListener = {
        send: (event) => subscriber.next(toMessage(event)),
      };
      view.listeners.add(listener);
      return () => view.listeners.delete(listener);
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
    refCount: number;
    listeners: number;
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
