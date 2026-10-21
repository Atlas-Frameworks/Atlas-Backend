/** A query ready for pg: SQL text with $1, $2, … and the values for them. */
export interface SqlStatement {
  text: string;
  values: unknown[];
}

/**
 * A piece of SQL built with the `sql` tag. The text parts come from the
 * developer's code; every `${value}` is kept apart and sent as a parameter.
 */
export class Sql {
  constructor(
    readonly strings: readonly string[],
    readonly params: readonly unknown[],
  ) {}
}

/**
 * Tagged template for safe SQL: sql`i.price > ${minPrice}` becomes
 * "i.price > $1" with minPrice as a parameter. A `${…}` that is itself a
 * `sql` piece is inlined, so pieces can be combined.
 */
export function sql(strings: TemplateStringsArray, ...params: unknown[]): Sql {
  return new Sql(strings, params);
}

/** A piece that adds nothing, e.g. for an optional condition that is not set. */
export const empty = sql``;

/** Puts `separator` between the pieces, e.g. join(conditions, sql` OR `). */
export function join(parts: readonly Sql[], separator: Sql): Sql {
  const params = parts.flatMap((part, i) =>
    i === 0 ? [part] : [separator, part],
  );
  return new Sql(
    Array.from({ length: params.length + 1 }, () => ''),
    params,
  );
}

/** "WHERE a AND b" for the conditions given, or nothing when there are none. */
export function whereAll(conditions: readonly Sql[]): Sql {
  return conditions.length === 0
    ? empty
    : sql`WHERE ${join(conditions, sql` AND `)}`;
}

/** Numbers the parameters in order and returns the statement for pg. */
export function toStatement(piece: Sql): SqlStatement {
  const values: unknown[] = [];
  return { text: render(piece, values).trim(), values };
}

function render(piece: Sql, values: unknown[]): string {
  let text = piece.strings[0];
  piece.params.forEach((param, i) => {
    if (param instanceof Sql) {
      text += render(param, values);
    } else {
      values.push(param);
      text += `$${values.length}`;
    }
    text += piece.strings[i + 1];
  });
  return text;
}
