import { ChangeBuffer } from '../changes/change-buffer.js';
import type { ChangeEvent } from '../changes/change-event.js';
import type { ChangeFeed } from '../changes/change-feed.js';
import type { DbService } from '../db/db.service.js';
import {
  defineQuery,
  type Dependency,
  type QueryDefinition,
} from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import type { WindowData } from './live-window.js';
import { compareBy, type SortSpec } from './sort-keys.js';
import {
  sql,
  toStatement,
  whereAll,
  type Sql,
  type SqlStatement,
} from './sql.js';
import { TickService } from './tick.service.js';
import type { Row, ViewDiff } from './view-diff.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { View, ViewEvent } from './view.js';

// Incremental vs full: random changes go through the real tick (buffer,
// dependency index, re-check, diff, sorted indexes, windows), and after every
// tick each view, each sort and each client is compared with a fresh full
// query. Postgres is modelled in memory: it answers the view's statements
// (full, re-check by id, link) by evaluating the same filter in JS.

interface Params {
  types?: string[];
  minPrice?: number;
}

const columns = sql`
  o.id, o.version, o.name, o.customer_id, o.item_id,
  i.type AS item_type, i.price AS item_price`;
const link = (ids: string[]) =>
  sql`SELECT o.id FROM orders o WHERE o.item_id = ANY(${ids})`;

function ordersQuery(
  name: string,
  orders: Dependency,
  items: Omit<Dependency, 'link'>,
): QueryDefinition<Params> {
  const dependsOn: Record<string, Dependency> = {
    orders,
    items: { ...items, link },
  };
  return defineQuery({
    name,
    entityType: 'orders',
    dependsOn,
    sortable: { name: 'text', item_price: 'number' },
    defaultSort: 'name',
    build: (p: Params) => {
      const where: Sql[] = [];
      if (p.types !== undefined) {
        where.push(sql`i.type = ANY(${p.types})`);
      }
      if (p.minPrice !== undefined) {
        where.push(sql`i.price >= ${p.minPrice}`);
      }
      return sql`SELECT ${columns} FROM orders o JOIN items i ON i.id = o.item_id ${whereAll(where)}`;
    },
  });
}

/** The item's type and price are filtered on; the order's name and customer only shown. */
const correct = ordersQuery(
  'incremental-spec',
  { filter: ['item_id'], shown: ['name', 'customer_id'] },
  { filter: ['type', 'price'], via: 'item_id' },
);
/** The same without `via`: shown changes of items go through the link query. */
const withoutVia = ordersQuery(
  'incremental-spec-no-via',
  { filter: ['item_id'], shown: ['name', 'customer_id'] },
  { filter: ['type', 'price'] },
);
/** Shows `name` but doesn't declare it: name changes are never re-checked. */
const missingName = ordersQuery(
  'incremental-spec-missing-name',
  { filter: ['item_id'], shown: ['customer_id'] },
  { filter: ['type', 'price'], via: 'item_id' },
);
/** Declares price as shown, though minPrice filters on it: orders never enter on a price change. */
const priceAsShown = ordersQuery(
  'incremental-spec-price-shown',
  { filter: ['item_id'], shown: ['name', 'customer_id'] },
  { filter: ['type'], shown: ['price'], via: 'item_id' },
);

interface Item {
  id: string;
  version: number;
  type: string;
  price: number;
}
interface Order {
  id: string;
  version: number;
  name: string;
  customer_id: string;
  item_id: string;
}

const TYPES = ['book', 'food', 'toy'];
const NAMES = ['Apple', 'apple', 'Bolt', 'Cup', 'Desk', 'Egg', 'Fan'];

/** The data, the change events it emits, and the statements a view runs, answered in JS. */
class World {
  readonly items = new Map<string, Item>();
  readonly orders = new Map<string, Order>();
  readonly events: ChangeEvent[] = [];
  private readonly typeSeq = { orders: 0, items: 0 };
  private nextId = 0;
  /** "statement text + values" → the params it was built from. */
  private readonly statements = new Map<string, Params>();

  constructor(private readonly random: (n: number) => number) {}

  register(query: QueryDefinition<Params>, params: Params): void {
    this.statements.set(key(toStatement(query.build(params))), params);
  }

  /** What Postgres returns: rows with version as a string and price as numeric text. */
  query(stmt: SqlStatement): Promise<unknown[]> {
    const wrap = 'SELECT q.* FROM (';
    if (stmt.text.startsWith(wrap)) {
      const inner = {
        text: stmt.text.slice(wrap.length, stmt.text.lastIndexOf(') q WHERE')),
        values: stmt.values.slice(0, -1),
      };
      const ids = new Set(stmt.values.at(-1) as string[]);
      return Promise.resolve(
        this.matching(this.paramsOf(inner))
          .filter((o) => ids.has(o.id))
          .map((o) => this.pgRow(o)),
      );
    }
    if (stmt.text === toStatement(link([])).text) {
      const items = new Set(stmt.values[0] as string[]);
      return Promise.resolve(
        [...this.orders.values()]
          .filter((o) => items.has(o.item_id))
          .map((o) => ({ id: o.id })),
      );
    }
    return Promise.resolve(
      this.matching(this.paramsOf(stmt)).map((o) => this.pgRow(o)),
    );
  }

  /** The rows a fresh full query returns, as the view's loader gives them. */
  fresh(params: Params): Row[] {
    return this.matching(params).map((o) => ({
      ...this.pgRow(o),
      version: o.version,
    }));
  }

  /** One random change, recorded as the outbox event the replicator would write. */
  change(): void {
    const r = this.random(20);
    const orders = [...this.orders.values()];
    const items = [...this.items.values()];
    if (r < 3 || orders.length < 10) {
      const order: Order = {
        id: this.id('o'),
        version: 1,
        name: this.pick(NAMES),
        customer_id: `c-${this.random(3)}`,
        item_id: this.pick(items).id,
      };
      this.orders.set(order.id, order);
      const { id: _id, version: _v, ...fields } = order;
      this.emit('orders', order.id, 'upsert', 1, { old: {}, new: fields });
    } else if (r < 5) {
      const order = this.pick(orders);
      this.orders.delete(order.id);
      this.emit('orders', order.id, 'delete', order.version + 1, undefined);
    } else if (r < 12) {
      const order = this.pick(orders);
      const field = this.pick(['name', 'item_id', 'customer_id'] as const);
      const value =
        field === 'name'
          ? this.pick(NAMES)
          : field === 'item_id'
            ? this.pick(items).id
            : `c-${this.random(3)}`;
      if (value === order[field]) {
        return;
      }
      const old = order[field];
      order[field] = value;
      order.version += 1;
      this.emit('orders', order.id, 'upsert', order.version, {
        old: { [field]: old },
        new: { [field]: value },
      });
    } else if (r < 19) {
      const item = this.pick(items);
      const changes =
        this.random(2) === 0
          ? { field: 'price' as const, value: this.random(12) * 10 }
          : { field: 'type' as const, value: this.pick(TYPES) };
      if (changes.value === item[changes.field]) {
        return;
      }
      const old = item[changes.field];
      Object.assign(item, { [changes.field]: changes.value });
      item.version += 1;
      this.emit('items', item.id, 'upsert', item.version, {
        old: { [changes.field]: old },
        new: { [changes.field]: changes.value },
      });
    } else {
      const item: Item = {
        id: this.id('i'),
        version: 1,
        type: this.pick(TYPES),
        price: this.random(12) * 10,
      };
      this.items.set(item.id, item);
      this.emit('items', item.id, 'upsert', 1, {
        old: {},
        new: { type: item.type, price: item.price },
      });
    }
  }

  private matching(p: Params): Order[] {
    return [...this.orders.values()].filter((o) => {
      const item = this.items.get(o.item_id)!;
      return (
        (p.types === undefined || p.types.includes(item.type)) &&
        (p.minPrice === undefined || item.price >= p.minPrice)
      );
    });
  }

  private pgRow(o: Order): Row & Record<string, unknown> {
    const item = this.items.get(o.item_id)!;
    return {
      id: o.id,
      version: String(o.version) as unknown as number,
      name: o.name,
      customer_id: o.customer_id,
      item_id: o.item_id,
      item_type: item.type,
      item_price: item.price.toFixed(2),
    };
  }

  private paramsOf(stmt: SqlStatement): Params {
    const params = this.statements.get(key(stmt));
    if (!params) {
      throw new Error(`unknown statement: ${stmt.text}`);
    }
    return params;
  }

  private emit(
    type: 'orders' | 'items',
    id: string,
    op: ChangeEvent['op'],
    version: number,
    changes: ChangeEvent['changes'],
  ): void {
    this.typeSeq[type] += 1;
    this.events.push({
      schema: 2,
      type,
      id,
      op,
      version,
      typeSeq: this.typeSeq[type],
      committedAt: '2026-10-21T10:00:00.000Z',
      changes,
    });
  }

  private id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}-${String(this.nextId).padStart(4, '0')}`;
  }

  private pick<T>(list: readonly T[]): T {
    return list[this.random(list.length)];
  }
}

const key = (stmt: SqlStatement) =>
  `${stmt.text}\n${JSON.stringify(stmt.values)}`;

/** A client of one stream: applies every event it gets, as a browser would. */
interface Client {
  view: View;
  params: Params;
  /** Undefined: the whole view, from deltas. */
  window?: { sort: SortSpec; offset: number; limit: number };
  ids: string[];
  rows: Map<string, Row>;
}

function sortFresh(rows: Row[], spec: SortSpec): string[] {
  const value = (row: Row) =>
    spec.column === 'item_price'
      ? Number(row.item_price)
      : (row.name as string);
  return [...rows]
    .sort((a, b) => compareBy(value(a), a.id, value(b), b.id, spec.dir))
    .map((row) => row.id);
}

/**
 * Runs `ticks` ticks of random changes through the real pipeline and returns
 * the first difference from a fresh full query, or undefined if none.
 * Every 25th event is delivered twice, and about every 97th is lost, so
 * duplicate and gap handling run too. An event is lost only when a later
 * event of its type arrives in the same tick: a gap can only be seen once a
 * later event shows it (reconciliation covers the rest, outside this test).
 */
async function run(
  query: QueryDefinition<Params>,
  seed: number,
  ticks: number,
): Promise<string | undefined> {
  let state = seed;
  const random = (n: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state % n;
  };
  const world = new World(random);
  for (let i = 0; i < 8; i++) {
    world.items.set(`i-seed-${i}`, {
      id: `i-seed-${i}`,
      version: 1,
      type: TYPES[i % 3],
      price: (i + 1) * 15,
    });
  }
  for (let i = 0; i < 40; i++) {
    world.change();
  }
  world.events.length = 0;

  const db = { query: (stmt: SqlStatement) => world.query(stmt) };
  const buffer = new ChangeBuffer();
  const dependencies = new DependencyIndex();
  const registry = new ViewRegistry();
  const loader = new ViewLoader(db as unknown as DbService);
  const feed = { watch: () => Promise.resolve(), unwatch: () => undefined };
  const views = new ViewService(
    registry,
    loader,
    dependencies,
    feed as unknown as ChangeFeed,
  );
  const tick = new TickService(buffer, dependencies, registry, loader, views);

  const clients: Client[] = [];
  for (const params of [
    { types: ['book'] },
    { minPrice: 60 },
    {},
  ] as Params[]) {
    world.register(query, params);
    const opened = await views.open(query, params, { limit: 1 });
    const view = registry.get(opened.viewKey)!;

    const whole: Client = { view, params, ids: [], rows: new Map() };
    const first = await views.page(view, {});
    for (const row of first.rows) {
      whole.rows.set(row.id, row);
    }
    view.listeners.add({
      send: (event) => {
        const diff = event.data as ViewDiff;
        for (const row of [...diff.added, ...diff.updated]) {
          whole.rows.set(row.id, row);
        }
        for (const id of diff.removed) {
          whole.rows.delete(id);
        }
      },
    });
    clients.push(whole);

    for (const window of [
      {
        sort: { column: 'item_price', dir: 'desc' } as const,
        offset: 0,
        limit: 8,
      },
      { sort: { column: 'name', dir: 'asc' } as const, offset: 5, limit: 10 },
      {
        sort: { column: 'item_price', dir: 'asc' } as const,
        offset: 12,
        limit: 6,
      },
    ]) {
      const client: Client = { view, params, window, ids: [], rows: new Map() };
      const apply = (event: ViewEvent) => {
        const data = event.data as WindowData;
        client.ids = data.ids;
        for (const row of data.rows as Row[]) {
          client.rows.set(row.id, row);
        }
      };
      apply(await views.openWindow(view, window, { send: apply }).first);
      clients.push(client);
    }
  }

  let delivered = 0;
  for (let t = 0; t < ticks; t++) {
    for (let n = random(6); n > 0; n--) {
      world.change();
    }
    for (; delivered < world.events.length; delivered++) {
      const evt = world.events[delivered];
      const laterOfType = world.events
        .slice(delivered + 1)
        .some((later) => later.type === evt.type);
      if ((delivered + 1) % 97 === 0 && laterOfType) {
        continue;
      }
      buffer.push(evt);
      if ((delivered + 1) % 25 === 0) {
        buffer.push(evt);
      }
    }
    await tick.tick();
    if (tick.stats.failed > 0) {
      return `tick ${t}: the tick failed`;
    }

    for (const client of clients) {
      const fresh = world.fresh(client.params);
      const freshById = new Map(fresh.map((row) => [row.id, row]));
      const where = `tick ${t}, view ${JSON.stringify(client.params)}`;
      const ids = [...client.view.ids.keys()].sort();
      if (
        JSON.stringify(ids) !== JSON.stringify([...freshById.keys()].sort())
      ) {
        return `${where}: the view holds other ids than a fresh query`;
      }
      if (!client.window) {
        for (const row of fresh) {
          if (JSON.stringify(client.rows.get(row.id)) !== JSON.stringify(row)) {
            return `${where}: the delta client has ${JSON.stringify(client.rows.get(row.id))}, fresh is ${JSON.stringify(row)}`;
          }
        }
        if (client.rows.size !== fresh.length) {
          return `${where}: the delta client holds removed rows`;
        }
        continue;
      }
      const { sort, offset, limit } = client.window;
      const sorted = sortFresh(fresh, sort);
      if (
        JSON.stringify(client.view.sorted(sort).ids) !== JSON.stringify(sorted)
      ) {
        return `${where}: the sort ${sort.column}:${sort.dir} differs from a fresh sort`;
      }
      const expected = sorted.slice(offset, offset + limit);
      if (JSON.stringify(client.ids) !== JSON.stringify(expected)) {
        return `${where}: window ${offset}+${limit} shows other ids than a fresh query`;
      }
      for (const id of expected) {
        if (
          JSON.stringify(client.rows.get(id)) !==
          JSON.stringify(freshById.get(id))
        ) {
          return `${where}: window ${offset}+${limit} shows ${JSON.stringify(client.rows.get(id))}, fresh is ${JSON.stringify(freshById.get(id))}`;
        }
      }
    }
  }
  return undefined;
}

describe('incremental vs full', () => {
  it.each([1, 2, 3, 4, 5])(
    'keeps every view, sort and client equal to a fresh query (seed %i)',
    async (seed) => {
      expect(await run(correct, seed, 150)).toBeUndefined();
    },
  );

  it.each([1, 2, 3])(
    'is also exact without via, through the link query (seed %i)',
    async (seed) => {
      expect(await run(withoutVia, seed, 150)).toBeUndefined();
    },
  );

  it('catches a filter field declared as shown', async () => {
    const mismatches = await Promise.all(
      [1, 2, 3].map((seed) => run(priceAsShown, seed, 150)),
    );

    expect(mismatches.some((m) => m !== undefined)).toBe(true);
  });

  it('catches a shown column missing from dependsOn', async () => {
    const mismatches = await Promise.all(
      [1, 2, 3].map((seed) => run(missingName, seed, 150)),
    );

    expect(mismatches.some((m) => m?.includes('fresh is'))).toBe(true);
  });
});
