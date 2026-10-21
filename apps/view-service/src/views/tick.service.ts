import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { ChangeBuffer, type ChangeBatch } from '../changes/change-buffer.js';
import type { Dependency } from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import {
  applyDeletes,
  applyFull,
  applyRecheck,
  emptyDiff,
  isEmpty,
  type Row,
  type ViewDiff,
} from './view-diff.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { View } from './view.js';

/** Time from the start of one tick to the start of the next. */
export const TICK_MS = 500;

type Link = Required<Dependency>['link'];

/** What one view must do this tick. */
interface ViewWork {
  /** id → the lowest version its re-check must return (0: any). */
  recheck: Map<string, number>;
  /** Deleted ids: removed without a query. */
  deleted: Set<string>;
}

/**
 * Every tick: takes the changes the feed collected, finds the views they may
 * affect, re-checks only the changed ids against each view's own SQL, and
 * sends each view's differences to its listeners as one `delta` event, with
 * the full rows the re-check returned (nothing is read twice).
 * A tick that runs long delays the next one; the next one then takes
 * everything collected meanwhile.
 */
@Injectable()
export class TickService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TickService.name);
  /** viewKey → ids to re-check next tick: a stale replica row, or a view still loading. */
  private dirty = new Map<string, Map<string, number>>();
  /** Views to run in full next tick: a gap came while they were loading, or the run failed. */
  private reloadNext = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  readonly stats = {
    ticks: 0,
    failed: 0,
    rechecked: 0,
    retried: 0,
    reloaded: 0,
    deltas: 0,
    lastMs: 0,
  };
  tickMs = TICK_MS;

  constructor(
    private readonly buffer: ChangeBuffer,
    private readonly dependencies: DependencyIndex,
    private readonly registry: ViewRegistry,
    private readonly loader: ViewLoader,
    private readonly views: ViewService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setTimeout(this.loop, this.tickMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Runs one tick. Never rejects: on failure the work is kept for the next tick. */
  async tick(): Promise<void> {
    const batch = this.buffer.drain();
    const dirty = this.dirty;
    const reload = this.reloadNext;
    this.dirty = new Map();
    this.reloadNext = new Set();
    if (
      batch.events.length === 0 &&
      batch.gapTypes.length === 0 &&
      dirty.size === 0 &&
      reload.size === 0 &&
      !this.registry.list().some(hasStaleWindow)
    ) {
      return;
    }
    const started = performance.now();
    this.stats.ticks += 1;
    try {
      await this.run(batch, dirty, reload);
    } catch (err) {
      // Applying a change twice changes nothing, so the whole batch can run again.
      this.stats.failed += 1;
      this.logger.error('tick failed, retrying its changes next tick', err);
      this.buffer.requeue(batch);
      for (const [viewKey, ids] of dirty) {
        for (const [id, version] of ids) {
          this.markDirty(viewKey, id, version);
        }
      }
      for (const viewKey of reload) {
        this.reloadNext.add(viewKey);
      }
    }
    this.stats.lastMs = Math.round(performance.now() - started);
  }

  private readonly loop = (): void => {
    const started = performance.now();
    this.running = this.tick().finally(() => {
      this.running = undefined;
      if (!this.stopped) {
        const elapsed = performance.now() - started;
        this.timer = setTimeout(this.loop, Math.max(0, this.tickMs - elapsed));
      }
    });
  };

  private async run(
    batch: ChangeBatch,
    dirty: Map<string, Map<string, number>>,
    reload: Set<string>,
  ): Promise<void> {
    // 1. A typeSeq gap means a lost event: every view that reads the type runs in full.
    for (const type of batch.gapTypes) {
      for (const viewKey of this.dependencies.viewsOf(type)) {
        reload.add(viewKey);
      }
    }

    // 2. Candidates: own-type changes name their id; related-type changes go through a link.
    const work = new Map<string, ViewWork>();
    for (const [viewKey, ids] of dirty) {
      for (const [id, version] of ids) {
        addRecheck(work, viewKey, id, version);
      }
    }
    const links = new Map<Link, { ids: Set<string>; viewKeys: Set<string> }>();
    for (const evt of batch.events) {
      const { own, linked } = this.dependencies.candidates(evt);
      for (const viewKey of own) {
        if (evt.op === 'delete') {
          workOf(work, viewKey).deleted.add(evt.id);
        } else {
          addRecheck(work, viewKey, evt.id, evt.version);
        }
      }
      for (const { viewKey, link } of linked) {
        // Views that share a link (the same function) run it once, for all changed ids.
        let group = links.get(link);
        if (!group) {
          group = { ids: new Set(), viewKeys: new Set() };
          links.set(link, group);
        }
        group.ids.add(evt.id);
        group.viewKeys.add(viewKey);
      }
    }
    for (const [link, group] of links) {
      const ids = await this.loader.linked(link, [...group.ids]);
      for (const viewKey of group.viewKeys) {
        for (const id of ids) {
          addRecheck(work, viewKey, id, 0);
        }
      }
    }

    // 3. Re-check and diff each view, yielding between views so sends aren't held up.
    for (const [viewKey, todo] of work) {
      if (reload.has(viewKey)) {
        continue;
      }
      const view = this.registry.get(viewKey);
      if (view) {
        await this.recheck(view, todo);
        await yieldToLoop();
      }
    }

    // 4. Full runs for views that lost an event.
    for (const viewKey of reload) {
      const view = this.registry.get(viewKey);
      if (view) {
        await this.reload(view);
        await yieldToLoop();
      }
    }

    // 5. Ranges whose last update couldn't read its rows, on views that didn't change now.
    for (const view of this.registry.list()) {
      if (hasStaleWindow(view)) {
        await this.views.publishWindows(view, new Map());
      }
    }
  }

  private async recheck(view: View, todo: ViewWork): Promise<void> {
    if (!view.loaded) {
      // Its load may have read the rows before this change: check again once loaded.
      for (const [id, version] of todo.recheck) {
        this.markDirty(view.viewKey, id, version);
      }
      for (const id of todo.deleted) {
        this.markDirty(view.viewKey, id, 0);
      }
      return;
    }
    const diff = emptyDiff();
    applyDeletes(view, todo.deleted, diff);
    for (const id of todo.deleted) {
      todo.recheck.delete(id);
    }
    if (todo.recheck.size > 0) {
      const rows = await this.loader.fetchByIds(view, [...todo.recheck.keys()]);
      this.stats.rechecked += todo.recheck.size;
      const retry = applyRecheck(view, todo.recheck, rows, diff);
      this.stats.retried += retry.size;
      for (const [id, version] of retry) {
        this.markDirty(view.viewKey, id, version);
      }
    }
    await this.send(view, diff);
  }

  private async reload(view: View): Promise<void> {
    if (!view.loaded) {
      this.reloadNext.add(view.viewKey);
      return;
    }
    const rows = await this.loader.fetchAll(view);
    this.stats.reloaded += 1;
    const diff = emptyDiff();
    applyFull(view, rows, diff);
    await this.send(view, diff);
  }

  /** One `delta` to whole-view streams, and a `window` event to each range that changed. */
  private async send(view: View, diff: ViewDiff): Promise<void> {
    if (isEmpty(diff)) {
      return;
    }
    this.stats.deltas += 1;
    this.views.publish(view, 'delta', { ...diff, total: view.ids.size });
    if (view.windows.size > 0) {
      const changed = new Map<string, Row>();
      for (const row of [...diff.added, ...diff.updated]) {
        changed.set(row.id, row);
      }
      await this.views.publishWindows(view, changed);
    }
  }

  private markDirty(viewKey: string, id: string, version: number): void {
    let ids = this.dirty.get(viewKey);
    if (!ids) {
      ids = new Map();
      this.dirty.set(viewKey, ids);
    }
    ids.set(id, Math.max(ids.get(id) ?? 0, version));
  }
}

function workOf(work: Map<string, ViewWork>, viewKey: string): ViewWork {
  let todo = work.get(viewKey);
  if (!todo) {
    todo = { recheck: new Map(), deleted: new Set() };
    work.set(viewKey, todo);
  }
  return todo;
}

/** Adds an id to re-check, keeping the highest version asked for. */
function addRecheck(
  work: Map<string, ViewWork>,
  viewKey: string,
  id: string,
  version: number,
): void {
  const { recheck } = workOf(work, viewKey);
  recheck.set(id, Math.max(recheck.get(id) ?? 0, version));
}

function hasStaleWindow(view: View): boolean {
  for (const window of view.windows.values()) {
    if (window.stale) {
      return true;
    }
  }
  return false;
}
