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
  const loader = {
    fetchByIds: vi.fn((_view: View, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id, version: 9, name: id }))),
    ),
  };
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
  it('takes a snapshot of the rows of the ids held, at the current seq', async () => {
    const { service, view, loader } = setup();
    view.nextSeq();

    const snapshot = service.snapshot(view);
    view.nextSeq();
    view.ids.set('c', 1);

    expect(await snapshot).toEqual({
      viewKey: 'key',
      seq: 1,
      total: 2,
      rows: [
        { id: 'a', version: 9, name: 'a' },
        { id: 'b', version: 9, name: 'b' },
      ],
    });
    expect(loader.fetchByIds).toHaveBeenCalledWith(view, ['a', 'b']);
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
      items: { fields: ['type'], link: () => sql`SELECT 1` },
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
