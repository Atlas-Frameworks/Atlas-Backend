import { createHash } from 'node:crypto';
import type { Sql } from './sql.js';

/**
 * A query a route can open as a view. The developer writes the SQL in
 * `build`, adding conditions only for the params that are set.
 * The SQL must return `id` and `version` of `entityType`.
 */
export interface QueryDefinition<P> {
  /** Unique name. It is part of the viewKey, the SQL text is not. */
  name: string;
  /** The entity type whose ids the query returns. */
  entityType: string;
  /**
   * Entity types whose changes can change the result, keyed by type.
   * `entityType` itself is always watched, even when it is not listed.
   */
  dependsOn: Record<string, Dependency>;
  /**
   * The query's SQL for these params. To give it an order, wrap the SELECT in
   * `ordered(…)`: the ORDER BY is then part of the SQL, and the view keeps
   * its rows in that order. Without it, rows are ordered by id.
   */
  build(params: P): Sql;
}

/**
 * How a query depends on one entity type. Every field the SQL reads, in
 * WHERE or in SELECT, must be in `filter` or `shown`; a change to any other
 * field is ignored.
 */
export interface Dependency {
  /**
   * Fields that decide whether a row matches (WHERE, JOIN). A change can add
   * or remove rows, so it is re-checked wherever it may matter. Leave it out
   * to treat every field not in `shown` as a filter (always safe).
   */
  filter?: string[];
  /**
   * Fields only sent to clients, never filtered on. A change matters only to
   * rows the view already holds, so other rows are never re-checked for it.
   * A field filtered on even by some params must be in `filter` instead.
   */
  shown?: string[];
  /**
   * For a related type: the column of the view's row that holds this type's
   * id, e.g. `item_id`. The view then knows from memory which of its rows a
   * changed item is shown in: a `shown` change needs no link query.
   */
  via?: string;
  /**
   * Required for a type other than `entityType`: SQL returning the `id` of
   * every `entityType` row linked to the changed ids of this type. Run for
   * `filter` changes, which can bring rows the view doesn't hold yet.
   */
  link?: (ids: string[]) => Sql;
}

const names = new Set<string>();

/**
 * Registers a query. Throws if the name is taken, so two queries never share
 * views, if a related type has no link, so its changes can't be missed, if
 * a field is both filter and shown, or if `via` is set on the query's own type.
 */
export function defineQuery<P>(def: QueryDefinition<P>): QueryDefinition<P> {
  if (names.has(def.name)) {
    throw new Error(`query ${def.name} is already defined`);
  }
  for (const [type, dep] of Object.entries(def.dependsOn)) {
    if (type !== def.entityType && dep.link === undefined) {
      throw new Error(`query ${def.name}: dependency ${type} needs a link`);
    }
    if (type === def.entityType && dep.via !== undefined) {
      throw new Error(
        `query ${def.name}: via is for related types, not ${type}`,
      );
    }
    const both = (dep.filter ?? []).filter((f) => dep.shown?.includes(f));
    if (both.length > 0) {
      throw new Error(
        `query ${def.name}: ${type}.${both.join(', ')} is both filter and shown`,
      );
    }
  }
  names.add(def.name);
  return def;
}

/** The `via` columns of the query's dependencies. */
export function viaColumnsOf(def: QueryDefinition<unknown>): string[] {
  return Object.values(def.dependsOn).flatMap((dep) =>
    dep.via === undefined ? [] : [dep.via],
  );
}

/**
 * Stable hash of a query name and its params, so the same request shares one view.
 * Params that are undefined are dropped and object keys are sorted;
 * array order is kept.
 */
export function queryKey(name: string, params: unknown): string {
  const canonical = JSON.stringify([name, canonicalize(params)]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) {
      out[key] = canonicalize(item);
    }
  }
  return out;
}
