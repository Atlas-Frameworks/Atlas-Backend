import { defineQuery, queryKey, viaColumnsOf } from './define-query.js';
import { sql } from './sql.js';

describe('defineQuery', () => {
  it('returns the definition', () => {
    const def = {
      name: 'spec-query',
      entityType: 'orders',
      dependsOn: { orders: { filter: ['name'] } },
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
        dependsOn: { items: { filter: ['price'] } },
        build: () => sql`SELECT 1`,
      }),
    ).toThrow('query spec-no-link: dependency items needs a link');
  });

  it('refuses a field that is both filter and shown', () => {
    expect(() =>
      defineQuery({
        name: 'spec-both',
        entityType: 'orders',
        dependsOn: { orders: { filter: ['name'], shown: ['name', 'note'] } },
        build: () => sql`SELECT 1`,
      }),
    ).toThrow('query spec-both: orders.name is both filter and shown');
  });

  it("refuses via on the query's own type, and lists the via columns", () => {
    expect(() =>
      defineQuery({
        name: 'spec-own-via',
        entityType: 'orders',
        dependsOn: { orders: { via: 'id' } },
        build: () => sql`SELECT 1`,
      }),
    ).toThrow('query spec-own-via: via is for related types, not orders');
    expect(
      viaColumnsOf(
        defineQuery({
          name: 'spec-via',
          entityType: 'orders',
          dependsOn: {
            items: { via: 'item_id', link: () => sql`SELECT 1` },
            customers: { link: () => sql`SELECT 1` },
          },
          build: () => sql`SELECT 1`,
        }),
      ),
    ).toEqual(['item_id']);
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
