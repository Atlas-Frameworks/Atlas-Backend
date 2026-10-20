/**
 * The mock's data: countries, connections, airports and airplanes (with crew), generated
 * deterministically from a seed and changed by {@link World.step}.
 */

export interface Country {
  id: string;
  code: string;
  name: string;
  region: string;
  version: number;
}

export interface Connection {
  id: string;
  name: string;
  countryIds: string[];
  criteria: { minAltitude?: number; airlines?: string[] };
  version: number;
}

export interface Runway {
  length: number;
  surface: string;
}

export interface Airport {
  id: string;
  countryId: string;
  iata: string;
  name: string;
  lat: number;
  lon: number;
  runways: Runway[];
  version: number;
}

export interface CrewMember {
  memberId: string;
  role: string;
  name: string;
}

export interface Airplane {
  id: string;
  callsign: string;
  airline: string;
  aircraftKind: string;
  countryId: string;
  airportId: string | null;
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  speed: number;
  crew: CrewMember[];
  version: number;
  updatedAt: number;
}

export type EntityType = 'airplanes' | 'airports' | 'countries' | 'connections';

/** What changed in one step, per entity type. */
export interface ChangeSet {
  /** Upserted (created or changed) ids. */
  upserted: Map<EntityType, Set<string>>;
  /** Deleted ids. */
  deleted: Map<EntityType, Set<string>>;
  /** Ids whose map fields (position, icon, label) changed. */
  moved: Set<string>;
}

export interface WorldOptions {
  seed?: number;
  airplanes?: number;
  airports?: number;
  countries?: number;
  connections?: number;
}

export const AIRLINES = ['LY', 'BA', 'LH', 'AF', 'UA', 'DL', 'EK', 'TK', 'KL', 'AZ', 'IB', 'QR'];
export const AIRCRAFT_KINDS = ['B738', 'B789', 'A320', 'A321', 'A359', 'E190', 'B77W', 'A388'];
const REGIONS = [
  'Europe',
  'Middle East',
  'Africa',
  'Asia',
  'North America',
  'South America',
  'Oceania',
];
const SURFACES = ['asphalt', 'concrete', 'grass'];
const ROLES = ['captain', 'first officer', 'purser', 'flight attendant'];
const FIRST = [
  'Dana',
  'Noa',
  'Avi',
  'Maya',
  'Yoni',
  'Tal',
  'Omer',
  'Shira',
  'Lior',
  'Gal',
  'Ron',
  'Eden',
];
const LAST = ['Cohen', 'Levi', 'Mizrahi', 'Peretz', 'Biton', 'Friedman', 'Katz', 'Azulay', 'Golan'];

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UUID-shaped id derived from the random source (deterministic per seed). */
function uuid(rnd: () => number): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)]!;
}

function letters(rnd: () => number, n: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(rnd() * 26))).join('');
}

export class World {
  readonly countries = new Map<string, Country>();
  readonly connections = new Map<string, Connection>();
  readonly airports = new Map<string, Airport>();
  readonly airplanes = new Map<string, Airplane>();
  /** Airplane ids in a fixed order, for picking which ones move. */
  private planeOrder: string[] = [];
  private cursor = 0;
  private readonly rnd: () => number;
  private nextCallsign = 1;
  now = Date.UTC(2026, 9, 20, 10, 0, 0);

  constructor(readonly options: WorldOptions = {}) {
    this.rnd = prng(options.seed ?? 42);
    this.seed();
  }

  /** Seeds every table (deterministic for a given seed and sizes). */
  private seed(): void {
    const rnd = this.rnd;
    const nCountries = this.options.countries ?? 60;
    const usedCodes = new Set<string>();
    for (let i = 0; i < nCountries; i++) {
      let code = letters(rnd, 2);
      while (usedCodes.has(code)) code = letters(rnd, 2);
      usedCodes.add(code);
      const c: Country = {
        id: uuid(rnd),
        code,
        name: `Country ${code}`,
        region: REGIONS[i % REGIONS.length]!,
        version: 1,
      };
      this.countries.set(c.id, c);
    }
    const countryIds = [...this.countries.keys()];
    for (let i = 0; i < (this.options.connections ?? 20); i++) {
      const ids = new Set<string>();
      const n = 1 + Math.floor(rnd() * 5);
      while (ids.size < n) ids.add(pick(rnd, countryIds));
      const criteria: Connection['criteria'] = {};
      if (rnd() < 0.3) criteria.minAltitude = 1_000 * Math.floor(rnd() * 10);
      if (rnd() < 0.3) criteria.airlines = [pick(rnd, AIRLINES), pick(rnd, AIRLINES)];
      const conn: Connection = {
        id: uuid(rnd),
        name: `Connection ${i + 1}`,
        countryIds: [...ids],
        criteria,
        version: 1,
      };
      this.connections.set(conn.id, conn);
    }
    const usedIata = new Set<string>();
    for (let i = 0; i < (this.options.airports ?? 400); i++) {
      let iata = letters(rnd, 3);
      while (usedIata.has(iata)) iata = letters(rnd, 3);
      usedIata.add(iata);
      const runways = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
        length: 1_500 + Math.floor(rnd() * 2_500),
        surface: pick(rnd, SURFACES),
      }));
      const ap: Airport = {
        id: uuid(rnd),
        countryId: pick(rnd, countryIds),
        iata,
        name: `${iata} International`,
        lat: -60 + rnd() * 130,
        lon: -180 + rnd() * 360,
        runways,
        version: 1,
      };
      this.airports.set(ap.id, ap);
    }
    for (let i = 0; i < (this.options.airplanes ?? 3_000); i++) this.createAirplane();
  }

  private createAirplane(): Airplane {
    const rnd = this.rnd;
    const airportIds = [...this.airports.keys()];
    const airport = this.airports.get(pick(rnd, airportIds))!;
    const airline = pick(rnd, AIRLINES);
    const p: Airplane = {
      id: uuid(rnd),
      callsign: `${airline}${String(this.nextCallsign++).padStart(4, '0')}`,
      airline,
      aircraftKind: pick(rnd, AIRCRAFT_KINDS),
      countryId: airport.countryId,
      airportId: airport.id,
      lat: airport.lat + (rnd() - 0.5) * 10,
      lon: airport.lon + (rnd() - 0.5) * 10,
      altitude: Math.floor(rnd() * 12_000),
      heading: rnd() * 360,
      speed: 150 + rnd() * 120,
      crew: this.newCrew(),
      version: 1,
      updatedAt: this.now,
    };
    p.lat = clampLat(p.lat);
    p.lon = wrapLon(p.lon);
    this.airplanes.set(p.id, p);
    this.planeOrder.push(p.id);
    return p;
  }

  private newCrew(): CrewMember[] {
    return Array.from({ length: 2 + Math.floor(this.rnd() * 3) }, (_, i) => this.crewMember(i));
  }

  private crewMember(i: number): CrewMember {
    return {
      memberId: uuid(this.rnd),
      role: ROLES[Math.min(i, ROLES.length - 1)]!,
      name: `${pick(this.rnd, FIRST)} ${pick(this.rnd, LAST)}`,
    };
  }

  /**
   * Advances time by `dtMs` and changes `moves` airplanes (positions), plus occasional
   * attribute, crew, delete and create changes in proportion.
   */
  step(dtMs: number, moves: number): ChangeSet {
    this.now += dtMs;
    if (this.planeOrder.length > this.airplanes.size * 1.25 + 100) {
      this.planeOrder = [...this.airplanes.keys()];
      this.cursor = 0;
    }
    const rnd = this.rnd;
    const changes: ChangeSet = { upserted: new Map(), deleted: new Map(), moved: new Set() };
    const up = (t: EntityType, id: string) => {
      let s = changes.upserted.get(t);
      if (!s) changes.upserted.set(t, (s = new Set()));
      s.add(id);
    };
    const del = (t: EntityType, id: string) => {
      let s = changes.deleted.get(t);
      if (!s) changes.deleted.set(t, (s = new Set()));
      s.add(id);
    };
    const n = Math.min(moves, this.planeOrder.length);
    for (let i = 0; i < n; i++) {
      if (this.cursor >= this.planeOrder.length) this.cursor = 0;
      const id = this.planeOrder[this.cursor++]!;
      const p = this.airplanes.get(id);
      if (!p) continue;
      // ~5-10 s of flight at `speed` m/s along `heading`.
      const dist = p.speed * 7.5;
      const rad = (p.heading * Math.PI) / 180;
      p.lat = clampLat(p.lat + (Math.cos(rad) * dist) / 111_320);
      p.lon = wrapLon(
        p.lon +
          (Math.sin(rad) * dist) / (111_320 * Math.max(0.1, Math.cos((p.lat * Math.PI) / 180))),
      );
      if (Math.abs(p.lat) >= 80) p.heading = (p.heading + 180) % 360;
      p.heading = (p.heading + (rnd() - 0.5) * 10 + 360) % 360;
      p.altitude = Math.max(0, Math.min(13_000, Math.round(p.altitude + (rnd() - 0.5) * 400)));
      p.speed = Math.max(120, Math.min(290, p.speed + (rnd() - 0.5) * 10));
      p.version++;
      p.updatedAt = this.now;
      up('airplanes', id);
      changes.moved.add(id);
    }
    // Rarer changes, proportional to the move rate.
    const rare = (perMove: number) => {
      const x = n * perMove;
      return Math.floor(x) + (rnd() < x - Math.floor(x) ? 1 : 0);
    };
    for (let i = rare(0.002); i > 0; i--) {
      const p = this.randomPlane();
      if (!p) break;
      if (rnd() < 0.5) p.airline = pick(rnd, AIRLINES);
      else p.aircraftKind = pick(rnd, AIRCRAFT_KINDS);
      p.version++;
      up('airplanes', p.id);
      changes.moved.add(p.id); // icon and label may change
    }
    for (let i = rare(0.003); i > 0; i--) {
      const p = this.randomPlane();
      if (!p) break;
      this.changeCrew(p);
      up('airplanes', p.id);
    }
    for (let i = rare(0.0005); i > 0; i--) {
      const p = this.randomPlane();
      if (!p) break;
      this.deleteAirplane(p.id);
      del('airplanes', p.id);
    }
    for (let i = rare(0.0005); i > 0; i--) {
      const p = this.createAirplane();
      up('airplanes', p.id);
      changes.moved.add(p.id);
    }
    for (let i = rare(0.0002); i > 0; i--) {
      const ap = pick(rnd, [...this.airports.values()]);
      ap.runways.push({ length: 1_500 + Math.floor(rnd() * 2_500), surface: pick(rnd, SURFACES) });
      if (ap.runways.length > 5) ap.runways.splice(0, 2);
      ap.version++;
      up('airports', ap.id);
    }
    return changes;
  }

  /** Replaces one crew member (a child-row change: bumps the airplane version). */
  changeCrew(p: Airplane): void {
    const i = Math.floor(this.rnd() * p.crew.length);
    p.crew[i] = this.crewMember(i);
    p.version++;
    p.updatedAt = this.now;
  }

  deleteAirplane(id: string): void {
    this.airplanes.delete(id);
  }

  private randomPlane(): Airplane | undefined {
    for (let tries = 0; tries < 10; tries++) {
      const id = this.planeOrder[Math.floor(this.rnd() * this.planeOrder.length)];
      const p = id === undefined ? undefined : this.airplanes.get(id);
      if (p) return p;
    }
    this.planeOrder = [...this.airplanes.keys()];
    this.cursor = 0;
    return undefined;
  }
}

function clampLat(lat: number): number {
  return Math.max(-85, Math.min(85, lat));
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
