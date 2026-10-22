import type { ChangeEvent } from '../changes/change-event.js';
import type { Dependency } from './define-query.js';
import { DependencyIndex } from './dependency-index.js';
import { sql, toStatement } from './sql.js';

const ordersDeps: Record<string, Dependency> = {
  orders: { filter: ['item_id', 'customer_id'], shown: ['name'] },
  items: {
    filter: ['type'],
    shown: ['price'],
    via: 'item_id',
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

  it('marks a change to a filter field as filter', () => {
    expect(index.candidates(event('orders', update('item_id')))).toEqual({
      own: [{ viewKey: 'orders-view', level: 'filter' }],
      linked: [],
    });
  });

  it('marks a change to only shown fields as shown', () => {
    expect(index.candidates(event('orders', update('name'))).own).toEqual([
      { viewKey: 'orders-view', level: 'shown' },
    ]);
  });

  it('counts a change to filter and shown fields together as filter', () => {
    const both = {
      old: { name: 'a', item_id: 'x' },
      new: { name: 'b', item_id: 'y' },
    };

    expect(index.candidates(event('orders', both)).own).toEqual([
      { viewKey: 'orders-view', level: 'filter' },
    ]);
  });

  it('skips own-type views when only undeclared fields change', () => {
    expect(index.candidates(event('orders', update('note'))).own).toEqual([]);
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
      { viewKey: 'orders-view', level: 'filter' },
    ]);
    expect(index.candidates(event('orders', undefined, 'delete')).own).toEqual([
      { viewKey: 'orders-view', level: 'filter' },
    ]);
  });

  it('returns related-type views with their level, link and via', () => {
    const shown = index.candidates(event('items', update('price')));
    const filter = index.candidates(event('items', update('type')));

    expect(shown.own).toEqual([]);
    expect(shown.linked).toEqual([
      {
        viewKey: 'orders-view',
        level: 'shown',
        link: expect.any(Function),
        via: 'item_id',
      },
    ]);
    expect(filter.linked[0].level).toBe('filter');
    expect(toStatement(filter.linked[0].link(['id-1']))).toEqual({
      text: 'SELECT o.id FROM orders o WHERE o.item_id = ANY($1)',
      values: [['id-1']],
    });
  });

  it('skips related-type views when only other fields change', () => {
    expect(index.candidates(event('items', update('name'))).linked).toEqual([]);
  });

  it('treats every field as filter when none is declared, except shown ones', () => {
    index.add('all-fields', 'customers', {});
    index.add('some-shown', 'distributors', {
      distributors: { shown: ['phone'] },
    });

    expect(index.candidates(event('customers', update('address'))).own).toEqual(
      [{ viewKey: 'all-fields', level: 'filter' }],
    );
    expect(
      index.candidates(event('distributors', update('phone'))).own,
    ).toEqual([{ viewKey: 'some-shown', level: 'shown' }]);
    expect(
      index.candidates(event('distributors', update('region'))).own,
    ).toEqual([{ viewKey: 'some-shown', level: 'filter' }]);
  });

  it('watches the own type even when it is not listed', () => {
    index.add('items-only', 'orders', {
      items: { link: () => sql`SELECT 1` },
    });

    expect(index.dependenciesOf('items-only')).toEqual({
      orders: {},
      items: { link: expect.any(Function) },
    });
    expect(
      index.candidates(event('orders', update('name'))).own,
    ).toContainEqual({ viewKey: 'items-only', level: 'filter' });
  });

  it('ignores types nobody depends on', () => {
    expect(index.candidates(event('suppliers', update('name')))).toEqual({
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
