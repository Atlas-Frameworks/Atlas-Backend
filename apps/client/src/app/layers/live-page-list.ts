import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
  CdkVirtualScrollViewport,
} from '@angular/cdk/scrolling';
import type { RowData } from '@atlas/client-sdk';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import type { LivePage, LiveView } from '../realtime/atlas-realtime.service';
import { WorkspaceStore } from '../workspace/workspace.store';
import { eventValue } from './filter-group';
import { FreezeOrder, reorderBanner } from './freeze-order';
import type { RegistryField } from './registry';

export const PAGE_SIZE = 50;
/** Fixed row height (px) for the virtual scroll. */
export const ROW_HEIGHT = 28;

/** A request to show one entity: the list whose group path matches locates it and jumps there. */
export interface FocusRequest {
  id: string;
  groupPath: string[];
  at: number;
}

export const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/**
 * One live page of a view (or of one group of it): fixed-height virtual scroll, page controls,
 * locate, and a frozen order while the pointer is over the list or it is being scrolled.
 */
@Component({
  selector: 'app-live-page-list',
  imports: [CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf],
  template: `
    <div class="bar">
      <button type="button" class="link" [disabled]="pageIndex() === 0" (click)="go(0)">«</button>
      <button
        type="button"
        class="link"
        [disabled]="pageIndex() === 0"
        (click)="go(pageIndex() - 1)"
      >
        ‹
      </button>
      <span class="muted pos">
        @if (loading()) {
          Loading…
        } @else {
          {{ pageIndex() + 1 }} / {{ pageCount() || 1 }} · {{ total() }}
        }
      </span>
      <button type="button" class="link" [disabled]="isLast()" (click)="go(pageIndex() + 1)">
        ›
      </button>
      <button type="button" class="link" [disabled]="isLast()" (click)="go(pageCount() - 1)">
        »
      </button>
      <form class="locate" (submit)="$event.preventDefault(); locate(locateText())">
        <input
          aria-label="Locate by id"
          placeholder="Locate id"
          [value]="locateText()"
          (input)="locateText.set(event($event))"
        />
      </form>
    </div>
    @if (message(); as m) {
      <p class="muted msg">{{ m }}</p>
    }
    <div class="list" (pointerenter)="freeze.pointerEnter()" (pointerleave)="freeze.pointerLeave()">
      @if (banner(); as b) {
        <button type="button" class="banner" (click)="freeze.refresh()">{{ b }}</button>
      }
      <cdk-virtual-scroll-viewport
        class="rows"
        [class.stale]="stale()"
        [itemSize]="rowHeight"
        [style.height.px]="height()"
        [style.flex]="height() === null ? null : 'none'"
        (scroll)="freeze.scrolled()"
      >
        <div
          *cdkVirtualFor="let row of rows(); trackBy: trackById"
          class="row"
          role="button"
          tabindex="0"
          [class.hit]="row.id === highlighted()"
          [class.selected]="row.id === selectedId()"
          [attr.data-id]="row.id"
          (click)="select(row)"
          (keydown.enter)="select(row)"
        >
          @for (c of columns(); track c.name) {
            <span class="cell" [title]="c.label">{{
              row.version < 0 ? '…' : format(row.fields[c.name])
            }}</span>
          }
        </div>
      </cdk-virtual-scroll-viewport>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--atlas-space-1);
      min-height: 0;
    }
    .bar {
      display: flex;
      gap: var(--atlas-space-1);
      align-items: center;
    }
    .pos {
      flex: 1;
      font-size: var(--atlas-font-sm);
      font-variant-numeric: tabular-nums;
      text-align: center;
      white-space: nowrap;
    }
    .locate input {
      width: 6.5rem;
    }
    .msg {
      margin: 0;
      font-size: var(--atlas-font-sm);
    }
    .list {
      position: relative;
      display: flex;
      flex: 1;
      flex-direction: column;
      min-height: 0;
    }
    /* Floats over the rows: showing it must not move them under the cursor. */
    .banner {
      position: absolute;
      bottom: var(--atlas-space-2);
      left: 50%;
      z-index: 1;
      padding: var(--atlas-space-1) var(--atlas-space-3);
      font: inherit;
      font-size: var(--atlas-font-sm);
      color: #04121c;
      white-space: nowrap;
      cursor: pointer;
      background: var(--atlas-warn);
      border: 0;
      border-radius: 999px;
      box-shadow: var(--atlas-shadow);
      transform: translateX(-50%);
    }
    .rows {
      flex: 1;
      background: var(--atlas-surface-sunken);
      border-radius: var(--atlas-radius-sm);
      &.stale {
        opacity: 0.6;
      }
    }
    .row {
      display: flex;
      gap: var(--atlas-space-2);
      align-items: center;
      height: 28px;
      padding: 0 var(--atlas-space-2);
      cursor: pointer;
      border-bottom: 1px solid var(--atlas-border);
      &:hover {
        background: var(--atlas-surface-raised);
      }
      &.selected {
        box-shadow: inset 3px 0 var(--atlas-accent);
      }
      &.hit {
        background: rgb(76 194 255 / 22%);
      }
    }
    .cell {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      &:first-child {
        color: var(--atlas-text-strong);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivePageList {
  private readonly rt = inject(AtlasRealtimeService);
  private readonly store = inject(WorkspaceStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  readonly view = input.required<LiveView>();
  readonly groupPath = input<readonly string[]>([]);
  readonly columns = input.required<readonly RegistryField[]>();
  readonly focus = input<FocusRequest | null>(null);
  /** Viewport height in rows; `null` fills the available space. */
  readonly visibleRows = input<number | null>(null);

  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly format = formatValue;
  protected readonly event = eventValue;

  private readonly path = computed(() => this.groupPath(), { equal: samePath });
  private readonly page = signal<LivePage | null>(null);
  private readonly state = computed(() => this.page()?.state() ?? null);
  protected readonly rows = computed(() => this.page()?.rows() ?? []);
  protected readonly total = computed(() => this.state()?.total ?? 0);
  protected readonly pageIndex = computed(() => this.state()?.page ?? 0);
  protected readonly pageCount = computed(() => this.state()?.pageCount ?? 0);
  protected readonly isLast = computed(() => this.pageIndex() >= this.pageCount() - 1);
  protected readonly loading = computed(() => this.state()?.loading ?? true);
  protected readonly stale = computed(() => this.state()?.stale ?? false);
  protected readonly banner = computed(() => reorderBanner(this.state()));
  protected readonly height = computed(() => {
    const n = this.visibleRows();
    return n === null ? null : n * ROW_HEIGHT;
  });
  protected readonly selectedId = computed(() => {
    const s = this.store.selected();
    return s && s.entityType === this.view().handle.spec.entityType ? s.id : null;
  });

  protected readonly locateText = signal('');
  protected readonly message = signal<string | null>(null);
  protected readonly highlighted = signal<string | null>(null);

  protected readonly freeze = new FreezeOrder((frozen) =>
    this.page()?.handle.setFreezeOrder(frozen),
  );

  /** Page-switch timing: requested page and start time (see `performance.measure`). */
  private pending: { page: number; at: number } | null = null;

  constructor() {
    effect((onCleanup) => {
      const view = this.view();
      const groupPath = [...this.path()];
      const page = untracked(() =>
        this.rt.subscribePage(
          view,
          { groupPath, pageSize: PAGE_SIZE, prefetch: true },
          { destroyRef: this.destroyRef },
        ),
      );
      this.page.set(page);
      this.freeze.resend();
      onCleanup(() => page.dispose());
    });

    // "Find in list" for this group: locate with jump, then highlight once the row is here.
    effect(() => {
      const f = this.focus();
      if (f && samePath(f.groupPath, this.path())) untracked(() => void this.locate(f.id));
    });

    effect(() => {
      const id = this.highlighted();
      const index = id === null ? -1 : this.rows().findIndex((r) => r.id === id);
      if (index >= 0) this.viewport()?.scrollToIndex(index);
    });

    effect(() => {
      const s = this.state();
      if (this.pending && s && !s.loading && s.page === this.pending.page) {
        performance.measure('atlas:page-switch', { start: this.pending.at });
        this.pending = null;
      }
    });

    this.destroyRef.onDestroy(() => this.freeze.dispose());
  }

  protected trackById(_: number, row: RowData): string {
    return row.id;
  }

  protected go(page: number): void {
    const handle = this.page()?.handle;
    if (!handle) return;
    const target = Math.max(0, page);
    this.pending = { page: target, at: performance.now() };
    handle.setPage(target);
    this.viewport()?.scrollToIndex(0);
  }

  protected select(row: RowData): void {
    this.store.select({ entityType: this.view().handle.spec.entityType, id: row.id });
  }

  protected async locate(id: string): Promise<void> {
    const handle = this.page()?.handle;
    const wanted = id.trim();
    if (!handle || wanted === '') return;
    this.message.set(null);
    const answer = await handle.locate(wanted, { jump: true });
    if (answer.found) {
      this.highlighted.set(wanted);
    } else {
      this.highlighted.set(null);
      this.message.set(`${wanted} is not in this list`);
    }
  }
}
