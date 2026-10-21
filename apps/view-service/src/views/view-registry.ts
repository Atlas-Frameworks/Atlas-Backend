import { Injectable } from '@nestjs/common';
import { View } from './view.js';
import { viewKey, type FilterTree } from './view-key.js';

/** All views this worker holds, keyed by viewKey. */
@Injectable()
export class ViewRegistry {
  private readonly views = new Map<string, View>();

  /** Returns the existing view for this query, or creates it, and counts one more user. */
  open(entityType: string, filter: FilterTree): View {
    const key = viewKey(entityType, filter);
    let view = this.views.get(key);
    if (!view) {
      view = new View(key, entityType, filter);
      this.views.set(key, view);
    }
    view.refCount += 1;
    return view;
  }

  get(key: string): View | undefined {
    return this.views.get(key);
  }

  /**
   * Counts one user fewer. The view stays in memory at refCount 0;
   * step 8 adds the 60 s grace period and removal.
   */
  release(key: string): View | undefined {
    const view = this.views.get(key);
    if (view && view.refCount > 0) {
      view.refCount -= 1;
    }
    return view;
  }

  list(): View[] {
    return [...this.views.values()];
  }
}
