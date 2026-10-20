import { ErrorCode, SubscriptionKind } from '@atlas/protocol';
import type { ServerMessage, Snapshot } from '@atlas/protocol';
import { describe, expect, it } from 'vitest';
import { FakeClock, scriptedRandom, seededRandom } from '../testing/fake-clock.js';
import { ScriptedServer } from '../testing/scripted-server.js';
import { AtlasCore } from './atlas-core.js';
import { backoffDelay } from './backoff.js';
import type { SubscriptionHandler } from './subscription.js';

const URL_A = 'ws://tracks.test/ws';
const URL_B = 'ws://places.test/ws';

class Recorder implements SubscriptionHandler {
  snapshots: { seq: number; snap: Snapshot }[] = [];
  deltas: number[] = [];
  states: string[] = [];
  applySnapshot(snap: Snapshot, msg: ServerMessage): void {
    this.snapshots.push({ seq: msg.seq, snap });
  }
  applyDelta(msg: ServerMessage): void {
    this.deltas.push(msg.seq);
  }
  onStateChange(state: string): void {
    this.states.push(state);
  }
}

function setup(random = seededRandom(7)) {
  const server = new ScriptedServer();
  const clock = new FakeClock();
  const core = new AtlasCore({
    services: { airplanes: URL_A, airports: URL_B },
    token: 'dev-token',
    transport: server.factory,
    clock,
    random,
  });
  return { server, clock, core };
}

function openMapView(core: AtlasCore, server: ScriptedServer) {
  const view = core.openView({ entityType: 'airplanes', scope: { countries: ['IL'] } });
  const rec = new Recorder();
  const sub = view.subscribeMap(rec);
  server.flush();
  return { view, rec, sub };
}

describe('AtlasCore (C-01)', () => {
  it('connects, authenticates, then opens the view and subscribes', () => {
    const { server, core } = setup();
    openMapView(core, server);
    expect(server.cases()).toEqual(['auth', 'openView', 'subscribeMap']);
    const [auth] = server.ofCase('auth');
    expect(auth?.token).toBe('dev-token');
    expect(auth?.protocolVersion).toBe(1);
    const [open] = server.ofCase('openView');
    expect(open?.scope).toEqual({
      case: 'countries',
      value: expect.objectContaining({ countryIds: ['IL'] }),
    });
  });

  it('applies frames in sequence and sends Resync on a gap', () => {
    const { server, core } = setup();
    const { view, rec, sub } = openMapView(core, server);
    server.mapSnapshot('m1', 10, view.viewRef);
    server.mapDelta('m1', 11);
    server.mapDelta('m1', 12);
    server.mapDelta('m1', 14); // 13 lost
    server.mapDelta('m1', 15);
    server.flush();

    expect(rec.snapshots.map((s) => s.seq)).toEqual([10]);
    expect(rec.deltas).toEqual([11, 12]);
    expect(sub.state).toBe('resyncing');
    expect(sub.staleSince).not.toBeNull();
    expect(server.ofCase('resync')).toEqual([expect.objectContaining({ subId: 'm1' })]);
    expect(core.getStatus().staleSince).toBe(sub.staleSince);

    // The fresh snapshot ends the stale period; later deltas apply again.
    server.mapSnapshot('m1', 20, view.viewRef);
    server.mapDelta('m1', 21);
    server.flush();
    expect(rec.snapshots.map((s) => s.seq)).toEqual([10, 20]);
    expect(rec.deltas).toEqual([11, 12, 21]);
    expect(sub.state).toBe('live');
    expect(core.getStatus().staleSince).toBeNull();
  });

  it('ignores duplicate frames', () => {
    const { server, core } = setup();
    const { view, rec, sub } = openMapView(core, server);
    server.mapSnapshot('m1', 1, view.viewRef);
    server.mapDelta('m1', 2);
    server.mapDelta('m1', 2);
    server.mapDelta('m1', 1);
    server.mapDelta('m1', 3);
    server.flush();
    expect(rec.deltas).toEqual([2, 3]);
    expect(sub.state).toBe('live');
    expect(server.ofCase('resync')).toHaveLength(0);
  });

  it('re-sends Resync if no snapshot arrives', () => {
    const { server, core, clock } = setup();
    const { view } = openMapView(core, server);
    server.mapSnapshot('m1', 1, view.viewRef);
    server.mapDelta('m1', 3);
    server.flush();
    expect(server.ofCase('resync')).toHaveLength(1);
    clock.advance(10_000);
    server.flush();
    expect(server.ofCase('resync')).toHaveLength(2);
  });

  it('listen first: buffers deltas that arrive before the snapshot and drops covered ones', () => {
    const { server, core } = setup();
    const { view, rec, sub } = openMapView(core, server);
    // The server starts publishing before the snapshot reaches the client.
    server.mapDelta('m1', 4);
    server.mapDelta('m1', 5);
    server.mapDelta('m1', 6);
    server.flush();
    expect(rec.deltas).toEqual([]);
    expect(sub.state).toBe('snapshot-wait');

    // The snapshot already covers seq 4 and 5.
    server.mapSnapshot('m1', 5, view.viewRef);
    server.mapDelta('m1', 7);
    server.flush();
    expect(rec.snapshots.map((s) => s.seq)).toEqual([5]);
    expect(rec.deltas).toEqual([6, 7]);
    expect(sub.state).toBe('live');
    expect(server.ofCase('resync')).toHaveLength(0);
  });

  it('a gap inside the early buffer triggers Resync after the snapshot', () => {
    const { server, core } = setup();
    const { view, rec, sub } = openMapView(core, server);
    server.mapDelta('m1', 6);
    server.mapDelta('m1', 8);
    server.mapSnapshot('m1', 5, view.viewRef);
    server.flush();
    expect(rec.deltas).toEqual([6]);
    expect(sub.state).toBe('resyncing');
  });

  it('reconnect re-opens every view, layout, window, map and detail subscription', () => {
    const { server, core, clock } = setup(scriptedRandom(0.5));
    const v1 = core.openView({ entityType: 'airplanes', scope: { countries: ['IL', 'GR'] } });
    v1.setLayout({ groupBy: ['airline'], sort: { field: 'callsign', dir: 'desc' } });
    const map = new Recorder();
    const page = new Recorder();
    const det = new Recorder();
    v1.subscribeMap(map);
    v1.setWindow('main', { groupPath: [], page: 2, pageSize: 50 }, page);
    const v2 = core.openView({ entityType: 'airplanes', scope: { connectionId: 'c-1' } });
    const detail = core.openDetail('airplanes', 'p-1', det);
    server.flush();
    const first = server.conn;
    expect(server.cases(first)).toEqual([
      'auth',
      'openView',
      'setLayout',
      'subscribeMap',
      'setWindow',
      'openView',
      'openDetail',
    ]);
    server.mapSnapshot('m1', 3, v1.viewRef);
    server.flush();
    expect(core.getStatus().connection).toBe('open');

    first.close(1006, 'gone');
    server.flush();
    const status = core.getStatus();
    expect(status.connection).toBe('reconnecting');
    expect(status.lastError?.code).toBe('TRANSPORT');
    expect(detail.subscription.state).toBe('stale');
    expect(map.states.at(-1)).toBe('stale');

    // attempt 0: delay = 0.5 * 1 s
    expect(clock.pending()[0]?.inMs).toBe(500);
    clock.advance(500);
    server.flush();
    const second = server.conn;
    expect(second).not.toBe(first);
    expect(server.cases(second)).toEqual([
      'auth',
      'openView',
      'setLayout',
      'subscribeMap',
      'setWindow',
      'openView',
      'openDetail',
    ]);
    const [setWindow] = server.ofCase('setWindow', second);
    expect(setWindow).toMatchObject({
      viewRef: v1.viewRef,
      windowRef: 'main',
      page: 2,
      pageSize: 50,
    });
    const opens = server.ofCase('openView', second).map((o) => o.viewRef);
    expect(opens).toEqual([v1.viewRef, v2.viewRef]);

    // Still stale until the fresh snapshot arrives.
    expect(core.getStatus().staleSince).not.toBeNull();
    server.mapSnapshot('m9', 1, v1.viewRef, {});
    server.send({
      subId: 'p9',
      seq: 1,
      body: {
        case: 'snapshot',
        value: {
          kind: SubscriptionKind.PAGE,
          viewRef: v1.viewRef,
          windowRef: 'main',
          state: { case: 'page', value: {} },
        },
      },
    });
    server.send({
      subId: 'd9',
      seq: 1,
      body: {
        case: 'snapshot',
        value: {
          kind: SubscriptionKind.DETAIL,
          state: {
            case: 'detail',
            value: { entityType: 'airplanes', id: 'p-1', state: { case: 'removed', value: true } },
          },
        },
      },
    });
    server.flush();
    expect(core.getStatus().staleSince).toBeNull();
    expect(map.snapshots.map((s) => s.seq)).toEqual([3, 1]);
    expect(page.snapshots).toHaveLength(1);
    expect(det.snapshots).toHaveLength(1);
  });

  it('backoff doubles from 1 s and caps at 30 s with full jitter', () => {
    const { server, core, clock } = setup(scriptedRandom(0.999));
    openMapView(core, server);
    server.flush();
    server.conn.close(1006);
    server.flush();
    const delays: number[] = [];
    // Every connect attempt fails before opening.
    server.net.onConnect((end) => end.close(1006, 'refused'));
    for (let i = 0; i < 8; i++) {
      const next = clock.pending()[0];
      if (!next) throw new Error('no retry scheduled');
      delays.push(next.inMs);
      clock.advance(next.inMs);
      server.flush();
    }
    expect(delays).toEqual([999, 1998, 3996, 7992, 15984, 29970, 29970, 29970]);

    expect(backoffDelay(0, () => 0)).toBe(0);
    const r = seededRandom(3);
    const samples = Array.from({ length: 200 }, () => backoffDelay(12, r));
    expect(Math.max(...samples)).toBeLessThan(30_000);
    expect(new Set(samples).size).toBeGreaterThan(150); // jittered, not a constant
  });

  it('a stable connection resets the backoff', () => {
    const { server, core, clock } = setup(scriptedRandom(0.999));
    openMapView(core, server);
    server.net.onConnect((end) => end.close(1006));
    server.conn.close(1006);
    server.flush();
    clock.advance(999);
    server.flush(); // attempt 1 refused
    expect(clock.pending()[0]?.inMs).toBe(1998);
    server.net.onConnect(() => {});
    clock.advance(1998);
    server.flush();
    clock.advance(6_000); // stays open past stableAfterMs
    server.conn.close(1006);
    server.flush();
    expect(clock.pending()[0]?.inMs).toBe(999);
  });

  it("respects the server's Reconnect hint", () => {
    const { server, core, clock } = setup(scriptedRandom(0.999));
    const { view } = openMapView(core, server);
    server.mapSnapshot('m1', 1, view.viewRef);
    const first = server.conn;
    server.send({ body: { case: 'reconnect', value: { afterMs: 7_250 } } });
    server.flush();
    // Nothing happens before the hint delay; the client keeps using the connection.
    clock.advance(7_249);
    server.flush();
    expect(server.net.connections).toHaveLength(1);
    expect(first.isOpen).toBe(true);
    clock.advance(1);
    server.flush();
    clock.advance(0);
    server.flush();
    // It moved by itself, right at the hint, without a backoff delay.
    expect(first.isOpen).toBe(false);
    expect(server.net.connections).toHaveLength(2);
    expect(server.cases()).toEqual(['auth', 'openView', 'subscribeMap']);
    expect(core.getStatus().lastError).toBeNull();
  });

  it('when the server closes first after a hint, reconnects at the hinted time', () => {
    const { server, core, clock } = setup(scriptedRandom(0.999));
    openMapView(core, server);
    server.send({ body: { case: 'reconnect', value: { afterMs: 12_000 } } });
    server.flush();
    clock.advance(2_000);
    server.conn.close(1001, 'shutting down');
    server.flush();
    expect(clock.pending()[0]?.inMs).toBe(10_000);
    clock.advance(10_000);
    server.flush();
    expect(server.net.connections).toHaveLength(2);
  });

  it('hidden tab: on visible, re-snapshots every live subscription and keeps old data stale', () => {
    const { server, core, clock } = setup();
    const { view, rec, sub } = openMapView(core, server);
    const hiddenEvents: boolean[] = [];
    core.onHiddenChange((h) => hiddenEvents.push(h));
    server.mapSnapshot('m1', 1, view.viewRef);
    server.flush();
    core.setHidden(true);
    expect(core.getStatus().hidden).toBe(true);
    server.mapDelta('m1', 2);
    server.flush();
    clock.advance(60_000);
    core.setHidden(false);
    server.flush();
    expect(hiddenEvents).toEqual([true, false]);
    expect(server.ofCase('resync')).toEqual([expect.objectContaining({ subId: 'm1' })]);
    expect(sub.state).toBe('resyncing');
    expect(sub.staleSince).toBe(clock.now());
    expect(rec.snapshots).toHaveLength(1); // old data still there
    server.mapSnapshot('m1', 9, view.viewRef);
    server.flush();
    expect(sub.state).toBe('live');
    expect(sub.staleSince).toBeNull();
  });

  it('routes each entity type to its service URL', () => {
    const { server, core } = setup();
    core.openView({ entityType: 'airplanes', scope: { countries: ['IL'] } });
    core.openView({ entityType: 'airports', scope: { countries: ['IL'] } });
    core.openDetail('airports', 'ap-1', new Recorder());
    server.flush();
    expect(server.net.connections.map((c) => c.url)).toEqual([URL_A, URL_B]);
    expect(server.cases(server.net.connections[1])).toEqual(['auth', 'openView', 'openDetail']);
    expect(() => core.openView({ entityType: 'ships', scope: { countries: [] } })).toThrow(
      /no service/,
    );
  });

  it('reports view errors such as INVALID_FILTER', () => {
    const { server, core } = setup();
    const errors: string[] = [];
    const view = core.openView(
      {
        entityType: 'airplanes',
        filter: { field: 'nope', op: 'eq', value: 1 },
        scope: { countries: [] },
      },
      (e) => errors.push(`${e.code}:${e.message}`),
    );
    server.flush();
    expect(server.ofCase('openView')[0]?.filter).toBe('{"field":"nope","op":"eq","value":1}');
    server.send({
      body: {
        case: 'error',
        value: {
          code: ErrorCode.INVALID_FILTER,
          message: 'unknown field nope',
          viewRef: view.viewRef,
        },
      },
    });
    server.flush();
    expect(errors).toEqual(['INVALID_FILTER:unknown field nope']);
    expect(core.getStatus().lastError?.code).toBe('INVALID_FILTER');
  });

  it('locate resolves with the LocateResult', async () => {
    const { server, core } = setup();
    const { view } = openMapView(core, server);
    const p = view.locate('p-7', 50);
    server.flush();
    expect(server.ofCase('locate')[0]).toMatchObject({
      viewRef: view.viewRef,
      id: 'p-7',
      pageSize: 50,
    });
    server.send({
      body: {
        case: 'locateResult',
        value: { viewRef: view.viewRef, id: 'p-7', found: true, page: 4 },
      },
    });
    server.flush();
    await expect(p).resolves.toEqual({ found: true, groupPath: [], page: 4 });
  });

  it('a moved window ignores frames of its old sub_id', () => {
    const { server, core } = setup();
    const view = core.openView({ entityType: 'airplanes', scope: { countries: [] } });
    const rec = new Recorder();
    view.setWindow('main', { groupPath: [], page: 0, pageSize: 50 }, rec);
    server.flush();
    const pageSnap = (subId: string, seq: number) =>
      server.send({
        subId,
        seq,
        body: {
          case: 'snapshot',
          value: {
            kind: SubscriptionKind.PAGE,
            viewRef: view.viewRef,
            windowRef: 'main',
            state: { case: 'page', value: {} },
          },
        },
      });
    pageSnap('p0', 1);
    server.flush();
    view.setWindow('main', { groupPath: [], page: 1, pageSize: 50 }, rec);
    server.send({ subId: 'p0', seq: 2, body: { case: 'pageWindow', value: {} } });
    pageSnap('p1', 30);
    server.send({ subId: 'p1', seq: 31, body: { case: 'pageWindow', value: {} } });
    server.flush();
    expect(rec.snapshots.map((s) => s.seq)).toEqual([1, 30]);
    expect(rec.deltas).toEqual([31]);
  });
});
