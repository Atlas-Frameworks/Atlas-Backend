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
  /** Entity types whose changes can change the result (used from step 5). */
  dependsOn: string[];
  build(params: P): Sql;
}

const names = new Set<string>();

/** Registers a query. Throws if the name is taken, so two queries never share views. */
export function defineQuery<P>(def: QueryDefinition<P>): QueryDefinition<P> {
  if (names.has(def.name)) {
    throw new Error(`query ${def.name} is already defined`);
  }
  names.add(def.name);
  return def;
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
