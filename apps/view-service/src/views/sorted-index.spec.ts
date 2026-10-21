import { SortKeys, compareBy, type SortSpec } from './sort-keys.js';
import { SortedIndex, sortName } from './sorted-index.js';

const price = (id: string, item_price: number | null) => ({
  id,
  version: 1,
  item_price,
});

/** SortKeys holding a: 30, b: 10, c: 20, n: null. */
function keys(): SortKeys {
  const k = new SortKeys({ item_price: 'number' });
  k.set(price('a', 30), true);
  k.set(price('b', 10), true);
  k.set(price('c', 20), true);
  k.set(price('n', null), true);
  return k;
}

const held = ['a', 'b', 'c', 'n'];
const asc: SortSpec = { column: 'item_price', dir: 'asc' };
const desc: SortSpec = { column: 'item_price', dir: 'desc' };

describe('SortedIndex', () => {
  it('sorts the ids once when built', () => {
    const k = keys();

    expect(k.index(asc, held).ids).toEqual(['b', 'c', 'a', 'n']);
    expect(k.index(desc, held).ids).toEqual(['a', 'c', 'b', 'n']);
    expect(k.index(undefined, ['c', 'a', 'b']).ids).toEqual(['a', 'b', 'c']);
  });

  it('is built once per sort, and named after it', () => {
    const k = keys();

    expect(k.index(asc, held)).toBe(k.index(asc, []));
    expect(k.indexNames()).toEqual(['item_price:asc']);
    expect(sortName(desc)).toBe('item_price:desc');
    expect(sortName(undefined)).toBe('id');
  });

  it('puts a new id at its place in every index', () => {
    const k = keys();
    const byPrice = k.index(asc, held);
    const byId = k.index(undefined, held);

    k.set(price('d', 15), true);

    expect(byPrice.ids).toEqual(['b', 'd', 'c', 'a', 'n']);
    expect(byId.ids).toEqual(['a', 'b', 'c', 'd', 'n']);
  });

  it('moves an id whose value changed, and leaves other indexes alone', () => {
    const k = new SortKeys({ item_price: 'number', name: 'text' });
    for (const [id, p, name] of [
      ['a', 30, 'x'],
      ['b', 10, 'y'],
      ['c', 20, 'z'],
    ] as const) {
      k.set({ id, version: 1, item_price: p, name }, true);
    }
    const byPrice = k.index(asc, ['a', 'b', 'c']);
    const byName = k.index({ column: 'name', dir: 'asc' }, ['a', 'b', 'c']);

    k.set({ id: 'a', version: 2, item_price: 5, name: 'x' }, false);

    expect(byPrice.ids).toEqual(['a', 'b', 'c']);
    expect(byName.ids).toEqual(['a', 'b', 'c']);
    expect(k.get('item_price', 'a')).toBe(5);
  });

  it('takes a deleted id out of every index', () => {
    const k = keys();
    const byPrice = k.index(asc, held);

    k.delete('c');

    expect(byPrice.ids).toEqual(['b', 'a', 'n']);
  });

  it('drops its indexes on clear', () => {
    const k = keys();
    k.index(asc, held);

    k.clear();

    expect(k.indexNames()).toEqual([]);
  });

  it('still finds an id whose value changed without a remove first', () => {
    const values = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const index = new SortedIndex(asc, (id) => values.get(id)!, ['a', 'b']);

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
    const k = new SortKeys({ item_price: 'number' });
    const ids = new Set<string>();
    const indexes = [asc, desc, undefined].map((spec) => k.index(spec, ids));

    for (let step = 0; step < 3000; step++) {
      const id = `id-${random(200)}`;
      if (random(4) === 0) {
        k.delete(id);
        ids.delete(id);
      } else {
        // Few distinct values, so ties (broken by id) and nulls are common.
        const value = random(10) === 0 ? null : random(20);
        k.set(price(id, value), !ids.has(id));
        ids.add(id);
      }
    }

    for (const index of indexes) {
      const fresh = [...ids].sort((a, b) =>
        index.spec
          ? compareBy(
              k.get('item_price', a)!,
              a,
              k.get('item_price', b)!,
              b,
              index.spec.dir,
            )
          : a < b
            ? -1
            : 1,
      );
      expect(index.ids).toEqual(fresh);
    }
  });
});
