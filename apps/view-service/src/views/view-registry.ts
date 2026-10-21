import { Injectable } from '@nestjs/common';
import type { SqlStatement } from './sql.js';
import { View } from './view.js';

/** All views this worker holds, keyed by viewKey. */
@Injectable()
export class ViewRegistry {
  private readonly views = new Map<string, View>();

  /**
   * Returns the view with this key, or creates it, and counts one more user.
   * The caller decides the key; the statement is used only for a new view.
   */
  open(key: string, entityType: string, statement: SqlStatement): View {
    let view = this.views.get(key);
    if (!view) {
      view = new View(key, entityType, statement);
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
