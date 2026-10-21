import { ViewRegistry } from './view-registry.js';
import type { FilterTree } from './view-key.js';

const booksOver100: FilterTree = {
  and: [
    { field: 'item.type', op: 'eq', value: 'book' },
    { field: 'item.price', op: 'gt', value: 100 },
  ],
};

describe('ViewRegistry', () => {
  let registry: ViewRegistry;

  beforeEach(() => {
    registry = new ViewRegistry();
  });

  it('shares one view between users with the same query', () => {
    const first = registry.open('orders', booksOver100);
    const second = registry.open('orders', structuredClone(booksOver100));

    expect(second).toBe(first);
    expect(first.refCount).toBe(2);
    expect(registry.list()).toHaveLength(1);
  });

  it('creates separate views for different queries', () => {
    const books = registry.open('orders', booksOver100);
    const food = registry.open('orders', {
      field: 'item.type',
      op: 'eq',
      value: 'food',
    });

    expect(food).not.toBe(books);
    expect(registry.list()).toHaveLength(2);
  });

  it('starts a new view empty, at seq 0', () => {
    const view = registry.open('orders', booksOver100);

    expect(view.entityType).toBe('orders');
    expect(view.ids.size).toBe(0);
    expect(view.seq).toBe(0);
    expect(view.nextSeq()).toBe(1);
    expect(view.nextSeq()).toBe(2);
  });

  it('finds a view by its key', () => {
    const view = registry.open('orders', booksOver100);

    expect(registry.get(view.viewKey)).toBe(view);
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('counts users down on release, never below 0', () => {
    const view = registry.open('orders', booksOver100);
    registry.open('orders', booksOver100);

    registry.release(view.viewKey);
    expect(view.refCount).toBe(1);
    registry.release(view.viewKey);
    registry.release(view.viewKey);
    expect(view.refCount).toBe(0);
    expect(registry.release('unknown')).toBeUndefined();
  });
});
