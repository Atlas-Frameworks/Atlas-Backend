import { ChangeBuffer } from '../changes/change-buffer.js';
import type { ChangeFeed } from '../changes/change-feed.js';
import { changeEvent } from '../changes/test-events.js';
import type { DbService } from '../db/db.service.js';
import type { Dependency } from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import { sql, toStatement, type SqlStatement } from './sql.js';
import { TickService } from './tick.service.js';
import { hold } from './view-diff.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { View, ViewEvent } from './view.js';

const ordersDeps: Record<string, Dependency> = {
  orders: { fields: ['item_id'] },
  items: {
    fields: ['price'],
    link: (ids) => sql`SELECT o.id FROM orders o WHERE o.item_id = ANY(${ids})`,
  },
};

/**
 * Stands in for Postgres. `matching` is what the view's SQL returns right now
 * (id → version); `orderItem` links each order to its item.
 */
class FakeDb {
  matching = new Map<string, number>();
  /** Extra columns of matching rows, e.g. the item's price joined in. */
  columns = new Map<string, Record<string, unknown>>();
  orderItem = new Map<string, string>();
  failNext: Error | undefined;
  readonly queries: SqlStatement[] = [];

  query = vi.fn((stmt: SqlStatement): Promise<unknown[]> => {
    this.queries.push(stmt);
    const error = this.failNext;
    this.failNext = undefined;
    if (error) {
      return Promise.reject(error);
    }
    const rows = (ids?: unknown) =>
      [...this.matching]
        .filter(([id]) => !ids || (ids as string[]).includes(id))
        .map(([id, version]) => ({
          id,
          version: String(version),
          ...this.columns.get(id),
        }));
    if (stmt.text.startsWith('SELECT q.id')) {
      return Promise.resolve(rows(stmt.values.at(-1)));
    }
    if (stmt.text.includes('item_id = ANY')) {
      const items = stmt.values[0] as string[];
      return Promise.resolve(
        [...this.orderItem]
          .filter(([, item]) => items.includes(item))
          .map(([id]) => ({ id })),
      );
    }
    return Promise.resolve(rows());
  });
}

function setup() {
  const db = new FakeDb();
  const buffer = new ChangeBuffer();
  const dependencies = new DependencyIndex();
  const registry = new ViewRegistry();
  const loader = new ViewLoader(db as unknown as DbService);
  const views = new ViewService(
    registry,
    loader,
    dependencies,
    {} as ChangeFeed,
  );
  const tick = new TickService(buffer, dependencies, registry, loader, views);
  vi.spyOn(tick['logger'], 'error').mockImplementation(() => undefined);

  /** Opens a loaded view holding these ids, and collects what it sends. */
  const open = (key: string, ids: Record<string, number> = {}) => {
    const view = registry.open(
      key,
      'orders',
      toStatement(sql`SELECT o.id, o.version FROM orders o`),
    );
    dependencies.add(key, 'orders', ordersDeps);
    for (const [id, version] of Object.entries(ids)) {
      hold(view, { id, version });
    }
    view.loaded = true;
    const sent: ViewEvent[] = [];
    view.listeners.add({ send: (e) => sent.push(e) });
    return { view, sent };
  };

  let typeSeq = 0;
  /** Pushes a change the way the feed does, with the next typeSeq of its type. */
  const change = (overrides: Parameters<typeof changeEvent>[0]) => {
    typeSeq += 1;
    buffer.push(changeEvent({ typeSeq, ...overrides }));
  };

  return { db, buffer, tick, open, change };
}

const ids = (view: View) => Object.fromEntries(view.ids);

describe('TickService', () => {
  it('adds an order that now matches and sends one delta', async () => {
    const { db, tick, open, change } = setup();
    const { view, sent } = open('v', { a: 1 });
    db.matching.set('a', 1).set('b', 2);

    change({ id: 'b', version: 2 });
    await tick.tick();

    expect(sent).toEqual([
      {
        type: 'delta',
        seq: 1,
        data: {
          added: [{ id: 'b', version: 2 }],
          updated: [],
          removed: [],
          total: 2,
        },
      },
    ]);
    expect(ids(view)).toEqual({ a: 1, b: 2 });
    expect(db.queries.at(-1)).toEqual({
      text: 'SELECT q.* FROM (SELECT o.id, o.version FROM orders o) q WHERE q.id = ANY($1)',
      values: [['b']],
    });
  });

  it('removes an order that no longer matches', async () => {
    const { tick, open, change } = setup();
    const { view, sent } = open('v', { a: 1 });

    change({ id: 'a', version: 2 });
    await tick.tick();

    expect(sent[0].data).toMatchObject({ removed: ['a'], total: 0 });
    expect(view.ids.size).toBe(0);
  });

  it('sends an update when a held order has a newer version', async () => {
    const { db, tick, open, change } = setup();
    const { sent } = open('v', { a: 1 });
    db.matching.set('a', 2);

    change({ id: 'a', version: 2 });
    await tick.tick();

    expect(sent[0].data).toMatchObject({ added: [], updated: [{ id: 'a' }] });
  });

  it('sends the full row when a linked item changes a column the order shows', async () => {
    const { db, tick, open, change } = setup();
    const { view, sent } = open('v', { a: 1 });
    db.orderItem.set('a', 'item-1');
    db.matching.set('a', 1);
    db.columns.set('a', { item_price: '20.00' });

    change({
      type: 'items',
      id: 'item-1',
      changes: { old: { price: 10 }, new: { price: 20 } },
    });
    await tick.tick();

    expect(sent[0].data).toEqual({
      added: [],
      updated: [{ id: 'a', version: 1, item_price: '20.00' }],
      removed: [],
      total: 1,
    });
    expect(view.ids.get('a')).toBe(1);
  });

  it('removes a deleted order without a query', async () => {
    const { db, tick, open, change } = setup();
    const { sent } = open('v', { a: 1 });

    change({ id: 'a', op: 'delete', version: 2, changes: undefined });
    await tick.tick();

    expect(sent[0].data).toMatchObject({ removed: ['a'], total: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('sends nothing when the result did not change', async () => {
    const { db, tick, open, change } = setup();
    const { sent } = open('v', { a: 2 });
    db.matching.set('a', 2);

    change({ id: 'a', version: 2 });
    change({ id: 'z', changes: { old: { name: 'x' }, new: { name: 'y' } } });
    await tick.tick();

    expect(sent).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('runs a link once for every view that shares it, then re-checks the linked orders', async () => {
    const { db, tick, open, change } = setup();
    const first = open('v1', { a: 1 });
    const second = open('v2');
    db.orderItem.set('a', 'item-1').set('b', 'item-1').set('c', 'item-2');
    db.matching.set('b', 1);

    change({
      type: 'items',
      id: 'item-1',
      changes: { old: { price: 10 }, new: { price: 20 } },
    });
    await tick.tick();

    const linkQueries = db.queries.filter((q) => q.text.includes('item_id'));
    expect(linkQueries).toEqual([
      {
        text: 'SELECT o.id FROM orders o WHERE o.item_id = ANY($1)',
        values: [['item-1']],
      },
    ]);
    expect(first.sent[0].data).toMatchObject({
      added: [{ id: 'b' }],
      removed: ['a'],
    });
    expect(second.sent[0].data).toMatchObject({
      added: [{ id: 'b' }],
      removed: [],
    });
  });

  it('retries a stale row next tick instead of applying it', async () => {
    const { db, tick, open, change } = setup();
    const { view, sent } = open('v', { a: 1 });
    db.matching.set('a', 1);

    change({ id: 'a', version: 3 });
    await tick.tick();
    expect(sent).toEqual([]);
    expect(tick.stats.retried).toBe(1);

    db.matching.set('a', 3);
    await tick.tick();
    expect(sent[0].data).toMatchObject({ updated: [{ id: 'a' }] });
    expect(ids(view)).toEqual({ a: 3 });
  });

  it('runs every view of a type in full after a typeSeq gap', async () => {
    const { db, buffer, tick, open } = setup();
    const { sent } = open('v', { a: 1, b: 1 });
    db.matching.set('b', 1).set('c', 1);

    buffer.push(
      changeEvent({ id: 'x', typeSeq: 1, changes: { old: {}, new: {} } }),
    );
    buffer.push(
      changeEvent({ id: 'y', typeSeq: 5, changes: { old: {}, new: {} } }),
    );
    await tick.tick();

    expect(sent[0].data).toMatchObject({
      added: [{ id: 'c' }],
      updated: [],
      removed: ['a'],
      total: 2,
    });
    expect(tick.stats.reloaded).toBe(1);
  });

  it('re-checks a change again once a loading view has loaded', async () => {
    const { db, tick, open, change } = setup();
    const { view, sent } = open('v');
    view.loaded = false;
    db.matching.set('a', 2);

    change({ id: 'a', version: 2 });
    await tick.tick();
    expect(db.query).not.toHaveBeenCalled();

    view.loaded = true;
    await tick.tick();
    expect(sent[0].data).toMatchObject({ added: [{ id: 'a' }] });
  });

  it('keeps the changes of a failed tick for the next one', async () => {
    const { db, buffer, tick, open, change } = setup();
    const { sent } = open('v');
    db.matching.set('a', 2);
    db.failNext = new Error('connection lost');

    change({ id: 'a', version: 2 });
    await tick.tick();
    expect(tick.stats.failed).toBe(1);
    expect(buffer.peek().map((e) => e.id)).toEqual(['a']);

    await tick.tick();
    expect(sent[0].data).toMatchObject({ added: [{ id: 'a' }] });
  });

  it('does nothing for a change no view depends on', async () => {
    const { db, tick, change } = setup();

    change({ id: 'a', version: 2 });
    await tick.tick();

    expect(db.query).not.toHaveBeenCalled();
  });

  it('ticks on its own once started', async () => {
    const { db, tick, open, change } = setup();
    const { sent } = open('v');
    db.matching.set('a', 2);
    tick.tickMs = 10;
    tick.onApplicationBootstrap();

    change({ id: 'a', version: 2 });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await tick.onModuleDestroy();
  });
});
