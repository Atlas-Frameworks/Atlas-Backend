import { SubscriptionKind, packIcons, packPositions } from '@atlas/protocol';
import { describe, expect, it } from 'vitest';
import type { MapAdapter, MapFrame } from '../adapters/map-adapter.js';
import type { PageState } from '../pages/page-subscription.js';
import { FakeClock } from '../testing/fake-clock.js';
import { ScriptedServer } from '../testing/scripted-server.js';
import { createAtlasClient } from './client.js';

/** Lets microtask-delivered bridge messages and in-memory frames settle. */
async function pump(server: ScriptedServer, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    server.flush();
    await Promise.resolve();
    await new Promise<void>((r) => queueMicrotask(r));
  }
}

function setup() {
  const server = new ScriptedServer();
  const clock = new FakeClock();
  const client = createAtlasClient({
    services: { '*': 'ws://svc.test' },
    token: 't',
    worker: 'main-thread',
    trackVisibility: false,
    inject: { transport: server.factory, clock },
  });
  return { server, clock, client };
}

const positions = (...xs: number[]) => packPositions(new Float64Array(xs));

describe('createAtlasClient (C-04, main-thread mode)', () => {
  it('streams map frames to listeners and gets the buffers back', async () => {
    const { server, clock, client } = setup();
    const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
    const layer = view.subscribeMap('planes');
    const frames: { count: number; ids: string[]; lon: number }[] = [];
    client.onFrame((f) =>
      frames.push({ count: f.count, ids: [...f.ids], lon: f.positions[0] ?? NaN }),
    );
    await pump(server);
    expect(server.cases()).toEqual(['auth', 'openView', 'subscribeMap']);
    server.mapSnapshot('m', 1, view.id, {
      upsertIds: ['a', 'b'],
      positions: positions(1, 2, 3, 4, 5, 6),
      icons: packIcons(new Uint16Array([0, 1])),
    });
    await pump(server);
    clock.advance(100);
    await pump(server);
    expect(frames.at(-1)).toEqual({ count: 2, ids: ['a', 'b'], lon: 1 });

    // Many more frames than buffer sets: only works if the buffers come back.
    for (let i = 2; i < 30; i++) {
      server.mapDelta('m', i, { upsertIds: ['a'], positions: positions(i, 0, 0) });
      await pump(server);
      clock.advance(100);
      await pump(server);
    }
    expect(frames.length).toBeGreaterThan(25);
    expect(frames.at(-1)?.lon).toBe(29);
    layer.close();
    await pump(server);
    expect(server.cases().at(-1)).toBe('unsubscribeMap');
  });

  it('attachMap feeds an adapter', async () => {
    const { server, clock, client } = setup();
    const applied: MapFrame[] = [];
    const adapter: MapAdapter = {
      createLayer: () => {},
      applyFrame: (f) => applied.push({ ...f, ids: [...f.ids] }),
      pick: () => null,
      destroy: () => {},
    };
    client.attachMap(adapter);
    const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
    view.subscribeMap();
    await pump(server);
    server.mapSnapshot('m', 1, view.id, {
      upsertIds: ['x'],
      positions: positions(7, 8, 9),
      labels: ['X1'],
    });
    await pump(server);
    client.setSelected('x');
    await pump(server);
    clock.advance(200);
    await pump(server);
    expect(applied.at(-1)?.ids).toEqual(['x']);
    expect(applied.at(-1)?.labels.get(0)).toBe('X1');
  });

  it('batches page updates to at most 4 per second', async () => {
    const { server, clock, client } = setup();
    const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
    const page = view.subscribePage({ pageSize: 2 });
    const seen: PageState[] = [];
    page.subscribe((s) => {
      if (s) seen.push(s);
    });
    await pump(server);
    const windowRef = server.ofCase('setWindow')[0]?.windowRef ?? '';
    server.send({
      subId: 'p',
      seq: 1,
      body: {
        case: 'snapshot',
        value: {
          kind: SubscriptionKind.PAGE,
          viewRef: view.id,
          windowRef,
          state: {
            case: 'page',
            value: {
              orderedIds: ['a'],
              rows: [{ id: 'a', version: 1n, fields: { n: 0 } }],
              total: 1,
              pageCount: 1,
            },
          },
        },
      },
    });
    await pump(server);
    // 40 updates over 1 s (one every 25 ms).
    for (let i = 2; i <= 41; i++) {
      server.send({
        subId: 'p',
        seq: i,
        body: {
          case: 'pageWindow',
          value: {
            orderedIds: ['a'],
            rows: [{ id: 'a', version: BigInt(i), fields: { n: i } }],
            total: 1,
            pageCount: 1,
          },
        },
      });
      await pump(server);
      clock.advance(25);
      await pump(server);
    }
    clock.advance(500);
    await pump(server);
    expect(seen.length).toBeLessThanOrEqual(6); // 1 s at 4/s, plus the edges
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(page.getSnapshot()?.rows[0]?.fields).toEqual({ n: 41 }); // never loses the latest
  });

  it('page controls, locate and detail go through the bridge', async () => {
    const { server, clock, client } = setup();
    const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
    const page = view.subscribePage({ pageSize: 10 });
    page.setFreezeOrder(true);
    page.setPage(3);
    const detail = client.openDetail('airplanes', 'z');
    await pump(server);
    // Requested before the socket opened: only the latest window is sent.
    expect(server.ofCase('setWindow').map((w) => w.page)).toEqual([3]);
    const located = page.locate('z', { jump: true });
    await pump(server);
    expect(server.ofCase('openDetail')[0]).toMatchObject({ entityType: 'airplanes', id: 'z' });
    server.send({
      body: { case: 'locateResult', value: { viewRef: view.id, id: 'z', found: true, page: 5 } },
    });
    await pump(server);
    await expect(located).resolves.toEqual({ found: true, groupPath: [], page: 5 });
    server.send({
      subId: 'd',
      seq: 1,
      body: {
        case: 'snapshot',
        value: {
          kind: SubscriptionKind.DETAIL,
          state: {
            case: 'detail',
            value: {
              entityType: 'airplanes',
              id: 'z',
              state: { case: 'row', value: { id: 'z', version: 4n, fields: { callsign: 'LY1' } } },
            },
          },
        },
      },
    });
    await pump(server);
    clock.advance(300);
    await pump(server);
    expect(detail.getSnapshot()).toMatchObject({
      row: { version: 4, fields: { callsign: 'LY1' } },
      removed: false,
    });
    detail.close();
    page.close();
    view.close();
    await pump(server);
    expect(server.cases().slice(-3)).toEqual(['closeDetail', 'setWindow', 'closeView']);
  });

  it('reports status and view errors', async () => {
    const { server, clock, client } = setup();
    const statuses: string[] = [];
    client.status.subscribe((s) => statuses.push(s.connection));
    const view = client.openView({
      entityType: 'airplanes',
      filter: { field: 'x', op: 'eq', value: 1 },
      scope: { countries: [] },
    });
    await pump(server);
    server.send({
      body: { case: 'error', value: { code: 1, message: 'unknown field x', viewRef: view.id } },
    });
    await pump(server);
    clock.advance(300);
    await pump(server);
    expect(view.error.getSnapshot()).toMatchObject({
      code: 'INVALID_FILTER',
      message: 'unknown field x',
    });
    expect(client.status.getSnapshot().connection).toBe('open');
    server.conn.close(1006);
    await pump(server);
    clock.advance(300);
    await pump(server);
    expect(client.status.getSnapshot().connection).toBe('reconnecting');
  });

  it('hidden: no frames or page updates until visible', async () => {
    const { server, clock, client } = setup();
    const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
    view.subscribeMap();
    let frames = 0;
    client.onFrame(() => frames++);
    await pump(server);
    server.mapSnapshot('m', 1, view.id, { upsertIds: ['a'], positions: positions(1, 1, 1) });
    await pump(server);
    clock.advance(200);
    await pump(server);
    const before = frames;
    client.setHidden(true);
    await pump(server);
    for (let i = 2; i < 10; i++)
      server.mapDelta('m', i, { upsertIds: ['a'], positions: positions(i, 1, 1) });
    await pump(server);
    clock.advance(2_000);
    await pump(server);
    expect(frames).toBe(before);
    expect(client.status.getSnapshot().hidden).toBe(true);
    client.setHidden(false);
    await pump(server);
    clock.advance(200);
    await pump(server);
    expect(frames).toBe(before + 1);
    expect(server.ofCase('resync')).toHaveLength(1);
  });
});
