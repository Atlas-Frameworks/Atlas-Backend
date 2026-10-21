import { createHash } from 'node:crypto';
import { parseSort, type SortSpec, type SortType } from './sort-keys.js';
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
   * Columns a client may sort by, and how they compare. The SQL must select
   * them; their values are kept in memory for every id, so any sort and any
   * range of rows needs no query.
   */
  sortable?: Record<string, SortType>;
  /** The sort when the client asks for none: "name" or "item_price:desc". Without it, by id. */
  defaultSort?: string;
  build(params: P): Sql;
}

/** How a query depends on one entity type. */
export interface Dependency {
  /**
   * Fields of this type the SQL reads. A change to any other field can't change
   * the result. Leave it out to re-check on every change (always safe).
   */
  fields?: string[];
  /**
   * Required for a type other than `entityType`: SQL returning the `id` of
   * every `entityType` row linked to the changed ids of this type.
   */
  link?: (ids: string[]) => Sql;
}

const names = new Set<string>();

/**
 * Registers a query. Throws if the name is taken, so two queries never share
 * views, if a related type has no link, so its changes can't be missed, or
 * if the default sort is not a sortable column.
 */
export function defineQuery<P>(def: QueryDefinition<P>): QueryDefinition<P> {
  if (names.has(def.name)) {
    throw new Error(`query ${def.name} is already defined`);
  }
  if (def.defaultSort !== undefined) {
    const sort = parseSort(def.defaultSort, def.sortable ?? {});
    if (typeof sort === 'string') {
      throw new Error(`query ${def.name}: defaultSort: ${sort}`);
    }
  }
  for (const [type, dep] of Object.entries(def.dependsOn)) {
    if (type !== def.entityType && dep.link === undefined) {
      throw new Error(`query ${def.name}: dependency ${type} needs a link`);
    }
  }
  names.add(def.name);
  return def;
}

/** The query's default sort, or undefined to sort by id. */
export function defaultSortOf(
  def: QueryDefinition<unknown>,
): SortSpec | undefined {
  if (def.defaultSort === undefined) {
    return undefined;
  }
  const sort = parseSort(def.defaultSort, def.sortable ?? {});
  if (typeof sort === 'string') {
    throw new Error(`query ${def.name}: defaultSort: ${sort}`);
  }
  return sort;
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
