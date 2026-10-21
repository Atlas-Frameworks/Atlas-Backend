import { BadRequestException } from '@nestjs/common';
import { parseSort, type SortSpec, type SortType } from '../views/sort-keys.js';

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

/** "?sort=item_price:desc" → a sort on one of the view's sortable columns. */
export function optionalSort(
  name: string,
  raw: unknown,
  sortable: Readonly<Record<string, SortType>>,
): SortSpec | undefined {
  if (isUnset(raw)) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    invalid(`${name} must be given once`);
  }
  const sort = parseSort(raw, sortable);
  if (typeof sort === 'string') {
    invalid(sort);
  }
  return sort;
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
