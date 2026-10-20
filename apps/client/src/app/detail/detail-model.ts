/**
 * Turns a detail row's JSON fields into something a template can render without knowing the
 * entity type: scalars become label/value pairs, arrays of objects become tables, nested objects
 * become sections (recursively). Known field names get nicer labels and number formats.
 */

export interface DetailField {
  key: string;
  label: string;
  text: string;
}

export interface DetailTable {
  key: string;
  label: string;
  /** `isId`: an identifier column (long, low value): rendered truncated with the full text on hover. */
  columns: readonly { key: string; label: string; isId: boolean }[];
  /** Cell texts per row, in column order. */
  rows: readonly (readonly string[])[];
}

export interface DetailSection {
  key: string;
  label: string;
  node: DetailNode;
}

export interface DetailNode {
  fields: readonly DetailField[];
  tables: readonly DetailTable[];
  sections: readonly DetailSection[];
}

/** Display labels for field names the domain is known to use (dotted registry names too). */
const LABELS: Record<string, string> = {
  id: 'ID',
  callsign: 'Callsign',
  airline: 'Airline',
  aircraftKind: 'Aircraft',
  altitude: 'Altitude (m)',
  speed: 'Speed (m/s)',
  heading: 'Heading (°)',
  'country.code': 'Country',
  'country.region': 'Region',
  'airport.iata': 'Airport',
  'airport.runwayCount': 'Airport runways',
  countryId: 'Country ID',
  airportId: 'Airport ID',
  lat: 'Latitude',
  lon: 'Longitude',
  updatedAt: 'Updated',
  crew: 'Crew',
  memberId: 'Member ID',
  role: 'Role',
  name: 'Name',
  airport: 'Airport',
  iata: 'IATA',
  runways: 'Runways',
  runwayCount: 'Runways',
  length: 'Length (m)',
  surface: 'Surface',
};

/** Fraction digits per known numeric field; other numbers get up to 2. */
const DIGITS: Record<string, number> = { lat: 5, lon: 5, heading: 0, speed: 0, altitude: 0 };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const numberFormats = new Map<number, Intl.NumberFormat>();

/** `crewMember` → "Crew member", `airport.runwayCount` → "Airport runway count". */
export function fieldLabel(key: string): string {
  const known = LABELS[key];
  if (known) return known;
  const words = key
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One value as display text; objects and arrays inside table cells fall back to compact JSON. */
export function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return formatNumber(value, DIGITS[key] ?? 2);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    return ISO_DATE.test(value) ? value.replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC') : value;
  }
  if (Array.isArray(value) && value.every(isScalar)) {
    return value.length === 0 ? '—' : value.map((v) => formatValue(key, v)).join(', ');
  }
  return JSON.stringify(value);
}

export function describeFields(fields: Readonly<Record<string, unknown>>): DetailNode {
  const out = {
    fields: [] as DetailField[],
    tables: [] as DetailTable[],
    sections: [] as DetailSection[],
  };
  for (const [key, value] of Object.entries(fields)) {
    const label = fieldLabel(key);
    if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
      out.tables.push(describeTable(key, label, value));
    } else if (isRecord(value)) {
      out.sections.push({ key, label, node: describeFields(value) });
    } else {
      out.fields.push({ key, label, text: formatValue(key, value) });
    }
  }
  return out;
}

function describeTable(
  key: string,
  label: string,
  items: readonly Record<string, unknown>[],
): DetailTable {
  const keys: string[] = [];
  for (const item of items) for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k);
  return {
    key,
    label,
    columns: keys.map((k) => ({
      key: k,
      label: fieldLabel(k),
      isId: k === 'id' || k.endsWith('Id'),
    })),
    rows: items.map((item) => keys.map((k) => formatValue(k, item[k]))),
  };
}

function formatNumber(value: number, digits: number): string {
  let f = numberFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits });
    numberFormats.set(digits, f);
  }
  return f.format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}
