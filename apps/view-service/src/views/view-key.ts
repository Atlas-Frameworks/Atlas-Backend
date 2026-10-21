import { createHash } from 'node:crypto';

// Local stand-in for the filter tree and viewKey() from @atlas/view-engine (E-01).
// Replace with the engine's exports once E-01 lands; the shape follows contracts §5.
export type FilterTree =
  | { and: FilterTree[] }
  | { or: FilterTree[] }
  | { field: string; op: string; value?: unknown };

/**
 * Stable hash of a query, so identical filters share one view.
 * Object keys are sorted, and the children of `and` / `or` are sorted,
 * because their order doesn't change the result.
 */
export function viewKey(entityType: string, filter: FilterTree): string {
  const canonical = JSON.stringify([entityType, normalize(filter)]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalize);
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node).sort()) {
    const value = normalize((node as Record<string, unknown>)[key]);
    out[key] =
      (key === 'and' || key === 'or') && Array.isArray(value)
        ? sortByJson(value)
        : value;
  }
  return out;
}

function sortByJson(items: unknown[]): unknown[] {
  return items
    .map((item) => [JSON.stringify(item), item] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);
}
