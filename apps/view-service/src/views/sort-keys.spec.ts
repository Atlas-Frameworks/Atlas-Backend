import { compareBy, parseSort, SortKeys, type SortValue } from './sort-keys.js';

const sortable = { name: 'text', item_price: 'number' } as const;

describe('parseSort', () => {
  it('reads a column with an optional direction', () => {
    expect(parseSort('name', sortable)).toEqual({ column: 'name', dir: 'asc' });
    expect(parseSort('item_price:desc', sortable)).toEqual({
      column: 'item_price',
      dir: 'desc',
    });
  });

  it('rejects an unknown column or direction', () => {
    expect(parseSort('customer_id', sortable)).toBe(
      'cannot sort by customer_id; sortable: name, item_price',
    );
    expect(parseSort('name:up', sortable)).toMatch(/asc\|desc/);
    expect(parseSort('name:asc:x', sortable)).toMatch(/asc\|desc/);
    expect(parseSort('toString', sortable)).toMatch(/cannot sort/);
  });
});

describe('compareBy', () => {
  /** Sorts [value, id] pairs and returns the ids in order. */
  const order = (items: [SortValue, string][], dir: 'asc' | 'desc') =>
    [...items]
      .sort(([a, aId], [b, bId]) => compareBy(a, aId, b, bId, dir))
      .map(([, id]) => id);

  const items: [SortValue, string][] = [
    [25, 'b'],
    [null, 'n'],
    [100, 'a'],
    [25, 'a'],
  ];

  it('orders by value, then by id, with null last', () => {
    expect(order(items, 'asc')).toEqual(['a', 'b', 'a', 'n']);
  });

  it('reverses the values, not the id tie-break or null, for desc', () => {
    expect(order(items, 'desc')).toEqual(['a', 'a', 'b', 'n']);
  });

  it('compares text by code unit', () => {
    expect(
      order(
        [
          ['b', '1'],
          ['B', '2'],
          ['a', '3'],
        ],
        'asc',
      ),
    ).toEqual(['2', '3', '1']);
  });
});

describe('SortKeys', () => {
  it('keeps only the sortable columns, as comparable values', () => {
    const keys = new SortKeys({
      item_price: 'number',
      name: 'text',
      created: 'time',
    });

    keys.set(
      {
        id: 'a',
        version: 1,
        item_price: '25.50',
        name: 'Book',
        created: new Date('2026-10-21T10:00:00Z'),
        customer_id: 'c',
      },
      true,
    );

    expect(keys.get('item_price', 'a')).toBe(25.5);
    expect(keys.get('name', 'a')).toBe('Book');
    expect(keys.get('created', 'a')).toBe(Date.parse('2026-10-21T10:00:00Z'));
    expect(keys.get('customer_id', 'a')).toBeUndefined();
  });

  it('keeps null for a null value', () => {
    const keys = new SortKeys({ item_price: 'number' });

    keys.set({ id: 'a', version: 1, item_price: null }, true);

    expect(keys.get('item_price', 'a')).toBeNull();
  });

  it('throws when the query does not select a sortable column', () => {
    const keys = new SortKeys({ item_price: 'number' });

    expect(() => keys.set({ id: 'a', version: 1 }, true)).toThrow(
      'sortable column item_price is not selected by the query',
    );
  });

  it('forgets an id, or everything', () => {
    const keys = new SortKeys({ item_price: 'number' });
    keys.set({ id: 'a', version: 1, item_price: 1 }, true);
    keys.set({ id: 'b', version: 1, item_price: 2 }, true);

    keys.delete('a');
    expect(keys.get('item_price', 'a')).toBeUndefined();
    keys.clear();
    expect(keys.get('item_price', 'b')).toBeUndefined();
  });
});
