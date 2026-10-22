import { Sql } from './sql.js';

/**
 * How a sort column compares. Postgres returns `numeric` as a string, so the
 * type is declared: as text, "100" would sort before "25".
 */
export type SortType = 'text' | 'number' | 'time';

/** One ORDER BY key: a column of the query's result. */
export interface OrderKey {
  column: string;
  dir: 'asc' | 'desc';
  type: SortType;
}

export const asc = (column: string, type: SortType = 'text'): OrderKey => ({
  column,
  dir: 'asc',
  type,
});

export const desc = (column: string, type: SortType = 'text'): OrderKey => ({
  column,
  dir: 'desc',
  type,
});

/** A query with its ORDER BY, which the view also applies in memory. */
export class OrderedSql extends Sql {
  constructor(
    select: Sql,
    readonly order: readonly OrderKey[],
  ) {
    const by = [...order.map(render), 'q.id'].join(', ');
    super(['SELECT * FROM (', `) q ORDER BY ${by}`], [select]);
  }
}

/**
 * Orders a query by columns of its result, e.g.
 * ordered(sql`SELECT …`, desc('item_price', 'number'), asc('name')).
 * The ORDER BY is part of the SQL, and the view keeps its rows in the same
 * order in memory as rows change. So both always agree, it adds
 * COLLATE "C" for text, NULLS LAST, and the id as the last key.
 */
export function ordered(select: Sql, ...order: OrderKey[]): OrderedSql {
  for (const key of order) {
    if (!COLUMN.test(key.column)) {
      throw new Error(`ordered: ${key.column} is not a plain column name`);
    }
  }
  return new OrderedSql(select, order);
}

/** The ORDER BY of a built query; empty (by id) when it isn't ordered. */
export function orderOf(piece: Sql): readonly OrderKey[] {
  return piece instanceof OrderedSql ? piece.order : [];
}

/** "item_price desc, name asc", or "id". */
export function orderName(order: readonly OrderKey[]): string {
  return order.map((k) => `${k.column} ${k.dir}`).join(', ') || 'id';
}

/** Result column names only: they are written into the SQL text. */
const COLUMN = /^[a-z_][a-z0-9_]*$/;

function render(key: OrderKey): string {
  const collate = key.type === 'text' ? ' COLLATE "C"' : '';
  return `q."${key.column}"${collate} ${key.dir.toUpperCase()} NULLS LAST`;
}
