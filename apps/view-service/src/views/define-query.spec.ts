import { defaultSortOf, defineQuery, queryKey } from './define-query.js';
import { sql } from './sql.js';

describe('defineQuery', () => {
  it('returns the definition', () => {
    const def = {
      name: 'spec-query',
      entityType: 'orders',
      dependsOn: { orders: { fields: ['name'] } },
      build: () => sql`SELECT 1`,
    };

    expect(defineQuery(def)).toBe(def);
  });

  it('refuses the same name twice', () => {
    const def = {
      name: 'spec-twice',
      entityType: 'orders',
      dependsOn: {},
      build: () => sql`SELECT 1`,
    };
    defineQuery(def);

    expect(() => defineQuery(def)).toThrow(
      'query spec-twice is already defined',
    );
  });

  it('refuses a related type without a link', () => {
    expect(() =>
      defineQuery({
        name: 'spec-no-link',
        entityType: 'orders',
        dependsOn: { items: { fields: ['price'] } },
        build: () => sql`SELECT 1`,
      }),
    ).toThrow('query spec-no-link: dependency items needs a link');
  });

  it('refuses a default sort that is not a sortable column', () => {
    expect(() =>
      defineQuery({
        name: 'spec-bad-sort',
        entityType: 'orders',
        dependsOn: {},
        sortable: { name: 'text' },
        defaultSort: 'item_price:desc',
        build: () => sql`SELECT 1`,
      }),
    ).toThrow(
      'query spec-bad-sort: defaultSort: cannot sort by item_price; sortable: name',
    );
  });

  it('gives the default sort, or undefined to sort by id', () => {
    const base = {
      entityType: 'orders',
      dependsOn: {},
      sortable: { name: 'text' as const },
      build: () => sql`SELECT 1`,
    };

    expect(
      defaultSortOf(
        defineQuery({ ...base, name: 'spec-sort', defaultSort: 'name:desc' }),
      ),
    ).toEqual({ column: 'name', dir: 'desc' });
    expect(
      defaultSortOf(defineQuery({ ...base, name: 'spec-no-sort' })),
    ).toBeUndefined();
  });
});

describe('queryKey', () => {
  it('is a 32-character hex hash', () => {
    expect(queryKey('q', {})).toMatch(/^[0-9a-f]{32}$/);
  });

  it('ignores param order and undefined params', () => {
    expect(queryKey('q', { a: 1, b: 'x' })).toBe(
      queryKey('q', { b: 'x', a: 1, c: undefined }),
    );
    expect(queryKey('q', { a: undefined })).toBe(queryKey('q', {}));
  });

  it('differs by name and by value', () => {
    expect(queryKey('q', { a: 1 })).not.toBe(queryKey('other', { a: 1 }));
    expect(queryKey('q', { a: 1 })).not.toBe(queryKey('q', { a: 2 }));
    expect(queryKey('q', { a: 1 })).not.toBe(queryKey('q', { a: '1' }));
  });

  it('keeps array order', () => {
    expect(queryKey('q', { t: ['a', 'b'] })).not.toBe(
      queryKey('q', { t: ['b', 'a'] }),
    );
  });
});
