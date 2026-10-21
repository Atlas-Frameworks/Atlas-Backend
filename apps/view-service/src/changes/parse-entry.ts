import type { ChangeEvent } from './change-event.js';

/**
 * Reads the change events in one stream entry. Fields come in pairs:
 * Debezium writes the entity key as the field name and the event JSON as the
 * value (contracts §2 calls the field `value`; either works here).
 * Pairs that are not a valid v2 event are returned in `invalid`.
 */
export function parseEntry(fields: string[]): {
  events: ChangeEvent[];
  invalid: string[];
} {
  const events: ChangeEvent[] = [];
  const invalid: string[] = [];
  for (let i = 1; i < fields.length; i += 2) {
    const event = parseEvent(fields[i]);
    if (event) {
      events.push(event);
    } else {
      invalid.push(fields[i]);
    }
  }
  return { events, invalid };
}

function parseEvent(json: string): ChangeEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const e = value as Record<string, unknown>;
  const valid =
    e.schema === 2 &&
    typeof e.type === 'string' &&
    typeof e.id === 'string' &&
    (e.op === 'upsert' || e.op === 'delete') &&
    Number.isSafeInteger(e.version) &&
    Number.isSafeInteger(e.typeSeq) &&
    (e.op === 'delete' || isChanges(e.changes));
  return valid ? (e as unknown as ChangeEvent) : undefined;
}

function isChanges(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return isObject(c.old) && isObject(c.new);
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
