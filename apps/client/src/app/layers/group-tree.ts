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
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { GroupCountData } from '@atlas/client-sdk';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import type { LivePage, LiveView } from '../realtime/atlas-realtime.service';
import { LivePageList } from './live-page-list';
import type { FocusRequest } from './live-page-list';
import type { RegistryField } from './registry';

export interface GroupNode {
  /** Group path joined with U+0000 (unique per node). */
  key: string;
  path: string[];
  value: string;
  count: number;
  children: GroupNode[];
}

const keyOf = (path: readonly string[]) => path.join('\u0000');

/** Builds the group tree from the server's counts (every level), keeping the server's order. */
export function buildGroupTree(counts: readonly GroupCountData[], levels: number): GroupNode[] {
  const roots: GroupNode[] = [];
  const byKey = new Map<string, GroupNode>();
  for (let depth = 1; depth <= levels; depth++) {
    for (const c of counts) {
      if (c.groupPath.length !== depth) continue;
      const node: GroupNode = {
        key: keyOf(c.groupPath),
        path: c.groupPath,
        value: c.groupPath[depth - 1] ?? '',
        count: c.count,
        children: [],
      };
      byKey.set(node.key, node);
      if (depth === 1) roots.push(node);
      else byKey.get(keyOf(c.groupPath.slice(0, -1)))?.children.push(node);
    }
  }
  return roots;
}

/** Rows shown by the page of an expanded group. */
const GROUP_ROWS = 8;

/**
 * The grouped list: an expandable tree with live counts; expanding a leaf group opens a live page
 * for that group (its own `groupPath` subscription).
 */
@Component({
  selector: 'app-group-tree',
  imports: [LivePageList, NgTemplateOutlet],
  template: `
    <p class="muted total">{{ total() }} in {{ tree().length }} groups</p>
    <ng-template #nodes let-list let-depth="depth">
      @for (node of list; track node.key) {
        <div class="node" [style.padding-left.rem]="(depth - 1) * 0.75">
          <button
            type="button"
            class="toggle"
            [attr.aria-expanded]="expanded().has(node.key)"
            (click)="toggle(node.key)"
          >
            <span class="chev">{{ expanded().has(node.key) ? '▾' : '▸' }}</span>
            <span class="label">{{ node.value || '(none)' }}</span>
            <span class="count">{{ node.count }}</span>
          </button>
          @if (expanded().has(node.key)) {
            @if (depth < levels()) {
              <ng-container
                *ngTemplateOutlet="nodes; context: { $implicit: node.children, depth: depth + 1 }"
              />
            } @else {
              <app-live-page-list
                [view]="view()"
                [groupPath]="node.path"
                [columns]="columns()"
                [focus]="focus()"
                [visibleRows]="groupRows"
              />
            }
          }
        </div>
      }
    </ng-template>
    <ng-container *ngTemplateOutlet="nodes; context: { $implicit: tree(), depth: 1 }" />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .total {
      margin: 0;
      font-size: var(--atlas-font-sm);
    }
    .node {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .toggle {
      display: flex;
      gap: var(--atlas-space-2);
      align-items: center;
      width: 100%;
      padding: var(--atlas-space-1);
      font: inherit;
      color: var(--atlas-text);
      text-align: left;
      cursor: pointer;
      background: none;
      border: 0;
      border-radius: var(--atlas-radius-sm);
      &:hover {
        background: var(--atlas-surface-raised);
      }
    }
    .chev {
      width: 1ch;
      color: var(--atlas-text-muted);
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .count {
      font-variant-numeric: tabular-nums;
      color: var(--atlas-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupTree {
  private readonly rt = inject(AtlasRealtimeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly view = input.required<LiveView>();
  /** Number of group-by levels (1 or 2). */
  readonly levels = input.required<number>();
  readonly columns = input.required<readonly RegistryField[]>();
  readonly focus = input<FocusRequest | null>(null);
  /** Changes when grouping or sort change: group paths mean something else, so all collapse. */
  readonly layoutKey = input('');

  protected readonly groupRows = GROUP_ROWS;
  /** A one-row page of the whole view: its group counts drive the tree. */
  private readonly countsPage = signal<LivePage | null>(null);
  protected readonly total = computed(() => this.countsPage()?.total() ?? 0);
  protected readonly tree = computed(() =>
    buildGroupTree(this.countsPage()?.groupCounts() ?? [], this.levels()),
  );
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  constructor() {
    effect((onCleanup) => {
      const view = this.view();
      const page = untracked(() =>
        this.rt.subscribePage(view, { pageSize: 1 }, { destroyRef: this.destroyRef }),
      );
      this.countsPage.set(page);
      onCleanup(() => page.dispose());
    });

    effect(() => {
      this.view();
      this.layoutKey();
      this.expanded.set(new Set());
    });

    // "Find in list": open every group on the entity's path; the leaf page then locates it.
    effect(() => {
      const f = this.focus();
      if (!f) return;
      untracked(() => {
        const next = new Set(this.expanded());
        for (let i = 1; i <= f.groupPath.length; i++) next.add(keyOf(f.groupPath.slice(0, i)));
        this.expanded.set(next);
      });
    });
  }

  protected toggle(key: string): void {
    const next = new Set(this.expanded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.expanded.set(next);
  }
}
