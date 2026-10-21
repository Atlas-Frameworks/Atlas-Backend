// Local stand-in for the field types of @atlas/view-engine (E-01).

export type FieldType = 'string' | 'number' | 'uuid';

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains'
  | 'isNull'
  | 'notNull';

export interface FieldDef {
  type: FieldType;
  ops: readonly FilterOp[];
}

/** Operators a field gets by default, per type. */
export const DEFAULT_OPS: Record<FieldType, readonly FilterOp[]> = {
  string: ['eq', 'neq', 'in', 'nin', 'contains', 'isNull', 'notNull'],
  uuid: ['eq', 'neq', 'in', 'nin', 'isNull', 'notNull'],
  number: [
    'eq',
    'neq',
    'in',
    'nin',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'isNull',
    'notNull',
  ],
};

/** A filterable field. Pass `ops` to allow fewer operators than the type's default. */
export function field(
  type: FieldType,
  options: { ops?: readonly FilterOp[] } = {},
): FieldDef {
  return { type, ops: options.ops ?? DEFAULT_OPS[type] };
}
