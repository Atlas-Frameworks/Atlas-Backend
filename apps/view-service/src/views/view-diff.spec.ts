import {
  applyDeletes,
  applyFull,
  applyRecheck,
  emptyDiff,
  hashRow,
  hold,
  isEmpty,
  type Membership,
  type Row,
} from './view-diff.js';
import { SortKeys } from './sort-keys.js';

const row = (id: string, version: number, price = 10): Row => ({
  id,
  version,
  name: `order ${id}`,
  item_price: price,
});

/** A view holding a and b at version 1, price 10. */
function held(): Membership {
  const view = {
    ids: new Map<string, number>(),
    hashes: new Map<string, number>(),
    sortKeys: new SortKeys({ item_price: 'number' }),
  };
  hold(view, row('a', 1));
  hold(view, row('b', 1));
  return view;
}

describe('view diff', () => {
  it('adds, updates and removes the re-checked ids, with full rows', () => {
    const view = held();
    const diff = emptyDiff();
    const expected = new Map([
      ['a', 2],
      ['b', 0],
      ['c', 1],
    ]);

    const retry = applyRecheck(
      view,
      expected,
      [row('a', 2), row('c', 1)],
      diff,
    );

    expect(diff).toEqual({
      added: [row('c', 1)],
      updated: [row('a', 2)],
      removed: ['b'],
    });
    expect([...view.ids]).toEqual([
      ['a', 2],
      ['c', 1],
    ]);
    expect([...view.hashes.keys()]).toEqual(['a', 'c']);
    expect(retry.size).toBe(0);
  });

  it('counts a changed column as an update, even at the same version', () => {
    const view = held();
    const diff = emptyDiff();

    applyRecheck(view, new Map([['a', 0]]), [row('a', 1, 25)], diff);

    expect(diff.updated).toEqual([row('a', 1, 25)]);
    expect(view.hashes.get('a')).toBe(hashRow(row('a', 1, 25)));
  });

  it('sends nothing for a row that did not change', () => {
    const view = held();
    const diff = emptyDiff();

    applyRecheck(view, new Map([['a', 0]]), [row('a', 1)], diff);

    expect(isEmpty(diff)).toBe(true);
    expect(view.ids.has('b')).toBe(true);
  });

  it('keeps the held row when a lagging replica returns an older one', () => {
    const view = held();
    view.ids.set('a', 5);
    const diff = emptyDiff();

    applyRecheck(view, new Map([['a', 0]]), [row('a', 4, 99)], diff);

    expect(isEmpty(diff)).toBe(true);
    expect(view.ids.get('a')).toBe(5);
  });

  it('retries a row older than the event instead of applying it', () => {
    const view = held();
    const diff = emptyDiff();

    const retry = applyRecheck(view, new Map([['a', 3]]), [row('a', 2)], diff);

    expect(retry).toEqual(new Map([['a', 3]]));
    expect(isEmpty(diff)).toBe(true);
    expect(view.ids.get('a')).toBe(1);
  });

  it('removes deleted ids that the view holds', () => {
    const view = held();
    const diff = emptyDiff();

    applyDeletes(view, ['a', 'z'], diff);

    expect(diff.removed).toEqual(['a']);
    expect([...view.ids.keys()]).toEqual(['b']);
    expect([...view.hashes.keys()]).toEqual(['b']);
    expect(view.sortKeys.get('item_price', 'a')).toBeUndefined();
  });

  it('keeps the sort values of added and updated rows, and forgets removed ones', () => {
    const view = held();
    const diff = emptyDiff();

    applyRecheck(
      view,
      new Map([
        ['a', 0],
        ['b', 0],
        ['c', 0],
      ]),
      [row('a', 1, 25), row('c', 1, 7)],
      diff,
    );

    expect(view.sortKeys.get('item_price', 'a')).toBe(25);
    expect(view.sortKeys.get('item_price', 'b')).toBeUndefined();
    expect(view.sortKeys.get('item_price', 'c')).toBe(7);
  });

  it('diffs a full run against the ids held', () => {
    const view = held();
    const diff = emptyDiff();

    applyFull(view, [row('b', 1, 30), row('c', 1)], diff);

    expect(diff).toEqual({
      added: [row('c', 1)],
      updated: [row('b', 1, 30)],
      removed: ['a'],
    });
    expect([...view.ids]).toEqual([
      ['b', 1],
      ['c', 1],
    ]);
  });
});
