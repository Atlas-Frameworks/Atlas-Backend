import { Injectable } from '@nestjs/common';
import type { SortSpec, SortType } from './sort-keys.js';
import type { SqlStatement } from './sql.js';
import { View } from './view.js';

/** All views this worker holds, keyed by viewKey. */
@Injectable()
export class ViewRegistry {
  private readonly views = new Map<string, View>();

  /**
   * Returns the view with this key, or creates it.
   * The caller decides the key; the statement and sorting are used only for
   * a new view.
   */
  open(
    key: string,
    entityType: string,
    statement: SqlStatement,
    sortable?: Readonly<Record<string, SortType>>,
    defaultSort?: SortSpec,
    via?: readonly string[],
  ): View {
    let view = this.views.get(key);
    if (!view) {
      view = new View(key, entityType, statement, sortable, defaultSort, via);
      this.views.set(key, view);
    }
    return view;
  }

  get(key: string): View | undefined {
    return this.views.get(key);
  }

  remove(key: string): void {
    this.views.delete(key);
  }

  list(): View[] {
    return [...this.views.values()];
  }
}
