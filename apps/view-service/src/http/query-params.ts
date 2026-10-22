import { BadRequestException } from '@nestjs/common';
import type { PageRequest } from '../views/view.service.js';

// Turns raw HTTP query-string values into typed, optional params for views.
// Missing or empty ("?minPrice=") means "not set" and returns undefined.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIST = 200;

function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_PARAM', message });
}

function isUnset(raw: unknown): raw is undefined | '' {
  return raw === undefined || raw === '';
}

export function optionalNumber(name: string, raw: unknown): number | undefined {
  if (isUnset(raw)) {
    return undefined;
  }
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {
    invalid(`${name} must be a number`);
  }
  return n;
}

export function optionalUuid(name: string, raw: unknown): string | undefined {
  if (isUnset(raw)) {
    return undefined;
  }
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    invalid(`${name} must be a uuid`);
  }
  return raw.toLowerCase();
}

export function optionalInteger(
  name: string,
  raw: unknown,
  min: number,
): number | undefined {
  const n = optionalNumber(name, raw);
  if (n !== undefined && (!Number.isInteger(n) || n < min)) {
    invalid(`${name} must be a whole number of at least ${min}`);
  }
  return n;
}

/**
 * ?offset=7&limit=20 — which range of a view's rows to return, in the
 * query's order. Both are optional; without limit, every row from offset on.
 */
export function pageRequest(query: {
  offset?: unknown;
  limit?: unknown;
}): PageRequest {
  return {
    offset: optionalInteger('offset', query.offset, 0),
    limit: optionalInteger('limit', query.limit, 1),
  };
}

/** "?orderBy=price" → one of the allowed values. */
export function optionalOneOf<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
): T | undefined {
  if (isUnset(raw)) {
    return undefined;
  }
  if (
    typeof raw !== 'string' ||
    !(allowed as readonly string[]).includes(raw)
  ) {
    invalid(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

/** "?type=a" → ['a'], "?type=a&type=b" → ['a', 'b']. */
export function optionalList(name: string, raw: unknown): string[] | undefined {
  if (isUnset(raw)) {
    return undefined;
  }
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (
    list.length > MAX_LIST ||
    !list.every((v): v is string => typeof v === 'string' && v !== '')
  ) {
    invalid(`${name} must be 1–${MAX_LIST} non-empty values`);
  }
  return list as string[];
}
