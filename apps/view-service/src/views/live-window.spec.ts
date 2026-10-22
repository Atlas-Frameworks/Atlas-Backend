import type { ChangeFeed } from '../changes/change-feed.js';
import { DependencyIndex } from './dependency-index.js';
import type { WindowData } from './live-window.js';
import { applyDeletes, emptyDiff, hold, type Row } from './view-diff.js';
import type { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { View, ViewEvent, ViewListener } from './view.js';

/**
 * A view of orders sorted by price, and a fake Postgres holding the current
 * rows (`db`). Windows are opened through ViewService, as the SSE route does.
 */
function setup() {
  const db = new Map<string, Row>();
  const loader = {
    fetchByIds: vi.fn((_view: View, ids: string[]) =>
      Promise.resolve(ids.flatMap((id) => db.get(id) ?? []).reverse()),
    ),
  };
  const registry = new ViewRegistry();
  const service = new ViewService(
    registry,
    loader as unknown as ViewLoader,
    new DependencyIndex(),
    {} as ChangeFeed,
  );
  vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  const view = registry.open(
    'key',
    'orders',
    { text: 'SELECT', values: [] },
    { price: 'number' },
    { column: 'price', dir: 'asc' },
  );
  view.loaded = true;

  /** Writes a row to the fake Postgres and the view; returns it as the tick would. */
  const put = (id: string, price: number, version = 1): Row => {
    const row = { id, version, price };
    db.set(id, row);
    hold(view, row);
    return row;
  };
  const remove = (id: string) => {
    db.delete(id);
    applyDeletes(view, [id], emptyDiff());
  };

  /** Opens a window and collects its events. */
  const open = (offset: number, limit: number) => {
    const events: ViewEvent[] = [];
    const listener: ViewListener = { send: (e) => events.push(e) };
    const { window, first } = service.openWindow(
      view,
      { offset, limit },
      listener,
    );
    return { window, first, events, listener };
  };
  const changed = (...rows: Row[]) => new Set(rows.map((r) => r.id));

  return { db, loader, service, view, put, remove, open, changed };
}

const dataOf = (event: ViewEvent) => event.data as WindowData;
const rowIds = (event: ViewEvent) =>
  (dataOf(event).rows as Row[]).map((r) => r.id);

describe('live windows', () => {
  /** a 10, b 20, c 30, d 40, e 50 */
  function five() {
    const s = setup();
    for (const [id, price] of [
      ['a', 10],
      ['b', 20],
      ['c', 30],
      ['d', 40],
      ['e', 50],
    ] as const) {
      s.put(id, price);
    }
    return s;
  }

  it('starts with the range and its rows from memory, at seq 0', async () => {
    const { open, loader } = five();

    const first = open(1, 2).first;

    expect(first).toEqual({
      type: 'window',
      seq: 0,
      data: {
        sort: 'price:asc',
        offset: 1,
        total: 5,
        ids: ['b', 'c'],
        rows: [
          { id: 'b', version: 1, price: 20 },
          { id: 'c', version: 1, price: 30 },
        ],
      },
    });
    expect(loader.fetchByIds).not.toHaveBeenCalled();
  });

  it('sends nothing when neither the range, its rows nor the total changed', async () => {
    const { service, view, put, open, changed, loader } = five();
    const { events } = open(1, 2);
    loader.fetchByIds.mockClear();

    // e moves within the part after the range.
    await service.publishWindows(view, changed(put('e', 60, 2)));

    expect(events).toEqual([]);
    expect(loader.fetchByIds).not.toHaveBeenCalled();
  });

  it('sends a changed row in the range from the tick, with no query', async () => {
    const { service, view, put, open, changed, loader } = five();
    const { events } = open(1, 2);
    loader.fetchByIds.mockClear();

    const c = put('c', 31, 2);
    await service.publishWindows(view, changed(c));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      data: { ids: ['b', 'c'], rows: [c] },
    });
    expect(loader.fetchByIds).not.toHaveBeenCalled();
  });

  it('sends the rows that slid into the range, from memory', async () => {
    const { service, view, put, open, changed, loader } = five();
    const first = open(1, 2);
    const second = open(2, 2);
    loader.fetchByIds.mockClear();

    // A new cheapest order pushes every row one place down.
    const z = put('z', 5);
    await service.publishWindows(view, changed(z));

    expect(dataOf(first.events[0])).toMatchObject({
      ids: ['a', 'b'],
      total: 6,
    });
    expect(rowIds(first.events[0])).toEqual(['a']);
    expect(dataOf(second.events[0]).ids).toEqual(['b', 'c']);
    expect(rowIds(second.events[0])).toEqual(['b']);
    expect(loader.fetchByIds).not.toHaveBeenCalled();
  });

  it('sends the new total even when the range is the same', async () => {
    const { service, view, put, open, changed } = five();
    const { events } = open(0, 2);

    await service.publishWindows(view, changed(put('y', 99)));

    expect(events[0]).toMatchObject({
      data: { ids: ['a', 'b'], total: 6, rows: [] },
    });
  });

  it('sends the ids without a row that left the range', async () => {
    const { service, view, remove, open, changed } = five();
    const { events } = open(0, 2);

    remove('a');
    await service.publishWindows(view, changed());

    expect(events[0]).toMatchObject({
      data: { ids: ['b', 'c'], total: 4 },
    });
    expect(rowIds(events[0])).toEqual(['c']);
  });

  it('shares one window per range; a later client starts at its current seq', async () => {
    const { service, view, put, open, changed } = five();
    const early = open(0, 2);
    await service.publishWindows(view, changed(put('a', 11, 2)));

    const late = open(0, 2);

    expect(late.window).toBe(early.window);
    expect(view.windows.size).toBe(1);
    expect(await late.first).toMatchObject({
      seq: 1,
      data: { ids: ['a', 'b'] },
    });
  });

  it('removes a window when its last client leaves, then counts the view as unused', () => {
    const { service, view, open } = five();
    const one = open(0, 2);
    const two = open(0, 2);
    expect(view.inUse()).toBe(true);

    service.closeWindow(view, one.window, one.listener);
    expect(view.windows.size).toBe(1);
    service.closeWindow(view, two.window, two.listener);

    expect(view.windows.size).toBe(0);
    expect(view.inUse()).toBe(false);
    expect(view.closesAt).toBeDefined();
    clearTimeout(view.closeTimer);
  });

  it('keeps a client that applies every event equal to the live range, through random changes', async () => {
    const { db, service, view, put, remove, open, changed } = setup();
    let seed = 11;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 30; i++) {
      put(`id-${i}`, random(15));
    }
    /** What a client shows for each range: ids in order, and every row it was sent. */
    const clients = await Promise.all(
      [
        [0, 10],
        [7, 10],
        [15, 10],
        [25, 10],
      ].map(async ([offset, limit]) => {
        const { first, events } = open(offset, limit);
        const shown = { ids: [] as string[], rows: new Map<string, Row>() };
        const apply = (event: ViewEvent) => {
          shown.ids = dataOf(event).ids;
          for (const row of dataOf(event).rows as Row[]) {
            shown.rows.set(row.id, row);
          }
        };
        apply(await first);
        return { offset, limit, events, shown, apply, seen: 0 };
      }),
    );

    for (let tick = 0; tick < 200; tick++) {
      const rows: Row[] = [];
      for (let n = random(4); n > 0; n--) {
        const id = `id-${random(40)}`;
        if (random(5) === 0) {
          remove(id);
        } else {
          rows.push(put(id, random(15), (db.get(id)?.version ?? 0) + 1));
        }
      }
      await service.publishWindows(view, changed(...rows));
      for (const client of clients) {
        for (const event of client.events.slice(client.seen)) {
          client.apply(event);
        }
        client.seen = client.events.length;
        const expected = view
          .sorted(view.defaultSort)
          .ids.slice(client.offset, client.offset + client.limit);
        expect(client.shown.ids).toEqual(expected);
        for (const id of expected) {
          expect(client.shown.rows.get(id)).toEqual(db.get(id));
        }
      }
    }
  });
});
