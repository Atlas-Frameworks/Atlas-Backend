import {
  Controller,
  NotFoundException,
  Param,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { ViewEvent, ViewListener } from './view.js';

/** A comment line every 15 s keeps idle proxies from closing the stream. */
export const HEARTBEAT_MS = 15_000;

/** Streams a view's events to clients over SSE, for any route that opened it. */
@Controller('views')
export class ViewsController {
  constructor(
    private readonly registry: ViewRegistry,
    private readonly views: ViewService,
  ) {}

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

function toMessage(event: ViewEvent): MessageEvent {
  return {
    type: event.type,
    id: String(event.seq),
    data: event.data as object,
  };
}
