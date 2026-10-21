import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Dependency } from './define-query.js';
import { toStatement, type SqlStatement } from './sql.js';
import { hold, type Row } from './view-diff.js';
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

  /** Every row that matches the view's query. */
  fetchAll(view: View): Promise<Row[]> {
    return this.rows(view.statement);
  }

  /**
   * The rows of these ids that still match the view's query: used to re-check
   * changed ids, and to send rows for ids the view holds.
   */
  async fetchByIds(view: View, ids: string[]): Promise<Row[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.rows(recheckStatement(view.statement, ids));
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
    view.hashes.clear();
    for (const row of rows) {
      hold(view, row);
    }
    view.loaded = true;
  }

  /** pg returns bigint `version` as a string; rows carry it as a number. */
  private async rows(stmt: SqlStatement): Promise<Row[]> {
    const rows = await this.db.query<Row>(stmt);
    return rows.map((row) => ({ ...row, version: Number(row.version) }));
  }
}

/**
 * The view's own SQL, limited to some ids, with every column it selects. The developer's SQL is kept as it
 * is, wrapped in a subquery; Postgres moves the id condition inside it, so
 * the re-check is a primary-key lookup. Only SQL text is joined here: the
 * ids are a parameter.
 */
export function recheckStatement(
  statement: SqlStatement,
  ids: string[],
): SqlStatement {
  return {
    text: `SELECT q.* FROM (${statement.text}) q WHERE q.id = ANY($${statement.values.length + 1})`,
    values: [...statement.values, ids],
  };
}
