import { defineQuery, queryKey } from './define-query.js';
import { sql } from './sql.js';

describe('defineQuery', () => {
  it('returns the definition', () => {
    const def = {
      name: 'spec-query',
      entityType: 'orders',
      dependsOn: ['orders'],
      build: () => sql`SELECT 1`,
    };

    expect(defineQuery(def)).toBe(def);
  });

  it('refuses the same name twice', () => {
    const def = {
      name: 'spec-twice',
      entityType: 'orders',
      dependsOn: [],
      build: () => sql`SELECT 1`,
    };
    defineQuery(def);

    expect(() => defineQuery(def)).toThrow(
      'query spec-twice is already defined',
    );
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
