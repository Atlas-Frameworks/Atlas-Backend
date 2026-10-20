import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import type { RowData } from '@atlas/client-sdk';
import type { LiveDetail } from '../realtime/atlas-realtime.service';
import { clockTime } from '../workspace/connection-status';
import { WorkspaceStore } from '../workspace/workspace.store';
import type { EntityRef } from '../workspace/workspace.store';
import { describeFields, fieldLabel } from './detail-model';

/** Singular names for the entity types the app knows; others fall back to the type name. */
const TYPE_LABELS: Record<string, string> = { airplanes: 'Airplane', airports: 'Airport' };

/** Fields that name an entity better than its id, in order of preference. */
const TITLE_FIELDS = ['callsign', 'name', 'iata'];

/**
 * The detail drawer (A-05): follows `WorkspaceStore.selected`, holds one live detail subscription
 * for it (the previous one is disposed on every change), and renders the row's JSON generically:
 * scalars as a field list, arrays of objects (crew, runways) as tables, objects as sections.
 */
@Component({
  selector: 'app-detail-drawer',
  imports: [NgTemplateOutlet],
  templateUrl: './detail-drawer.html',
  styleUrl: './detail-drawer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DetailDrawer {
  private readonly store = inject(WorkspaceStore);
  private readonly realtime = inject(AtlasRealtimeService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly detail = signal<LiveDetail | null>(null);

  protected readonly selected = this.store.selected;
  protected readonly row = computed(() => this.detail()?.row() ?? null);
  protected readonly loading = computed(() => this.detail()?.loading() ?? false);
  protected readonly removed = computed(() => this.detail()?.removed() ?? false);
  /** The row, or after removal the last one seen, so the header still names what was removed. */
  protected readonly lastRow = linkedSignal<RowData | null, RowData | null>({
    source: this.row,
    computation: (row, prev) => row ?? (this.removed() ? (prev?.value ?? null) : null),
  });
  protected readonly stale = computed(() => this.detail()?.stale() ?? false);
  protected readonly staleSince = computed(() => this.detail()?.state()?.staleSince ?? null);
  protected readonly staleText = computed(() => {
    const since = this.staleSince();
    return since === null ? 'Stale' : `Stale since ${clockTime(since)}`;
  });

  protected readonly typeLabel = computed(() => {
    const type = this.selected()?.entityType ?? '';
    return TYPE_LABELS[type] ?? fieldLabel(type);
  });
  protected readonly title = computed(() => {
    const fields = this.lastRow()?.fields;
    const name = TITLE_FIELDS.map((f) => fields?.[f]).find((v) => typeof v === 'string' && v);
    return typeof name === 'string' ? name : (this.selected()?.id ?? '');
  });
  protected readonly node = computed(() => {
    const row = this.row();
    return row ? describeFields(row.fields) : null;
  });

  constructor() {
    effect(() => {
      const ref = this.selected();
      untracked(() => this.open(ref));
    });
    this.destroyRef.onDestroy(() => this.detail()?.dispose());
  }

  protected showOnMap(ref: EntityRef): void {
    this.store.requestFlyTo({ entityType: ref.entityType, id: ref.id });
  }

  protected findInList(ref: EntityRef): void {
    this.store.requestFindInList({ entityType: ref.entityType, id: ref.id });
  }

  private open(ref: EntityRef | null): void {
    const current = this.detail();
    if (current && ref?.entityType === current.handle.entityType && ref.id === current.handle.id) {
      return;
    }
    current?.dispose();
    this.detail.set(
      ref
        ? this.realtime.openDetail(ref.entityType, ref.id, { destroyRef: this.destroyRef })
        : null,
    );
  }
}
