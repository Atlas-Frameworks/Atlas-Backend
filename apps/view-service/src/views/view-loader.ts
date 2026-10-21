import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { View } from './view.js';

/** Fills a view with its matching IDs from Postgres. */
@Injectable()
export class ViewLoader {
  constructor(private readonly db: DbService) {}

  /**
   * Loads the view once. Callers that arrive while the load runs share it.
   * A failed load is forgotten, so the next caller tries again.
   */
  ensureLoaded(view: View): Promise<void> {
    view.loading ??= this.load(view).catch((err: unknown) => {
      view.loading = undefined;
      throw err;
    });
    return view.loading;
  }

  private async load(view: View): Promise<void> {
    const rows = await this.db.query<{ id: string; version: string }>(
      view.statement,
    );
    view.ids.clear();
    for (const row of rows) {
      view.ids.set(row.id, Number(row.version));
    }
    view.loaded = true;
  }
}
