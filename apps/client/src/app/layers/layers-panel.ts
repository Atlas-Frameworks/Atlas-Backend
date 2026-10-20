import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import type { LiveView } from '../realtime/atlas-realtime.service';
import { WorkspaceStore } from '../workspace/workspace.store';
import { FilterGroup, eventValue } from './filter-group';
import { FILTER_LIMITS, buildFilter, countConditions, emptyGroup, reId } from './filter-model';
import type { FilterDraft, GroupDraft } from './filter-model';
import { GroupTree } from './group-tree';
import { LivePageList, PAGE_SIZE } from './live-page-list';
import type { FocusRequest } from './live-page-list';
import { RegistryApi } from './registry';
import type { RegistryField, RegistryType } from './registry';
import { SavedViewsStore } from './saved-views';
import type { SavedView } from './saved-views';

/** Up to 2 group-by levels (A-04; the server ignores more). */
export const MAX_GROUP_BY = 2;

export interface Sort {
  field: string;
  dir: 'asc' | 'desc';
}

/** What is subscribed now. `filter` is the §5 tree's JSON text ('' = none), for comparison. */
interface Applied {
  entityType: string;
  filter: string;
  groupBy: string[];
  sort: Sort;
}

/** The list columns: the first field, the sort field, then the next unused field (3 at most). */
export function listColumns(type: RegistryType | undefined, sortField: string): RegistryField[] {
  if (!type) return [];
  const first = type.fields[0];
  const sort = type.fields.find((f) => f.name === sortField);
  const out: RegistryField[] = [];
  for (const f of [first, sort, ...type.fields]) {
    if (f && !out.includes(f) && f.type !== 'uuid') out.push(f);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * The Layers panel (A-04): a filter builder generated from the field registry, grouping and sort,
 * and the live list. It owns `WorkspaceStore.views`: applying a different type or filter closes
 * the old view and opens a new one, so the map (A-03) and the list switch together.
 */
@Component({
  selector: 'app-layers-panel',
  imports: [FilterGroup, GroupTree, LivePageList],
  templateUrl: './layers-panel.html',
  styleUrl: './layers-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LayersPanel {
  private readonly rt = inject(AtlasRealtimeService);
  private readonly store = inject(WorkspaceStore);
  private readonly registryApi = inject(RegistryApi);
  private readonly savedViews = inject(SavedViewsStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly event = eventValue;
  protected readonly limits = FILTER_LIMITS;

  protected readonly registry = signal<RegistryType[]>([]);
  protected readonly registryError = signal<string | null>(null);

  // Drafts (what the editors show).
  protected readonly entityType = signal('');
  protected readonly filter = signal<GroupDraft>(emptyGroup());
  protected readonly groupBy = signal<string[]>([]);
  protected readonly sortDraft = signal<Sort>({ field: '', dir: 'asc' });

  protected readonly type = computed(() =>
    this.registry().find((t) => t.type === this.entityType()),
  );
  protected readonly fields = computed(() => this.type()?.fields ?? []);
  protected readonly groupable = computed(() => this.fields().filter((f) => f.groupable));
  protected readonly sortable = computed(() => this.fields().filter((f) => f.sortable));
  protected readonly built = computed(() => buildFilter(this.filter(), this.type()));
  protected readonly issues = computed(
    () => new Map(this.built().issues.map((i) => [i.nodeId, i.message])),
  );
  protected readonly conditionCount = computed(() => countConditions(this.filter()));

  // What is live.
  protected readonly view = signal<LiveView | null>(null);
  private readonly applied = signal<Applied | null>(null);
  protected readonly viewError = computed(() => this.view()?.error() ?? null);
  protected readonly draft = computed<Applied>(() => ({
    entityType: this.entityType(),
    filter: this.built().tree === null ? '' : JSON.stringify(this.built().tree),
    groupBy: this.groupBy(),
    sort: this.sortDraft(),
  }));
  protected readonly dirty = computed(
    () => JSON.stringify(this.draft()) !== JSON.stringify(this.applied()),
  );
  protected readonly canApply = computed(
    () => this.type() !== undefined && this.built().issues.length === 0 && this.dirty(),
  );
  protected readonly liveType = computed(() =>
    this.registry().find((t) => t.type === this.applied()?.entityType),
  );
  protected readonly columns = computed(() =>
    listColumns(this.liveType(), this.applied()?.sort.field ?? ''),
  );
  protected readonly levels = computed(() => this.applied()?.groupBy.length ?? 0);
  protected readonly layoutKey = computed(() => {
    const a = this.applied();
    return a ? JSON.stringify([a.groupBy, a.sort]) : '';
  });

  protected readonly focus = signal<FocusRequest | null>(null);
  protected readonly findMessage = signal<string | null>(null);

  protected readonly saved = this.savedViews.views;
  protected readonly saveName = signal('');

  constructor() {
    void this.loadRegistry();

    // The drawer's "Find in list".
    effect(() => {
      const req = this.store.findInList();
      if (req) untracked(() => void this.find(req.entityType, req.id));
    });

    this.destroyRef.onDestroy(() => {
      const v = this.view();
      if (v && this.store.views().includes(v)) this.store.views.set([]);
    });
  }

  protected async loadRegistry(): Promise<void> {
    this.registryError.set(null);
    try {
      const types = await this.registryApi.load();
      this.registry.set(types);
      const first = types.find((t) => t.type === 'airplanes') ?? types[0];
      if (first && this.entityType() === '') {
        this.setType(first.type);
        this.apply();
      }
    } catch (e) {
      this.registryError.set(e instanceof Error ? e.message : String(e));
    }
  }

  protected setType(entityType: string): void {
    const type = this.registry().find((t) => t.type === entityType);
    this.entityType.set(entityType);
    this.filter.set(emptyGroup());
    this.groupBy.set([]);
    this.sortDraft.set({ field: type?.defaultSort ?? '', dir: 'asc' });
  }

  protected setGroupBy(level: number, field: string): void {
    const next = this.groupBy().slice(0, level);
    if (field !== '') next.push(field);
    this.groupBy.set(next.slice(0, MAX_GROUP_BY));
  }

  protected setSortField(field: string): void {
    this.sortDraft.update((s) => ({ ...s, field }));
  }

  protected toggleSortDir(): void {
    this.sortDraft.update((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }));
  }

  protected resetFilter(): void {
    this.filter.set(emptyGroup());
  }

  /**
   * Subscribes what the editors show. A new type or filter re-subscribes: the old view is closed,
   * a new one opened and put into `WorkspaceStore.views`. Grouping and sort alone only `setLayout`.
   */
  protected apply(): void {
    const built = this.built();
    if (!this.type() || built.issues.length > 0) return;
    const next = this.draft();
    const prev = this.applied();
    let view = this.view();
    if (!view || !prev || prev.entityType !== next.entityType || prev.filter !== next.filter) {
      view?.dispose();
      view = this.rt.openView(
        built.tree === null
          ? { entityType: next.entityType }
          : { entityType: next.entityType, filter: built.tree },
        { destroyRef: this.destroyRef },
      );
      this.view.set(view);
      this.store.views.set([view]);
    }
    view.setLayout({ groupBy: next.groupBy, sort: next.sort });
    this.applied.set(next);
    this.focus.set(null);
    this.findMessage.set(null);
  }

  protected saveView(): void {
    const name = this.saveName().trim();
    if (name === '') return;
    this.savedViews.save({
      name,
      entityType: this.entityType(),
      filter: this.filter(),
      groupBy: this.groupBy(),
      sort: this.sortDraft(),
    });
    this.saveName.set('');
  }

  protected loadView(name: string): void {
    const v: SavedView | undefined = this.saved().find((s) => s.name === name);
    if (!v || !this.registry().some((t) => t.type === v.entityType)) return;
    this.entityType.set(v.entityType);
    const filter: FilterDraft = reId(v.filter);
    this.filter.set(filter.kind === 'group' ? filter : emptyGroup());
    this.groupBy.set(v.groupBy.slice(0, MAX_GROUP_BY));
    this.sortDraft.set(v.sort);
    this.apply();
  }

  protected deleteView(name: string): void {
    this.savedViews.remove(name);
  }

  private async find(entityType: string, id: string): Promise<void> {
    const view = this.view();
    this.findMessage.set(null);
    if (!view || view.handle.spec.entityType !== entityType) {
      this.findMessage.set(`${id} is not a ${this.liveType()?.label ?? 'listed'} entity`);
      return;
    }
    const answer = await view.handle.locate(id, PAGE_SIZE);
    if (this.view() !== view) return;
    if (answer.found) this.focus.set({ id, groupPath: answer.groupPath, at: Date.now() });
    else this.findMessage.set(`${id} is not in the current filter`);
  }
}
