import { asc, desc, type OrderKey } from './order.js';
import { compareValues, SortKeys, type SortValue } from './sort-keys.js';
import { SortedIndex } from './sorted-index.js';

const row = (id: string, item_price: number | null, name = 'x') => ({
  id,
  version: 1,
  item_price,
  name,
});

/** Price ascending, then name: a 30, b 10, c 20, n null. */
function keys(order: OrderKey[] = [asc('item_price', 'number')]): SortKeys {
  const k = new SortKeys(order);
  k.set(row('a', 30), true);
  k.set(row('b', 10), true);
  k.set(row('c', 20), true);
  k.set(row('n', null), true);
  return k;
}
const held = ['a', 'b', 'c', 'n'];

describe('compareValues', () => {
  it('puts null last in both directions', () => {
    expect(compareValues(null, 1, 'asc')).toBe(1);
    expect(compareValues(null, 1, 'desc')).toBe(1);
    expect(compareValues(2, 1, 'desc')).toBe(-1);
  });

  it('compares text by code unit, like COLLATE "C"', () => {
    expect(compareValues('B', 'a', 'asc')).toBe(-1);
  });
});

describe('SortKeys', () => {
  it('sorts the ids once, by every key and then the id', () => {
    const k = new SortKeys([desc('item_price', 'number'), asc('name')]);
    k.set(row('a', 10, 'Pen'), true);
    k.set(row('b', 20, 'Cup'), true);
    k.set(row('c', 10, 'Book'), true);
    k.set(row('d', 10, 'Book'), true);

    expect(k.sorted(['a', 'b', 'c', 'd']).ids).toEqual(['b', 'c', 'd', 'a']);
  });

  it('orders by id without an ORDER BY', () => {
    const k = new SortKeys([]);
    for (const id of ['c', 'a', 'b']) {
      k.set(row(id, 1), true);
    }

    expect(k.sorted(['c', 'a', 'b']).ids).toEqual(['a', 'b', 'c']);
  });

  it('keeps only the ORDER BY columns, as comparable values', () => {
    const k = new SortKeys([
      asc('item_price', 'number'),
      asc('created', 'time'),
    ]);

    k.set(
      {
        id: 'a',
        version: 1,
        item_price: '25.50',
        created: new Date('2026-10-21T10:00:00Z'),
        name: 'Book',
      },
      true,
    );

    expect(k.get('item_price', 'a')).toBe(25.5);
    expect(k.get('created', 'a')).toBe(Date.parse('2026-10-21T10:00:00Z'));
    expect(k.get('name', 'a')).toBeUndefined();
  });

  it('throws when the query does not select an ORDER BY column', () => {
    const k = new SortKeys([asc('item_price', 'number')]);

    expect(() => k.set({ id: 'a', version: 1 }, true)).toThrow(
      'order column item_price is not selected by the query',
    );
  });

  it('puts a new id at its place', () => {
    const k = keys();
    const index = k.sorted(held);

    k.set(row('d', 15), true);

    expect(index.ids).toEqual(['b', 'd', 'c', 'a', 'n']);
  });

  it('moves an id whose ORDER BY value changed, not one whose other columns did', () => {
    const k = keys();
    const index = k.sorted(held);

    k.set(row('a', 5), false);
    expect(index.ids).toEqual(['a', 'b', 'c', 'n']);
    k.set(row('c', 20, 'renamed'), false);
    expect(index.ids).toEqual(['a', 'b', 'c', 'n']);
  });

  it('takes a deleted id out, and drops the index on clear', () => {
    const k = keys();
    const index = k.sorted(held);

    k.delete('c');
    expect(index.ids).toEqual(['b', 'a', 'n']);
    k.clear();
    expect(k.sorted([]).ids).toEqual([]);
  });

  it('still finds an id whose values changed without a remove first', () => {
    const values = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const index = new SortedIndex(
      (x, y) => values.get(x)! - values.get(y)!,
      ['a', 'b'],
    );

    values.set('a', 9);
    index.remove('a');

    expect(index.ids).toEqual(['b']);
  });

  it('stays equal to a fresh sort after many random changes', () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const order = [desc('item_price', 'number'), asc('name')];
    const k = new SortKeys(order);
    const ids = new Set<string>();
    const index = k.sorted(ids);
    const values = new Map<string, [SortValue, SortValue]>();

    for (let step = 0; step < 3000; step++) {
      const id = `id-${random(200)}`;
      if (random(4) === 0) {
        k.delete(id);
        ids.delete(id);
        values.delete(id);
      } else {
        // Few distinct values, so ties (broken by name, then id) and nulls are common.
        const price = random(10) === 0 ? null : random(8);
        const name = ['a', 'B', 'c'][random(3)];
        k.set(row(id, price, name), !ids.has(id));
        ids.add(id);
        values.set(id, [price, name]);
      }
    }

    const fresh = [...ids].sort((a, b) => {
      const [pa, na] = values.get(a)!;
      const [pb, nb] = values.get(b)!;
      return (
        compareValues(pa, pb, 'desc') ||
        compareValues(na, nb, 'asc') ||
        (a < b ? -1 : 1)
      );
    });
    expect(index.ids).toEqual(fresh);
  });
});
