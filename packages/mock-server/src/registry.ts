/**
 * The mock's field registry: the fields a client may filter, group and sort by, served as
 * `GET /meta/registry` (the read-only metadata the layers panel builds its filter editor from),
 * plus filter validation and evaluation for contracts §5.
 */
import type { Airplane, Airport, Connection, EntityType, World } from './world.js';
import { AIRCRAFT_KINDS, AIRLINES } from './world.js';

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

export type FieldType = 'string' | 'number' | 'boolean' | 'uuid' | 'timestamp';
export type Value = string | number | boolean | null;

const STRING_OPS: FilterOp[] = ['eq', 'neq', 'in', 'nin', 'contains', 'isNull', 'notNull'];
const NUMBER_OPS: FilterOp[] = [
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
  'notNull',
];
const UUID_OPS: FilterOp[] = ['eq', 'neq', 'in', 'nin', 'isNull', 'notNull'];

export interface MockField<E> {
  name: string;
  label: string;
  type: FieldType;
  ops: FilterOp[];
  groupable?: boolean;
  sortable?: boolean;
  /** Known values, for the value editor (optional). */
  values?: string[];
  get(e: E, world: World): Value;
}

export interface MockType<E> {
  type: EntityType;
  label: string;
  /** Whether the type has a map shape. */
  map: boolean;
  fields: MockField<E>[];
  defaultSort: string;
  all(world: World): Iterable<E>;
  get(world: World, id: string): E | undefined;
  id(e: E): string;
  version(e: E): number;
  countryId(e: E): string;
  /** Map shape: lon, lat, alt, icon, label. */
  mapShape?(e: E): { lon: number; lat: number; alt: number; icon: number; label: string };
  /** A connection's extra criteria (e.g. minimum altitude); true when absent. */
  inCriteria?(e: E, criteria: Connection['criteria']): boolean;
  /** Detail: the row fields plus nested data. */
  detail(e: E, world: World): Record<string, unknown>;
}

const airplanes: MockType<Airplane> = {
  type: 'airplanes',
  label: 'Airplanes',
  map: true,
  defaultSort: 'callsign',
  fields: [
    {
      name: 'callsign',
      label: 'Callsign',
      type: 'string',
      ops: STRING_OPS,
      sortable: true,
      get: (p) => p.callsign,
    },
    {
      name: 'airline',
      label: 'Airline',
      type: 'string',
      ops: STRING_OPS,
      groupable: true,
      sortable: true,
      values: AIRLINES,
      get: (p) => p.airline,
    },
    {
      name: 'aircraftKind',
      label: 'Aircraft',
      type: 'string',
      ops: STRING_OPS,
      groupable: true,
      sortable: true,
      values: AIRCRAFT_KINDS,
      get: (p) => p.aircraftKind,
    },
    {
      name: 'altitude',
      label: 'Altitude (m)',
      type: 'number',
      ops: NUMBER_OPS,
      sortable: true,
      get: (p) => p.altitude,
    },
    {
      name: 'speed',
      label: 'Speed (m/s)',
      type: 'number',
      ops: NUMBER_OPS,
      sortable: true,
      get: (p) => Math.round(p.speed),
    },
    {
      name: 'heading',
      label: 'Heading',
      type: 'number',
      ops: NUMBER_OPS,
      get: (p) => Math.round(p.heading),
    },
    {
      name: 'country.code',
      label: 'Country',
      type: 'string',
      ops: STRING_OPS,
      groupable: true,
      sortable: true,
      get: (p, w) => w.countries.get(p.countryId)?.code ?? null,
    },
    {
      name: 'country.region',
      label: 'Region',
      type: 'string',
      ops: STRING_OPS,
      groupable: true,
      sortable: true,
      get: (p, w) => w.countries.get(p.countryId)?.region ?? null,
    },
    {
      name: 'airport.iata',
      label: 'Airport',
      type: 'string',
      ops: STRING_OPS,
      groupable: true,
      sortable: true,
      get: (p, w) => (p.airportId ? (w.airports.get(p.airportId)?.iata ?? null) : null),
    },
    {
      name: 'airport.runwayCount',
      label: 'Airport runways',
      type: 'number',
      ops: NUMBER_OPS,
      sortable: true,
      get: (p, w) => (p.airportId ? (w.airports.get(p.airportId)?.runways.length ?? null) : null),
    },
    {
      name: 'countryId',
      label: 'Country id',
      type: 'uuid',
      ops: UUID_OPS,
      get: (p) => p.countryId,
    },
  ],
  all: (w) => w.airplanes.values(),
  get: (w, id) => w.airplanes.get(id),
  id: (p) => p.id,
  version: (p) => p.version,
  countryId: (p) => p.countryId,
  inCriteria: (p, c) =>
    (c.minAltitude === undefined || p.altitude >= c.minAltitude) &&
    (c.airlines === undefined || c.airlines.includes(p.airline)),
  mapShape: (p) => ({
    lon: p.lon,
    lat: p.lat,
    alt: p.altitude,
    icon: Math.max(0, AIRCRAFT_KINDS.indexOf(p.aircraftKind)),
    label: p.callsign,
  }),
  detail: (p, w) => {
    const ap = p.airportId ? w.airports.get(p.airportId) : undefined;
    return {
      lat: p.lat,
      lon: p.lon,
      updatedAt: new Date(p.updatedAt).toISOString(),
      crew: p.crew.map((c) => ({ ...c })),
      airport: ap
        ? { id: ap.id, iata: ap.iata, name: ap.name, runways: ap.runways.map((r) => ({ ...r })) }
        : null,
    };
  },
};

const airports: MockType<Airport> = {
  type: 'airports',
  label: 'Airports',
  map: true,
  defaultSort: 'iata',
  fields: [
    {
      name: 'iata',
      label: 'IATA',
      type: 'string',
      ops: STRING_OPS,
      sortable: true,
      get: (a) => a.iata,
    },
    {
      name: 'name',
      label: 'Name',
      type: 'string',
      ops: STRING_OPS,
      sortable: true,
      get: (a) => a.name,
    },
    {
      name: 'runwayCount',
      label: 'Runways',
      type: 'number',
      ops: NUMBER_OPS,
      sortable: true,
      groupable: true,
      get: (a) => a.runways.length,
    },
    {
      name: 'country.code',
      label: 'Country',
      type: 'string',
      ops: STRING_OPS,
      groupable: true,
      sortable: true,
      get: (a, w) => w.countries.get(a.countryId)?.code ?? null,
    },
    {
      name: 'country.region',
      label: 'Region',
      type: 'string',
      ops: STRING_OPS,
      groupable: true,
      sortable: true,
      get: (a, w) => w.countries.get(a.countryId)?.region ?? null,
    },
  ],
  all: (w) => w.airports.values(),
  get: (w, id) => w.airports.get(id),
  id: (a) => a.id,
  version: (a) => a.version,
  countryId: (a) => a.countryId,
  mapShape: (a) => ({ lon: a.lon, lat: a.lat, alt: 0, icon: 0, label: a.iata }),
  detail: (a) => ({ lat: a.lat, lon: a.lon, runways: a.runways.map((r) => ({ ...r })) }),
};

// eslint-style any-erasure: the server treats every type uniformly.
export type AnyType = MockType<any>;
export const TYPES: Record<string, AnyType> = { airplanes, airports };

/** `GET /meta/registry` body. */
export function registryMetadata() {
  return {
    types: Object.values(TYPES).map((t) => ({
      type: t.type,
      label: t.label,
      map: t.map,
      defaultSort: t.defaultSort,
      fields: t.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        ops: f.ops,
        groupable: f.groupable ?? false,
        sortable: f.sortable ?? false,
        ...(f.values ? { values: f.values } : {}),
      })),
    })),
  };
}

export function rowFields(t: AnyType, e: unknown, world: World): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const f of t.fields) out[f.name] = f.get(e, world);
  return out;
}

// ---------------------------------------------------------------------------
// Filters (contracts §5)
// ---------------------------------------------------------------------------

export type FilterNode =
  { and: FilterNode[] } | { or: FilterNode[] } | { field: string; op: FilterOp; value?: unknown };

export class FilterError extends Error {}

const LIMITS = { depth: 4, conditions: 20, inValues: 200, containsMin: 3 };

/** Parses and validates a filter's JSON text; `''` means no filter. */
export function parseFilter(t: AnyType, text: string): FilterNode | null {
  if (text.trim() === '') return null;
  if (text.length > 16_384) throw new FilterError('filter too large');
  let tree: unknown;
  try {
    tree = JSON.parse(text);
  } catch {
    throw new FilterError('filter is not valid JSON');
  }
  let conditions = 0;
  const check = (node: unknown, depth: number): FilterNode => {
    if (depth > LIMITS.depth) throw new FilterError(`filter deeper than ${LIMITS.depth}`);
    if (typeof node !== 'object' || node === null)
      throw new FilterError('filter node must be an object');
    const n: Record<string, unknown> = { ...node };
    for (const key of ['and', 'or'] as const) {
      if (key in n) {
        const list = n[key];
        if (!Array.isArray(list) || list.length === 0)
          throw new FilterError(`"${key}" needs a non-empty list`);
        const children = list.map((c) => check(c, depth + 1));
        return key === 'and' ? { and: children } : { or: children };
      }
    }
    if (++conditions > LIMITS.conditions)
      throw new FilterError(`more than ${LIMITS.conditions} conditions`);
    const field = t.fields.find((f) => f.name === n.field);
    if (!field) throw new FilterError(`unknown field "${String(n.field)}"`);
    const op = field.ops.find((o) => o === n.op);
    if (op === undefined)
      throw new FilterError(`operator "${String(n.op)}" is not allowed on ${field.name}`);
    const v = n.value;
    if (op === 'in' || op === 'nin') {
      if (!Array.isArray(v) || v.length === 0)
        throw new FilterError(`"${op}" needs a list of values`);
      if (v.length > LIMITS.inValues)
        throw new FilterError(`"${op}" has more than ${LIMITS.inValues} values`);
    } else if (op === 'between') {
      if (!Array.isArray(v) || v.length !== 2) throw new FilterError('"between" needs [from, to]');
    } else if (op === 'contains') {
      if (typeof v !== 'string' || v.length < LIMITS.containsMin) {
        throw new FilterError(`"contains" needs at least ${LIMITS.containsMin} characters`);
      }
    } else if (op !== 'isNull' && op !== 'notNull') {
      if (v === undefined || v === null || typeof v === 'object')
        throw new FilterError(`"${op}" on ${field.name} needs a value`);
      if (field.type === 'number' && typeof v !== 'number')
        throw new FilterError(`${field.name} is a number`);
    }
    return { field: field.name, op, value: v };
  };
  return check(tree, 1);
}

export function matches(t: AnyType, node: FilterNode | null, e: unknown, world: World): boolean {
  if (node === null) return true;
  if ('and' in node) return node.and.every((c) => matches(t, c, e, world));
  if ('or' in node) return node.or.some((c) => matches(t, c, e, world));
  const field = t.fields.find((f) => f.name === node.field);
  if (!field) return false;
  const x = field.get(e, world);
  const v = node.value;
  const num = typeof x === 'number' ? x : null;
  switch (node.op) {
    case 'eq':
      return x === v;
    case 'neq':
      return x !== v;
    case 'in':
      return Array.isArray(v) && v.includes(x);
    case 'nin':
      return Array.isArray(v) && !v.includes(x);
    case 'gt':
      return num !== null && typeof v === 'number' && num > v;
    case 'gte':
      return num !== null && typeof v === 'number' && num >= v;
    case 'lt':
      return num !== null && typeof v === 'number' && num < v;
    case 'lte':
      return num !== null && typeof v === 'number' && num <= v;
    case 'between': {
      if (num === null || !Array.isArray(v)) return false;
      const [lo, hi]: unknown[] = v;
      return typeof lo === 'number' && typeof hi === 'number' && num >= lo && num <= hi;
    }
    case 'contains':
      return typeof x === 'string' && x.toLowerCase().includes(String(v).toLowerCase());
    case 'isNull':
      return x === null;
    case 'notNull':
      return x !== null;
    default:
      return false;
  }
}
