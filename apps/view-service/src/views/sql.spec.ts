import { empty, join, sql, toStatement, whereAll } from './sql.js';

describe('sql', () => {
  it('turns every value into a numbered parameter', () => {
    expect(toStatement(sql`a = ${1} AND b = ${'x'}`)).toEqual({
      text: 'a = $1 AND b = $2',
      values: [1, 'x'],
    });
  });

  it('never puts a value into the SQL text', () => {
    const attack = "x'; DROP TABLE orders; --";
    const { text, values } = toStatement(sql`o.name = ${attack}`);

    expect(text).toBe('o.name = $1');
    expect(values).toEqual([attack]);
  });

  it('numbers parameters in order across nested pieces', () => {
    const inner = sql`b = ${2} OR c = ${3}`;

    expect(toStatement(sql`a = ${1} AND (${inner}) AND d = ${4}`)).toEqual({
      text: 'a = $1 AND (b = $2 OR c = $3) AND d = $4',
      values: [1, 2, 3, 4],
    });
  });

  it('adds nothing for the empty piece', () => {
    expect(toStatement(sql`SELECT 1 ${empty}`)).toEqual({
      text: 'SELECT 1',
      values: [],
    });
  });

  it('joins pieces with a separator', () => {
    expect(
      toStatement(join([sql`a = ${1}`, sql`b = ${2}`, sql`c`], sql` OR `)),
    ).toEqual({ text: 'a = $1 OR b = $2 OR c', values: [1, 2] });
    expect(toStatement(join([], sql` OR `)).text).toBe('');
  });

  it('builds a WHERE only when there are conditions', () => {
    expect(toStatement(whereAll([sql`a = ${1}`, sql`b = ${2}`]))).toEqual({
      text: 'WHERE a = $1 AND b = $2',
      values: [1, 2],
    });
    expect(toStatement(whereAll([])).text).toBe('');
  });

  it('sends an array as one parameter', () => {
    expect(toStatement(sql`t = ANY(${['a', 'b']})`)).toEqual({
      text: 't = ANY($1)',
      values: [['a', 'b']],
    });
  });
});
