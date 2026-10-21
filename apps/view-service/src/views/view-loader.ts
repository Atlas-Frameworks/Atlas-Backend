import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Dependency } from './define-query.js';
import { toStatement, type SqlStatement } from './sql.js';
import type { VersionRow } from './view-diff.js';
import type { View } from './view.js';

/** Runs a view's query in Postgres: in full, or for some ids only. */
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

  /** Every entity that matches the view's query, with its version. */
  fetchAll(view: View): Promise<VersionRow[]> {
    return this.versions(view.statement);
  }

  /** The ids, of those given, that still match the view's query, with their version. */
  recheck(view: View, ids: string[]): Promise<VersionRow[]> {
    return this.versions(recheckStatement(view.statement, ids));
  }

  /** Runs a dependency's link: ids of the view's type linked to these changed ids. */
  async linked(
    link: Required<Dependency>['link'],
    ids: string[],
  ): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(toStatement(link(ids)));
    return rows.map((row) => row.id);
  }

  private async load(view: View): Promise<void> {
    const rows = await this.fetchAll(view);
    view.ids.clear();
    for (const row of rows) {
      view.ids.set(row.id, row.version);
    }
    view.loaded = true;
  }

  private async versions(stmt: SqlStatement): Promise<VersionRow[]> {
    const rows = await this.db.query<{ id: string; version: string }>(stmt);
    return rows.map((row) => ({ id: row.id, version: Number(row.version) }));
  }
}

/**
 * The view's own SQL, limited to some ids. The developer's SQL is kept as it
 * is, wrapped in a subquery; Postgres moves the id condition inside it, so
 * the re-check is a primary-key lookup. Only SQL text is joined here: the
 * ids are a parameter.
 */
export function recheckStatement(
  statement: SqlStatement,
  ids: string[],
): SqlStatement {
  return {
    text: `SELECT q.id, q.version FROM (${statement.text}) q WHERE q.id = ANY($${statement.values.length + 1})`,
    values: [...statement.values, ids],
  };
}
