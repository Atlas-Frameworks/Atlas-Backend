import { AtlasCore } from '../core/atlas-core.js';
import type { CoreConfig, CoreView } from '../core/atlas-core.js';
import { systemClock } from '../core/clock.js';
import type { Clock, RandomSource } from '../core/clock.js';
import type { TransportFactory } from '../core/transport.js';
import { frameTransferables } from '../map-store/frame.js';
import { FrameScheduler } from '../map-store/frame-scheduler.js';
import { DetailSubscription } from '../pages/detail-subscription.js';
import { PageSubscription } from '../pages/page-subscription.js';
import { RowCache } from '../pages/row-cache.js';
import type { Endpoint } from './endpoint.js';
import type { Command, FromWorker, Query, ToWorker, Update, WorkerConfig } from './messages.js';

/** Things that cannot cross into a Worker; only used when the host runs on the main thread. */
export interface HostInjections {
  transport?: TransportFactory;
  clock?: Clock;
  random?: RandomSource;
}

interface HostView {
  core: CoreView;
  layerId: string | null;
}

/**
 * The SDK running behind the bridge (in the Worker, or on the main thread as a fallback): turns
 * commands into core calls, sends map frames with their buffers transferred, and batches page,
 * detail and status updates to at most `updatesPerSecond` (default 4).
 */
export class WorkerHost {
  private core: AtlasCore | null = null;
  private scheduler: FrameScheduler | null = null;
  private readonly views = new Map<string, HostView>();
  private readonly pages = new Map<string, PageSubscription>();
  private readonly details = new Map<string, DetailSubscription>();
  private readonly caches = new Map<string, RowCache>();
  private readonly pending = new Map<string, Update>();
  private flushTimer: unknown = null;
  private lastFlush = -Infinity;
  private intervalMs = 250;
  private hidden = false;
  private readonly clock: Clock;

  constructor(
    private readonly port: Endpoint<ToWorker, FromWorker>,
    private readonly injections: HostInjections = {},
  ) {
    this.clock = injections.clock ?? systemClock;
    port.addEventListener('message', (ev) => this.onMessage(ev.data));
  }

  private onMessage(msg: ToWorker): void {
    switch (msg.kind) {
      case 'command':
        this.run(msg.command);
        return;
      case 'query':
        this.answer(msg.callId, msg.query);
        return;
      case 'release':
        this.scheduler?.release(msg.layerId, msg.buffers);
        return;
    }
  }

  private run(c: Command): void {
    if (c.op === 'configure') {
      this.configure(c.config);
      return;
    }
    const core = this.core;
    const scheduler = this.scheduler;
    if (!core || !scheduler) return;
    switch (c.op) {
      case 'setToken':
        core.setToken(c.token);
        return;
      case 'openView': {
        const view = core.openView(
          c.spec,
          (error) =>
            this.queue(`viewError|${c.viewId}`, { kind: 'viewError', viewId: c.viewId, error }),
          c.viewId,
        );
        this.views.set(c.viewId, { core: view, layerId: null });
        return;
      }
      case 'closeView': {
        const v = this.views.get(c.viewId);
        if (!v) return;
        for (const [pageId, page] of this.pages) {
          if (pageId.startsWith(`${c.viewId}/`)) {
            page.close();
            this.pages.delete(pageId);
          }
        }
        if (v.layerId) scheduler.removeLayer(v.layerId);
        v.core.close();
        this.views.delete(c.viewId);
        return;
      }
      case 'setLayout':
        this.views.get(c.viewId)?.core.setLayout(c.layout);
        return;
      case 'subscribeMap': {
        const v = this.views.get(c.viewId);
        if (!v) return;
        if (v.layerId) scheduler.removeLayer(v.layerId);
        v.layerId = c.layerId;
        v.core.subscribeMap(scheduler.addLayer(c.layerId));
        return;
      }
      case 'unsubscribeMap': {
        const v = this.views.get(c.viewId);
        if (!v?.layerId) return;
        v.core.unsubscribeMap();
        scheduler.removeLayer(v.layerId);
        v.layerId = null;
        return;
      }
      case 'subscribePage': {
        const v = this.views.get(c.viewId);
        if (!v) return;
        const page = new PageSubscription(
          v.core,
          this.cacheFor(v.core.spec.entityType),
          c.options,
          (state) => this.queue(`page|${c.pageId}`, { kind: 'page', pageId: c.pageId, state }),
        );
        this.pages.set(c.pageId, page);
        return;
      }
      case 'setPage':
        this.pages.get(c.pageId)?.setPage(c.page);
        return;
      case 'setGroupPath':
        this.pages.get(c.pageId)?.setGroupPath(c.groupPath);
        return;
      case 'setFreezeOrder':
        this.pages.get(c.pageId)?.setFreezeOrder(c.frozen);
        return;
      case 'closePage':
        this.pages.get(c.pageId)?.close();
        this.pages.delete(c.pageId);
        this.pending.delete(`page|${c.pageId}`);
        return;
      case 'openDetail': {
        const d = new DetailSubscription(c.entityType, c.id, (state) =>
          this.queue(`detail|${c.detailId}`, { kind: 'detail', detailId: c.detailId, state }),
        );
        d.core = core.openDetail(c.entityType, c.id, d);
        this.details.set(c.detailId, d);
        return;
      }
      case 'closeDetail':
        this.details.get(c.detailId)?.close();
        this.details.delete(c.detailId);
        this.pending.delete(`detail|${c.detailId}`);
        return;
      case 'setCamera':
        scheduler.setCamera(c.camera);
        return;
      case 'setSelected':
        scheduler.setSelected(c.id);
        return;
      case 'setHidden':
        this.hidden = c.hidden;
        core.setHidden(c.hidden);
        scheduler.setPaused(c.hidden);
        if (!c.hidden) this.scheduleFlush();
        return;
      case 'resetLayer':
        scheduler.resetLayer(c.layerId);
        return;
      case 'destroy':
        for (const p of this.pages.values()) p.close();
        for (const d of this.details.values()) d.close();
        this.pages.clear();
        this.details.clear();
        this.views.clear();
        this.pending.clear();
        if (this.flushTimer !== null) this.clock.clearTimeout(this.flushTimer);
        this.flushTimer = null;
        core.close();
        this.core = null;
        this.scheduler = null;
        return;
    }
  }

  private configure(config: WorkerConfig): void {
    if (this.core) {
      this.core.configure(config.services);
      if (config.token !== undefined) this.core.setToken(config.token);
      return;
    }
    const coreConfig: CoreConfig = { services: config.services };
    if (config.token !== undefined) coreConfig.token = config.token;
    if (config.backoff) coreConfig.backoff = config.backoff;
    if (this.injections.transport) coreConfig.transport = this.injections.transport;
    coreConfig.clock = this.clock;
    if (this.injections.random) coreConfig.random = this.injections.random;
    this.core = new AtlasCore(coreConfig);
    this.intervalMs = 1_000 / Math.max(0.5, config.updatesPerSecond ?? 4);
    this.scheduler = new FrameScheduler(
      this.clock,
      (frame) => this.port.postMessage({ kind: 'frame', frame }, frameTransferables(frame.buffers)),
      {
        ...(config.maxFps !== undefined ? { maxFps: config.maxFps } : {}),
        ...(config.maxLabels !== undefined ? { maxLabels: config.maxLabels } : {}),
      },
    );
    this.core.onStatus((status) => this.queue('status', { kind: 'status', status }));
    this.queue('status', { kind: 'status', status: this.core.getStatus() });
  }

  private answer(callId: number, q: Query): void {
    const reply = (p: Promise<{ found: boolean; groupPath: string[]; page: number }>) => {
      p.then(
        (value) => this.port.postMessage({ kind: 'answer', callId, ok: true, value }, []),
        (e: unknown) =>
          this.port.postMessage(
            {
              kind: 'answer',
              callId,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            },
            [],
          ),
      );
    };
    if (q.op === 'locate') {
      const v = this.views.get(q.viewId);
      reply(v ? v.core.locate(q.id, q.pageSize) : Promise.reject(new Error('unknown view')));
    } else {
      const p = this.pages.get(q.pageId);
      reply(p ? p.locate(q.id, { jump: q.jump }) : Promise.reject(new Error('unknown page')));
    }
  }

  private cacheFor(entityType: string): RowCache {
    let c = this.caches.get(entityType);
    if (!c) this.caches.set(entityType, (c = new RowCache()));
    return c;
  }

  /** Coalesces an update (latest per key) and schedules a batch. */
  private queue(key: string, update: Update): void {
    this.pending.set(key, update);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.pending.size === 0) return;
    // While hidden only status goes out (so the app can show "stale"); the rest waits.
    if (this.hidden && !this.pending.has('status')) return;
    const delay = Math.max(0, this.lastFlush + this.intervalMs - this.clock.now());
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }

  private flush(): void {
    this.lastFlush = this.clock.now();
    const updates: Update[] = [];
    for (const [key, u] of this.pending) {
      if (this.hidden && key !== 'status') continue;
      updates.push(u);
      this.pending.delete(key);
    }
    if (updates.length > 0) this.port.postMessage({ kind: 'updates', updates }, []);
    this.scheduleFlush();
  }
}
