import { ViewRegistry } from './view-registry.js';

const books = { text: 'SELECT books', values: [] };
const food = { text: 'SELECT food', values: [] };

describe('ViewRegistry', () => {
  let registry: ViewRegistry;

  beforeEach(() => {
    registry = new ViewRegistry();
  });

  it('shares one view between users with the same key, keeping the first SQL', () => {
    const first = registry.open('books', 'orders', books);
    const second = registry.open('books', 'orders', food);

    expect(second).toBe(first);
    expect(first.statement).toBe(books);
    expect(first.refCount).toBe(2);
    expect(registry.list()).toHaveLength(1);
  });

  it('creates separate views for different keys', () => {
    const first = registry.open('books', 'orders', books);
    const second = registry.open('food', 'orders', food);

    expect(second).not.toBe(first);
    expect(registry.list()).toHaveLength(2);
  });

  it('starts a new view empty, at seq 0', () => {
    const view = registry.open('books', 'orders', books);

    expect(view.entityType).toBe('orders');
    expect(view.ids.size).toBe(0);
    expect(view.seq).toBe(0);
    expect(view.nextSeq()).toBe(1);
    expect(view.nextSeq()).toBe(2);
  });

  it('finds a view by its key', () => {
    const view = registry.open('books', 'orders', books);

    expect(registry.get(view.viewKey)).toBe(view);
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('counts users down on release, never below 0', () => {
    const view = registry.open('books', 'orders', books);
    registry.open('books', 'orders', books);

    registry.release(view.viewKey);
    expect(view.refCount).toBe(1);
    registry.release(view.viewKey);
    registry.release(view.viewKey);
    expect(view.refCount).toBe(0);
    expect(registry.release('unknown')).toBeUndefined();
  });
});
