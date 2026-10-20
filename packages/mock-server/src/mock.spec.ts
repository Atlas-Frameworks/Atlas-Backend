import {
  ErrorCode,
  SubscriptionKind,
  decodeServer,
  encodeClient,
  unpackPositions,
} from '@atlas/protocol';
import type { ClientMessageInit, ServerMessage } from '@atlas/protocol';
import { describe, expect, it } from 'vitest';
import { FilterError, TYPES, parseFilter, registryMetadata } from './registry.js';
import { MockServer, signJwt } from './server.js';
import { World } from './world.js';

const planes = TYPES['airplanes']!;

/** An in-process client: records decoded frames from the server. */
function client(server: MockServer) {
  const frames: ServerMessage[] = [];
  let closed = false;
  const a = server.attach({
    send: (d) => frames.push(decodeServer(d)),
    close: () => {
      closed = true;
    },
  });
  const send = (m: ClientMessageInit) => a.onMessage(encodeClient(m));
  send({
    body: { case: 'auth', value: { token: signJwt({ userId: 'u1' }, 'k'), protocolVersion: 1 } },
  });
  return { frames, send, session: a.session, isClosed: () => closed };
}

describe('World', () => {
  it('is deterministic for a seed', () => {
    const a = new World({ seed: 7, airplanes: 200 });
    const b = new World({ seed: 7, airplanes: 200 });
    a.step(100, 50);
    b.step(100, 50);
    expect([...a.airplanes.values()]).toEqual([...b.airplanes.values()]);
    expect(new World({ seed: 8, airplanes: 200 }).airplanes.size).toBe(200);
  });

  it('moves the requested number of airplanes per step', () => {
    const w = new World({ airplanes: 1_000 });
    const changes = w.step(100, 600);
    expect(changes.moved.size).toBeGreaterThanOrEqual(600);
    expect(changes.upserted.get('airplanes')?.size).toBeGreaterThanOrEqual(600);
  });
});

describe('filters (contracts §5)', () => {
  it('validates fields, operators and limits', () => {
    expect(parseFilter(planes, '')).toBeNull();
    expect(parseFilter(planes, '{"field":"airline","op":"eq","value":"LY"}')).toEqual({
      field: 'airline',
      op: 'eq',
      value: 'LY',
    });
    const bad = [
      '{"field":"nope","op":"eq","value":1}',
      '{"field":"airline","op":"gt","value":1}',
      '{"field":"callsign","op":"contains","value":"LY"}',
      '{"and":[]}',
      `{"field":"airline","op":"in","value":${JSON.stringify(Array.from({ length: 201 }, (_, i) => `A${i}`))}}`,
      '{"and":[{"and":[{"and":[{"and":[{"field":"airline","op":"eq","value":"LY"}]}]}]}]}',
      'not json',
    ];
    const accepted = bad.filter((text) => {
      try {
        parseFilter(planes, text);
        return true;
      } catch (e) {
        return !(e instanceof FilterError);
      }
    });
    expect(accepted).toEqual([]);
  });

  it('serves registry metadata', () => {
    const meta = registryMetadata();
    const fields = meta.types.find((t) => t.type === 'airplanes')?.fields ?? [];
    expect(fields.find((f) => f.name === 'airline')).toMatchObject({
      groupable: true,
      sortable: true,
    });
  });
});

describe('MockSession', () => {
  it('serves map snapshots and deltas with consecutive seqs', () => {
    const server = new MockServer({ airplanes: 500, paused: true });
    const c = client(server);
    c.send({
      body: {
        case: 'openView',
        value: {
          viewRef: 'v',
          entityType: 'airplanes',
          filter: '',
          scope: { case: 'countries', value: { countryIds: [] } },
        },
      },
    });
    c.send({ body: { case: 'subscribeMap', value: { viewRef: 'v' } } });
    const snap = c.frames[0];
    expect(snap?.body.case).toBe('snapshot');
    if (snap?.body.case !== 'snapshot' || snap.body.value.state.case !== 'map')
      throw new Error('no map snapshot');
    expect(snap.body.value.kind).toBe(SubscriptionKind.MAP);
    expect(snap.body.value.viewRef).toBe('v');
    const map = snap.body.value.state.value;
    expect(map.upsertIds).toHaveLength(500);
    const pos = unpackPositions(map.positions);
    const first = server.world.airplanes.get(map.upsertIds[0]!);
    expect([pos[0], pos[1]]).toEqual([first?.lon, first?.lat]);

    for (let i = 0; i < 5; i++) server.step(100, 50);
    const deltas = c.frames.filter((f) => f.body.case === 'mapDelta');
    expect(deltas.map((f) => f.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(deltas.every((f) => f.subId === snap.subId)).toBe(true);
  });

  it('serves live pages sorted with group counts, and locate', () => {
    const server = new MockServer({ airplanes: 300, paused: true });
    const c = client(server);
    c.send({
      body: {
        case: 'openView',
        value: {
          viewRef: 'v',
          entityType: 'airplanes',
          filter: '',
          scope: { case: 'countries', value: { countryIds: [] } },
        },
      },
    });
    c.send({
      body: {
        case: 'setLayout',
        value: { viewRef: 'v', groupBy: ['airline'], sort: { field: 'callsign' } },
      },
    });
    c.send({
      body: {
        case: 'setWindow',
        value: { viewRef: 'v', windowRef: 'main', groupPath: ['LY'], page: 0, pageSize: 10 },
      },
    });
    const snap = c.frames.at(-1);
    if (snap?.body.case !== 'snapshot' || snap.body.value.state.case !== 'page')
      throw new Error('no page snapshot');
    const page = snap.body.value.state.value;
    const ly = [...server.world.airplanes.values()]
      .filter((p) => p.airline === 'LY')
      .map((p) => p.callsign)
      .toSorted();
    expect(page.rows.map((r) => r.fields?.['callsign'])).toEqual(ly.slice(0, 10));
    expect(page.total).toBe(ly.length);
    expect(page.groupCounts.find((g) => g.groupPath[0] === 'LY')?.count).toBe(ly.length);
    const target = [...server.world.airplanes.values()].find((p) => p.callsign === ly[15]);
    c.send({
      body: { case: 'locate', value: { viewRef: 'v', id: target?.id ?? '', pageSize: 10 } },
    });
    const loc = c.frames.at(-1);
    expect(loc?.body.case).toBe('locateResult');
    expect(loc?.body.value).toMatchObject({ found: true, groupPath: ['LY'], page: 1 });
  });

  it('rejects an invalid filter with INVALID_FILTER on the view', () => {
    const server = new MockServer({ airplanes: 10, paused: true });
    const c = client(server);
    c.send({
      body: {
        case: 'openView',
        value: {
          viewRef: 'bad',
          entityType: 'airplanes',
          filter: '{"field":"x","op":"eq","value":1}',
          scope: { case: 'countries', value: { countryIds: [] } },
        },
      },
    });
    const err = c.frames.at(-1);
    expect(err?.body.case).toBe('error');
    expect(err?.body.value).toMatchObject({ code: ErrorCode.INVALID_FILTER, viewRef: 'bad' });
  });

  it('sends detail updates for crew changes and removal', () => {
    const server = new MockServer({ airplanes: 10, paused: true });
    const c = client(server);
    const plane = [...server.world.airplanes.values()][0]!;
    c.send({ body: { case: 'openDetail', value: { entityType: 'airplanes', id: plane.id } } });
    server.world.changeCrew(plane);
    server.step(0, 0); // nothing moved...
    const upserted = new Map([['airplanes' as const, new Set([plane.id])]]);
    c.session.onStep({ upserted, deleted: new Map(), moved: new Set() });
    const upd = c.frames.at(-1);
    if (upd?.body.case !== 'detailUpdate' || upd.body.value.state.case !== 'row')
      throw new Error('no detail row');
    expect(upd.body.value.state.value.fields?.['crew']).toEqual(plane.crew);
    server.world.deleteAirplane(plane.id);
    c.session.onStep({
      upserted: new Map(),
      deleted: new Map([['airplanes', new Set([plane.id])]]),
      moved: new Set(),
    });
    expect(c.frames.at(-1)?.body.value).toMatchObject({ state: { case: 'removed', value: true } });
  });

  it('drop and duplicate faults create a gap and a repeat', () => {
    const server = new MockServer({ airplanes: 100, paused: true });
    const c = client(server);
    c.send({
      body: {
        case: 'openView',
        value: {
          viewRef: 'v',
          entityType: 'airplanes',
          filter: '',
          scope: { case: 'countries', value: { countryIds: [] } },
        },
      },
    });
    c.send({ body: { case: 'subscribeMap', value: { viewRef: 'v' } } });
    server.step(100, 10);
    server.fault({ type: 'drop' });
    server.step(100, 10);
    server.fault({ type: 'duplicate' });
    server.step(100, 10);
    expect(c.frames.map((f) => f.seq)).toEqual([1, 2, 4, 4]);
  });

  it('slow consumer past the cap drops queued deltas and re-snapshots', () => {
    let now = 1_000;
    const server = new MockServer({ airplanes: 100, paused: true, clock: () => now });
    const c = client(server);
    c.send({
      body: {
        case: 'openView',
        value: {
          viewRef: 'v',
          entityType: 'airplanes',
          filter: '',
          scope: { case: 'countries', value: { countryIds: [] } },
        },
      },
    });
    c.send({ body: { case: 'subscribeMap', value: { viewRef: 'v' } } });
    server.fault({ type: 'slow', ms: 500, maxQueued: 3 });
    for (let i = 0; i < 6; i++) server.step(100, 10);
    expect(c.frames).toHaveLength(1);
    now += 600;
    server.step(100, 10);
    const after = c.frames.slice(1);
    expect(after.some((f) => f.body.case === 'snapshot')).toBe(true);
    expect(c.session.stats.framesDropped).toBeGreaterThan(0);
  });
});
