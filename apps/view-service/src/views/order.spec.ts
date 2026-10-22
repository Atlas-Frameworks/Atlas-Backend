import { asc, desc, ordered, orderName, orderOf } from './order.js';
import { sql, toStatement } from './sql.js';

describe('ordered', () => {
  it('writes the ORDER BY into the SQL, with collation, nulls and the id', () => {
    const query = ordered(
      sql`SELECT o.id, o.name, i.price AS item_price FROM orders o WHERE o.name = ${'x'}`,
      desc('item_price', 'number'),
      asc('name'),
    );

    expect(toStatement(query)).toEqual({
      text: 'SELECT * FROM (SELECT o.id, o.name, i.price AS item_price FROM orders o WHERE o.name = $1) q ORDER BY q."item_price" DESC NULLS LAST, q."name" COLLATE "C" ASC NULLS LAST, q.id',
      values: ['x'],
    });
  });

  it('orders by id alone when given no columns', () => {
    expect(toStatement(ordered(sql`SELECT id FROM orders`)).text).toBe(
      'SELECT * FROM (SELECT id FROM orders) q ORDER BY q.id',
    );
  });

  it('refuses a column that is not a plain name', () => {
    expect(() =>
      ordered(sql`SELECT 1`, asc('name"; DROP TABLE orders; --')),
    ).toThrow('is not a plain column name');
  });

  it('gives the order of a built query, or none when it is not ordered', () => {
    const query = ordered(sql`SELECT 1`, desc('item_price', 'number'));

    expect(orderOf(query)).toEqual([
      { column: 'item_price', dir: 'desc', type: 'number' },
    ]);
    expect(orderOf(sql`SELECT 1`)).toEqual([]);
    expect(orderName(orderOf(query))).toBe('item_price desc');
    expect(orderName([])).toBe('id');
  });
});
