import { Injectable, signal } from '@angular/core';
import type { LiveView } from '../realtime/atlas-realtime.service';

/** An entity picked on the map or in a list. */
export interface EntityRef {
  entityType: string;
  id: string;
}

/** A one-shot request; `at` makes repeated requests for the same entity distinct. */
export interface EntityRequest extends EntityRef {
  at: number;
}

/**
 * Shared workspace state: the contract between the map (A-03), the layers panel (A-04) and the
 * detail drawer (A-05). Each of them reads and writes only these signals, never each other.
 *
 * - `views`: the live views on screen. The layers panel owns them; the map draws one layer per
 *   view (layer id = `view.handle.id`). Until A-04 lands, the workspace page puts in one default
 *   airplanes view.
 * - `selected`: set by a map click or a row click; the drawer shows it, the map labels it.
 * - `flyTo`: the drawer's "Show on map"; the map flies to the entity.
 * - `findInList`: the drawer's "Find in list"; the layers panel locates the entity and jumps to its page.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  readonly views = signal<readonly LiveView[]>([]);
  readonly selected = signal<EntityRef | null>(null);
  readonly flyTo = signal<EntityRequest | null>(null);
  readonly findInList = signal<EntityRequest | null>(null);
  readonly drawerOpen = signal(false);

  select(ref: EntityRef | null): void {
    this.selected.set(ref);
    if (ref) this.drawerOpen.set(true);
  }

  requestFlyTo(ref: EntityRef): void {
    this.flyTo.set({ ...ref, at: Date.now() });
  }

  requestFindInList(ref: EntityRef): void {
    this.findInList.set({ ...ref, at: Date.now() });
  }
}
