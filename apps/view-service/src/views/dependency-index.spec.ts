import type { ChangeEvent } from '../changes/change-event.js';
import type { Dependency } from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import { sql, toStatement } from './sql.js';

const ordersDeps: Record<string, Dependency> = {
  orders: { fields: ['item_id', 'customer_id'] },
  items: {
    fields: ['type', 'price'],
    link: (ids) => sql`SELECT o.id FROM orders o WHERE o.item_id = ANY(${ids})`,
  },
};

function event(
  type: string,
  changes: ChangeEvent['changes'],
  op: ChangeEvent['op'] = 'upsert',
): ChangeEvent {
  return {
    schema: 2,
    type,
    id: 'id-1',
    op,
    version: 2,
    typeSeq: 1,
    committedAt: '2026-10-21T10:00:00.000Z',
    changes,
  };
}

const update = (field: string): ChangeEvent['changes'] => ({
  old: { [field]: 1 },
  new: { [field]: 2 },
});

describe('DependencyIndex', () => {
  let index: DependencyIndex;

  beforeEach(() => {
    index = new DependencyIndex();
    index.add('orders-view', 'orders', ordersDeps);
  });

  it('re-checks own-type views when a field they read changes', () => {
    expect(index.candidates(event('orders', update('item_id')))).toEqual({
      own: ['orders-view'],
      linked: [],
    });
  });

  it('skips own-type views when only other fields change', () => {
    expect(index.candidates(event('orders', update('name'))).own).toEqual([]);
    expect(index.candidates(event('orders', { old: {}, new: {} })).own).toEqual(
      [],
    );
  });

  it('always matches an insert and a delete', () => {
    const insert = {
      old: {},
      new: { name: 'x', item_id: 'i', customer_id: 'c' },
    };

    expect(index.candidates(event('orders', insert)).own).toEqual([
      'orders-view',
    ]);
    expect(index.candidates(event('orders', undefined, 'delete')).own).toEqual([
      'orders-view',
    ]);
  });

  it('returns related-type views with their link', () => {
    const { own, linked } = index.candidates(event('items', update('price')));

    expect(own).toEqual([]);
    expect(linked.map((c) => c.viewKey)).toEqual(['orders-view']);
    expect(toStatement(linked[0].link(['id-1']))).toEqual({
      text: 'SELECT o.id FROM orders o WHERE o.item_id = ANY($1)',
      values: [['id-1']],
    });
  });

  it('skips related-type views when only other fields change', () => {
    expect(index.candidates(event('items', update('name'))).linked).toEqual([]);
  });

  it('matches every change when no field list is declared', () => {
    index.add('all-fields', 'customers', {});

    expect(index.candidates(event('customers', update('address'))).own).toEqual(
      ['all-fields'],
    );
  });

  it('watches the own type even when it is not listed', () => {
    index.add('items-only', 'orders', {
      items: { link: () => sql`SELECT 1` },
    });

    expect(index.dependenciesOf('items-only')).toEqual({
      orders: {},
      items: { link: expect.any(Function) },
    });
    expect(index.candidates(event('orders', update('name'))).own).toContain(
      'items-only',
    );
  });

  it('ignores types nobody depends on', () => {
    expect(index.candidates(event('distributors', update('name')))).toEqual({
      own: [],
      linked: [],
    });
  });

  it('lists the watched types and forgets a removed view', () => {
    index.add('customers-view', 'customers', {});
    expect(index.watchedTypes().sort()).toEqual([
      'customers',
      'items',
      'orders',
    ]);

    index.remove('orders-view');

    expect(index.watchedTypes()).toEqual(['customers']);
    expect(index.dependenciesOf('orders-view')).toBeUndefined();
    expect(index.candidates(event('orders', update('item_id'))).own).toEqual(
      [],
    );
  });

  it('registers a view only once', () => {
    index.add('orders-view', 'orders', {});

    expect(index.dependenciesOf('orders-view')).toMatchObject(ordersDeps);
  });
});
