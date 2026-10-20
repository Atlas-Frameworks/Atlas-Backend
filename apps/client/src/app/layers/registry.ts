import { Injectable, inject } from '@angular/core';
import { ATLAS_ENV } from '../config/environment';

/** Filter operators of contracts §5. */
export type FilterOp =
  | 'eq'
  | 'neq'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains'
  | 'isNull'
  | 'notNull';

export const FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'contains',
  'isNull',
  'notNull',
];

export type FieldType = 'string' | 'number' | 'boolean' | 'uuid' | 'timestamp';

/** One field of `GET /meta/registry`. */
export interface RegistryField {
  name: string;
  label: string;
  type: FieldType;
  ops: FilterOp[];
  groupable: boolean;
  sortable: boolean;
  /** Known values (enums), for a picker instead of free text. */
  values?: string[];
}

export interface RegistryType {
  type: string;
  label: string;
  map: boolean;
  defaultSort: string;
  fields: RegistryField[];
}

const FIELD_TYPES = new Set<string>(['string', 'number', 'boolean', 'uuid', 'timestamp']);
const OPS = new Set<string>(FILTER_OPS);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFilterOp = (v: unknown): v is FilterOp => typeof v === 'string' && OPS.has(v);
const isFieldType = (v: unknown): v is FieldType => typeof v === 'string' && FIELD_TYPES.has(v);

/** Validates the `GET /meta/registry` body; unknown operators and malformed fields are dropped. */
export function parseRegistry(body: unknown): RegistryType[] {
  const types = isRecord(body) ? body['types'] : undefined;
  if (!Array.isArray(types)) throw new Error('GET /meta/registry: no "types" list');
  const out: RegistryType[] = [];
  for (const t of types) {
    if (!isRecord(t) || typeof t['type'] !== 'string' || !Array.isArray(t['fields'])) continue;
    const fields: RegistryField[] = [];
    for (const f of t['fields']) {
      if (!isRecord(f) || typeof f['name'] !== 'string' || !isFieldType(f['type'])) continue;
      const ops = Array.isArray(f['ops']) ? f['ops'].filter(isFilterOp) : [];
      const values = Array.isArray(f['values'])
        ? f['values'].filter((v): v is string => typeof v === 'string')
        : undefined;
      fields.push({
        name: f['name'],
        label: typeof f['label'] === 'string' ? f['label'] : f['name'],
        type: f['type'],
        ops,
        groupable: f['groupable'] === true,
        sortable: f['sortable'] === true,
        ...(values && values.length > 0 ? { values } : {}),
      });
    }
    const firstSortable = fields.find((f) => f.sortable)?.name ?? '';
    out.push({
      type: t['type'],
      label: typeof t['label'] === 'string' ? t['label'] : t['type'],
      map: t['map'] === true,
      defaultSort: typeof t['defaultSort'] === 'string' ? t['defaultSort'] : firstSortable,
      fields,
    });
  }
  return out;
}

/** Reads the field registry metadata the filter builder is generated from. */
@Injectable({ providedIn: 'root' })
export class RegistryApi {
  private readonly env = inject(ATLAS_ENV);

  async load(signal?: AbortSignal): Promise<RegistryType[]> {
    const res = await fetch(this.env.registryUrl, signal ? { signal } : {});
    if (!res.ok) throw new Error(`GET /meta/registry: HTTP ${res.status}`);
    return parseRegistry(await res.json());
  }
}
