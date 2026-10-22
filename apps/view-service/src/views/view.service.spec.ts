import type { ChangeFeed } from '../changes/change-feed.js';
import type { QueryDefinition } from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import { sql } from './sql.js';
import { hold } from './view-diff.js';
import type { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { CLOSE_AFTER_MS, ViewService } from './view.service.js';
import type { View, ViewEvent, ViewListener } from './view.js';

function setup() {
  const registry = new ViewRegistry();
  const loader = { fetchByIds: vi.fn() };
  const service = new ViewService(
    registry,
    loader as unknown as ViewLoader,
    new DependencyIndex(),
    {} as ChangeFeed,
  );
  const view = registry.open('key', 'orders', { text: 'SELECT', values: [] });
  hold(view, { id: 'a', version: 1 });
  hold(view, { id: 'b', version: 2 });
  return { service, view, loader };
}

describe('ViewService', () => {
  it('answers a page from memory: every row held at the current seq, by id by default', () => {
    const { service, view, loader } = setup();
    view.nextSeq();

    expect(service.page(view, {})).toEqual({
      viewKey: 'key',
      seq: 1,
      sort: 'id',
      offset: 0,
      total: 2,
      rows: [
        { id: 'a', version: 1 },
        { id: 'b', version: 2 },
      ],
    });
    expect(loader.fetchByIds).not.toHaveBeenCalled();
  });

  describe('pages', () => {
    /** A view of 5 orders sorted by price: e 10, d 20, c 30, b 40, a 50. */
    function sorted() {
      const registry = new ViewRegistry();
      const loader = { fetchByIds: vi.fn() };
      const service = new ViewService(
        registry,
        loader as unknown as ViewLoader,
        new DependencyIndex(),
        {} as ChangeFeed,
      );
      const view = registry.open(
        'key',
        'orders',
        { text: 'SELECT', values: [] },
        { price: 'number' },
        { column: 'price', dir: 'asc' },
      );
      for (const [id, price] of [
        ['a', 50],
        ['b', 40],
        ['c', 30],
        ['d', 20],
        ['e', 10],
      ] as const) {
        hold(view, { id, version: 1, price });
      }
      const ids = (page: { rows: { id: string }[] }) =>
        page.rows.map((r) => r.id);
      return { service, view, loader, ids };
    }

    it('cuts any range from the sort in memory, rows included: no query', () => {
      const { service, view, loader, ids } = sorted();

      const page = service.page(view, { offset: 1, limit: 3 });

      expect(page).toMatchObject({ sort: 'price:asc', offset: 1, total: 5 });
      expect(page.rows).toEqual([
        { id: 'd', version: 1, price: 20 },
        { id: 'c', version: 1, price: 30 },
        { id: 'b', version: 1, price: 40 },
      ]);
      expect(ids(service.page(view, { offset: 3, limit: 3 }))).toEqual([
        'b',
        'a',
      ]);
      expect(loader.fetchByIds).not.toHaveBeenCalled();
    });

    it('reads every row from offset on without a limit, in any sort', () => {
      const { service, view, ids } = sorted();

      const page = service.page(view, {
        sort: { column: 'price', dir: 'desc' },
        offset: 2,
      });

      expect(page).toMatchObject({ sort: 'price:desc', total: 5 });
      expect(ids(page)).toEqual(['c', 'd', 'e']);
    });

    it('returns no rows past the end', () => {
      const { service, view } = sorted();

      expect(service.page(view, { offset: 9, limit: 3 })).toMatchObject({
        offset: 9,
        total: 5,
        rows: [],
      });
    });

    it('restarts the close timer on a read of an open view', () => {
      const { service, view } = sorted();

      service.read(view, { limit: 1 });

      expect(view.closesAt).toBeDefined();
      clearTimeout(view.closeTimer);
    });
  });

  it('sends each published event to every listener with the next seq', () => {
    const { service, view } = setup();
    const first: ViewEvent[] = [];
    const second: ViewEvent[] = [];
    view.listeners.add({ send: (e) => first.push(e) });
    view.listeners.add({ send: (e) => second.push(e) });

    service.publish(view, 'test', { n: 1 });
    service.publish(view, 'test', { n: 2 });

    expect(first).toEqual([
      { type: 'test', seq: 1, data: { n: 1 } },
      { type: 'test', seq: 2, data: { n: 2 } },
    ]);
    expect(second).toEqual(first);
    expect(view.seq).toBe(2);
  });

  it('counts seq even when nobody is listening', () => {
    const { service, view } = setup();

    expect(service.publish(view, 'test', {}).seq).toBe(1);
  });
});

describe('ViewService closing views', () => {
  const orders: QueryDefinition<{ type?: string }> = {
    name: 'orders-close-spec',
    entityType: 'orders',
    dependsOn: {
      items: { filter: ['type'], link: () => sql`SELECT 1` },
    },
    build: (p) => sql`SELECT id, version FROM orders WHERE type = ${p.type}`,
  };
  const customers: QueryDefinition<{ id?: string }> = {
    name: 'customers-close-spec',
    entityType: 'customers',
    dependsOn: {},
    build: () => sql`SELECT id, version FROM customers`,
  };

  function setup() {
    vi.useFakeTimers();
    const registry = new ViewRegistry();
    const dependencies = new DependencyIndex();
    const loader = {
      ensureLoaded: vi.fn((view: View) => {
        view.loaded = true;
        return Promise.resolve();
      }),
      fetchByIds: vi.fn(() => Promise.resolve([])),
    };
    const feed = { watch: vi.fn(() => Promise.resolve()), unwatch: vi.fn() };
    const service = new ViewService(
      registry,
      loader as unknown as ViewLoader,
      dependencies,
      feed as unknown as ChangeFeed,
    );
    vi.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    const listener: ViewListener = { send: () => undefined };
    return { registry, dependencies, loader, feed, service, listener };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a view nobody streams CLOSE_AFTER_MS after it was opened', async () => {
    const { registry, dependencies, feed, service } = setup();
    const { viewKey } = await service.open(orders, { type: 'book' });

    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS - 1);
    expect(registry.get(viewKey)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(registry.get(viewKey)).toBeUndefined();
    expect(dependencies.watchedTypes()).toEqual([]);
    expect(feed.unwatch).toHaveBeenCalledWith(['orders', 'items']);
  });

  it('keeps a view open while a client streams it', async () => {
    const { registry, service, listener } = setup();
    const { viewKey } = await service.open(orders, { type: 'book' });
    const view = registry.get(viewKey)!;

    service.addListener(view, listener);
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS * 2);
    expect(registry.get(viewKey)).toBe(view);
    expect(view.closesAt).toBeUndefined();

    service.removeListener(view, listener);
    expect(view.closesAt).toBe(Date.now() + CLOSE_AFTER_MS);
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS);
    expect(registry.get(viewKey)).toBeUndefined();
  });

  it('starts the wait again when the view is opened again', async () => {
    const { registry, loader, service } = setup();
    const { viewKey } = await service.open(orders, { type: 'book' });
    const view = registry.get(viewKey)!;

    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS - 1_000);
    await service.open(orders, { type: 'book' });
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS - 1_000);

    expect(registry.get(viewKey)).toBe(view);
    expect(loader.ensureLoaded).toHaveBeenCalledTimes(2);
  });

  it('keeps reading the streams another open view still needs', async () => {
    const { feed, service } = setup();
    await service.open(orders, { type: 'book' });
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS / 2);
    await service.open(orders, { type: 'food' });
    await service.open(customers, {});

    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS / 2);

    expect(feed.unwatch).toHaveBeenCalledWith([]);
  });

  it('also closes a view whose load failed', async () => {
    const { registry, loader, service } = setup();
    loader.ensureLoaded.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.open(orders, { type: 'book' })).rejects.toThrow();
    expect(registry.list()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS);
    expect(registry.list()).toHaveLength(0);
  });

  it('does not close a view that was replaced or is streamed', async () => {
    const { registry, service, listener } = setup();
    const { viewKey } = await service.open(orders, { type: 'book' });
    const view = registry.get(viewKey)!;
    view.listeners.add(listener);

    service.close(view);

    expect(registry.get(viewKey)).toBe(view);
  });
});
