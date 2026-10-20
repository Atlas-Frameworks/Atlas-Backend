/**
 * C-07 end-to-end: the real SDK (core, map store, pages, detail) over a real WebSocket against
 * the mock server, through every fault type. After each fault the client must end in a state
 * that matches the server's world exactly.
 */
import {
  AtlasCore,
  DetailSubscription,
  MapLayerStore,
  PageSubscription,
  RowCache,
} from '@atlas/client-sdk';
import type { CoreView, DetailState, PageState } from '@atlas/client-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockServer } from '../src/server.js';
import type { Fault } from '../src/server.js';
import type { Airplane } from '../src/world.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: MockServer;
let core: AtlasCore;
let scopeCountries: string[];
let planesView: CoreView;
let highView: CoreView;
let planesMap: MapLayerStore;
let highMap: MapLayerStore;
let page: PageSubscription;
let pageState: PageState | null = null;
let detail: DetailSubscription;
let detailState: DetailState | null = null;
let detailId: string;

const inScope = (p: Airplane) => scopeCountries.includes(p.countryId);
const high = (p: Airplane) => p.altitude > 6_000;

/** Steps the world while the network delivers frames. */
async function run(steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    server.step(100, 150);
    await sleep(15);
  }
}

/** Waits until every subscription is live and nothing is stale, then lets frames drain. */
async function settle(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const st = core.getStatus();
    const ok =
      st.connection === 'open' &&
      st.staleSince === null &&
      st.subscriptions.length > 0 &&
      st.subscriptions.every((s) => s.state === 'live');
    if (ok) {
      await sleep(250);
      const again = core.getStatus();
      if (again.staleSince === null && again.subscriptions.every((s) => s.state === 'live')) return;
    }
    if (Date.now() > deadline) throw new Error(`did not settle: ${JSON.stringify(st)}`);
    await sleep(25);
  }
}

/** Differences between a client map store and the server's world. */
function mapProblems(
  name: string,
  store: MapLayerStore,
  filter: (p: Airplane) => boolean,
): string[] {
  const expected = [...server.world.airplanes.values()].filter(filter);
  const wrong: string[] = [];
  if (store.size !== expected.length)
    wrong.push(`${name}: ${store.size} entities, expected ${expected.length}`);
  for (const p of expected) {
    const slot = store.slotOfId(p.id);
    if (slot === undefined) {
      wrong.push(`${name}: ${p.id} missing`);
      continue;
    }
    if (store.positions[slot * 3] !== p.lon || store.positions[slot * 3 + 1] !== p.lat) {
      wrong.push(
        `${name}: ${p.id} at ${store.positions[slot * 3]},${store.positions[slot * 3 + 1]} not ${p.lon},${p.lat}`,
      );
    }
    if (store.visible[slot] !== 1) wrong.push(`${name}: ${p.id} hidden`);
    if (store.labels.get(slot) !== p.callsign) wrong.push(`${name}: ${p.id} label`);
  }
  return wrong.slice(0, 5);
}

/** Every difference between the client and the server's world (empty = consistent). */
function inconsistencies(): string[] {
  const out = [...mapProblems('planes', planesMap, inScope), ...mapProblems('high', highMap, high)];
  const sorted = [...server.world.airplanes.values()]
    .filter(inScope)
    .toSorted((a, b) =>
      a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : a.id < b.id ? -1 : 1,
    );
  const s = pageState;
  const want = sorted.slice(0, 25);
  if (!s) out.push('no page state');
  else {
    if (
      s.rows.map((r) => `${r.id}@${r.version}`).join() !==
      want.map((p) => `${p.id}@${p.version}`).join()
    ) {
      out.push('page rows differ');
    }
    if (s.total !== sorted.length) out.push(`page total ${s.total}, expected ${sorted.length}`);
    if (s.stale) out.push('page stale');
  }
  const target = server.world.airplanes.get(detailId);
  if (target && detailState?.row?.version !== target.version) {
    out.push(`detail version ${detailState?.row?.version}, expected ${target.version}`);
  }
  if (!target && !detailState?.removed) out.push('detail not removed');
  return out;
}

beforeAll(async () => {
  server = new MockServer({
    port: 0,
    airplanes: 3_000,
    airports: 200,
    countries: 30,
    paused: true,
  });
  const port = await server.listen();
  const byCountry = new Map<string, number>();
  for (const p of server.world.airplanes.values())
    byCountry.set(p.countryId, (byCountry.get(p.countryId) ?? 0) + 1);
  scopeCountries = [...byCountry.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => id);

  core = new AtlasCore({
    services: { '*': `ws://127.0.0.1:${port}/ws` },
    token: 'dev-token',
    backoff: { baseMs: 50, maxMs: 300 },
    resyncTimeoutMs: 2_000,
  });
  planesView = core.openView({ entityType: 'airplanes', scope: { countries: scopeCountries } });
  planesMap = new MapLayerStore('planes');
  planesView.subscribeMap(planesMap);
  planesView.setLayout({ groupBy: [], sort: { field: 'callsign', dir: 'asc' } });
  page = new PageSubscription(
    planesView,
    new RowCache(),
    { pageSize: 25, prefetch: true },
    (st) => {
      pageState = st;
    },
  );
  highView = core.openView({
    entityType: 'airplanes',
    filter: { field: 'altitude', op: 'gt', value: 6_000 },
    scope: { countries: [] },
  });
  highMap = new MapLayerStore('high');
  highView.subscribeMap(highMap);
  detailId = [...server.world.airplanes.values()].find(inScope)!.id;
  detail = new DetailSubscription('airplanes', detailId, (st) => {
    detailState = st;
  });
  detail.core = core.openDetail('airplanes', detailId, detail);
  await settle();
});

afterAll(async () => {
  page.close();
  detail.close();
  core.close();
  await server.close();
});

describe('SDK against the mock server (C-07 end to end)', () => {
  it('starts consistent and stays consistent under normal load', async () => {
    expect(inconsistencies()).toEqual([]);
    await run(20);
    await settle();
    expect(inconsistencies()).toEqual([]);
  });

  const faults: [string, Fault, number][] = [
    ['drop (sequence gap)', { type: 'drop', count: 3 }, 10],
    ['duplicate frames', { type: 'duplicate', count: 5 }, 10],
    ['delay', { type: 'delay', ms: 400 }, 10],
    ['disconnect', { type: 'disconnect' }, 20],
    ['Reconnect hint', { type: 'reconnect', afterMs: 150, closeAfterMs: 2_000 }, 20],
    ['slow consumer', { type: 'slow', ms: 400, maxQueued: 5 }, 15],
    ['error RETRY', { type: 'error', code: 'RETRY' }, 5],
  ];

  for (const [name, fault, steps] of faults) {
    it(`recovers from ${name} and ends consistent`, async () => {
      const connectionsBefore = server.sessionIds();
      const resyncsBefore = server.stats().sessions[0]?.resyncs ?? 0;
      expect(server.fault(fault)).toBe(1);
      await run(steps);
      await settle();
      expect(inconsistencies()).toEqual([]);
      const after = server.stats().sessions[0];
      const reconnected = fault.type === 'disconnect' || fault.type === 'reconnect';
      // A dropped frame was detected and repaired with a fresh snapshot.
      expect(fault.type !== 'drop' || (after?.resyncs ?? 0) > resyncsBefore).toBe(true);
      // After a reconnect it is a new session with every subscription re-opened.
      expect(!reconnected || server.sessionIds().join() !== connectionsBefore.join()).toBe(true);
      expect(!reconnected || after?.subscriptions === 5).toBe(true);
    });
  }

  it('all faults at once, then consistent', async () => {
    server.fault({ type: 'drop', count: 2 });
    server.fault({ type: 'duplicate', count: 2 });
    server.fault({ type: 'delay', ms: 200 });
    await run(5);
    server.fault({ type: 'disconnect' });
    await run(10);
    await settle();
    server.fault({ type: 'slow', ms: 300, maxQueued: 3 });
    await run(10);
    await settle();
    expect(inconsistencies()).toEqual([]);
  });
});
