import type { ChangeEvent } from '../changes/change-event.js';
import type { Dependency } from './define-query.js';
import type { Row } from './view-diff.js';

/**
 * Exact-match conditions a view's SQL applies to its own type, e.g.
 * `{ customer_id: 'X' }` for `WHERE o.customer_id = X`. Field names are
 * the entity's, as in change events.
 */
export type Match = Readonly<Record<string, unknown>>;

/** The conditions that are set: a param left undefined adds none. */
export function matchOf(conditions: Record<string, unknown>): Match {
  return Object.fromEntries(
    Object.entries(conditions).filter(([, value]) => value !== undefined),
  );
}

/**
 * Throws unless every match field is a filter field of the query's own type:
 * a change to any other field is ignored, so the condition would never be
 * checked when the field changes.
 */
export function checkMatch(
  match: Match,
  own: Dependency | undefined,
  query: string,
): void {
  for (const field of Object.keys(match)) {
    const isFilter =
      own?.filter === undefined
        ? !own?.shown?.includes(field)
        : own.filter.includes(field);
    if (!isFilter) {
      throw new Error(
        `query ${query}: match field ${field} must be a filter field of its own type`,
      );
    }
  }
}

/**
 * False when the entity is known not to match after this change, so the
 * view needs no query: it skips the change, or removes the entity if it
 * holds it. A field's value comes from the event, or else from the row the
 * view holds (unchanged by the event). A field known from neither is a
 * maybe: only the re-check can tell.
 */
export function mayMatch(
  match: Match,
  evt: ChangeEvent,
  held: Row | undefined,
): boolean {
  const after = evt.changes?.new ?? {};
  for (const [field, wanted] of Object.entries(match)) {
    let value: unknown;
    if (field in after) {
      value = after[field];
    } else if (held && field in held) {
      value = held[field];
    } else {
      continue;
    }
    if (!same(value, wanted)) {
      return false;
    }
  }
  return true;
}

/** Equal as JSON values; numbers and numeric strings compare by text. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }
  return String(a) === String(b);
}
