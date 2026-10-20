import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthStore } from '../auth/auth.store';
import type { GroupDraft } from './filter-model';

/** What a saved view restores: the type, the filter draft, grouping and sort. */
export interface SavedView {
  name: string;
  entityType: string;
  filter: GroupDraft;
  groupBy: string[];
  sort: { field: string; dir: 'asc' | 'desc' };
}

const PREFIX = 'atlas.savedViews.';

/** The user id from the dev JWT (`userId`, else `sub`), or null. Never verified: a storage key only. */
export function tokenUser(token: string | null): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const json: unknown = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
    if (typeof json !== 'object' || json === null) return null;
    const claims: Record<string, unknown> = { ...json };
    const id = claims['userId'] ?? claims['sub'];
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

function isSavedView(v: unknown): v is SavedView {
  if (typeof v !== 'object' || v === null) return false;
  const r: Record<string, unknown> = { ...v };
  return (
    typeof r['name'] === 'string' &&
    typeof r['entityType'] === 'string' &&
    typeof r['filter'] === 'object' &&
    Array.isArray(r['groupBy']) &&
    typeof r['sort'] === 'object'
  );
}

/**
 * Saved views per user in localStorage (POC convenience only: no sync, no sharing). Storage
 * failures (private mode, quota) leave the list in memory for the session.
 */
@Injectable({ providedIn: 'root' })
export class SavedViewsStore {
  private readonly auth = inject(AuthStore);
  private readonly key = computed(() => {
    const session = this.auth.session();
    return PREFIX + (tokenUser(session?.token ?? null) ?? session?.label ?? 'anonymous');
  });
  private readonly saved = signal<{ key: string; views: SavedView[] } | null>(null);

  readonly views = computed(() => {
    const key = this.key();
    const cached = this.saved();
    return cached?.key === key ? cached.views : read(key);
  });

  save(view: SavedView): void {
    this.write([...this.views().filter((v) => v.name !== view.name), view]);
  }

  remove(name: string): void {
    this.write(this.views().filter((v) => v.name !== name));
  }

  private write(views: SavedView[]): void {
    const key = this.key();
    this.saved.set({ key, views });
    try {
      localStorage.setItem(key, JSON.stringify(views));
    } catch {
      // Storage unavailable: keep the in-memory list.
    }
  }
}

function read(key: string): SavedView[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSavedView) : [];
  } catch {
    return [];
  }
}
