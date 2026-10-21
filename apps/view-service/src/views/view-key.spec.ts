import { viewKey, type FilterTree } from './view-key.js';

const booksOver100: FilterTree = {
  and: [
    { field: 'item.type', op: 'eq', value: 'book' },
    { field: 'item.price', op: 'gt', value: 100 },
  ],
};

describe('viewKey', () => {
  it('is the same for the same query', () => {
    expect(viewKey('orders', booksOver100)).toBe(
      viewKey('orders', structuredClone(booksOver100)),
    );
  });

  it('ignores the order of object keys', () => {
    const reordered: FilterTree = {
      and: [
        { value: 'book', op: 'eq', field: 'item.type' },
        { op: 'gt', field: 'item.price', value: 100 },
      ],
    };
    expect(viewKey('orders', reordered)).toBe(viewKey('orders', booksOver100));
  });

  it('ignores the order of and / or children', () => {
    const swapped: FilterTree = {
      and: [
        { field: 'item.price', op: 'gt', value: 100 },
        { field: 'item.type', op: 'eq', value: 'book' },
      ],
    };
    expect(viewKey('orders', swapped)).toBe(viewKey('orders', booksOver100));
  });

  it('keeps the order of values inside a condition', () => {
    const a: FilterTree = {
      field: 'item.type',
      op: 'in',
      value: ['book', 'food'],
    };
    const b: FilterTree = {
      field: 'item.type',
      op: 'in',
      value: ['food', 'book'],
    };
    expect(viewKey('orders', a)).not.toBe(viewKey('orders', b));
  });

  it('differs for a different value, operator or entity type', () => {
    const key = viewKey('orders', booksOver100);
    expect(
      viewKey('orders', {
        and: [
          { field: 'item.type', op: 'eq', value: 'book' },
          { field: 'item.price', op: 'gt', value: 200 },
        ],
      }),
    ).not.toBe(key);
    expect(
      viewKey('orders', {
        or: [
          { field: 'item.type', op: 'eq', value: 'book' },
          { field: 'item.price', op: 'gt', value: 100 },
        ],
      }),
    ).not.toBe(key);
    expect(viewKey('items', booksOver100)).not.toBe(key);
  });
});
