import { customersEntity } from '../entities/customers.entity.js';
import { EntityRegistry } from '../entities/entity-registry.js';
import { field } from '../entities/field.js';
import { itemsEntity } from '../entities/items.entity.js';
import { ordersEntity } from '../entities/orders.entity.js';
import { validateFilter } from './validate-filter.js';

const ITEM_ID = '00000000-0000-0000-0000-000000000101';

const registry = new EntityRegistry([
  ordersEntity(),
  itemsEntity(),
  customersEntity(),
]);

function errorOf(entityType: unknown, filter: unknown): string | undefined {
  const result = validateFilter(registry, entityType, filter);
  return result.ok ? undefined : result.message;
}

describe('validateFilter', () => {
  it('accepts books over 100', () => {
    const filter = {
      and: [
        { field: 'item.type', op: 'eq', value: 'book' },
        { field: 'item.price', op: 'gt', value: 100 },
      ],
    };
    expect(validateFilter(registry, 'orders', filter)).toEqual({
      ok: true,
      filter,
    });
  });

  it('accepts a field added to an entity after it was registered', () => {
    const extended = new EntityRegistry([ordersEntity()]);
    const filter = { field: 'status', op: 'eq', value: 'shipped' };
    expect(validateFilter(extended, 'orders', filter).ok).toBe(false);

    extended.get('orders')!.addField('status', field('string'));
    expect(validateFilter(extended, 'orders', filter).ok).toBe(true);
  });

  it('respects a field limited to fewer operators', () => {
    const limited = new EntityRegistry([
      ordersEntity().addField('code', field('string', { ops: ['eq'] })),
    ]);
    expect(
      validateFilter(limited, 'orders', {
        field: 'code',
        op: 'contains',
        value: 'abc',
      }),
    ).toEqual({
      ok: false,
      message: 'filter.op "contains" is not allowed on code; use one of eq',
    });
  });

  it('accepts every operator with a value of the right shape', () => {
    const filter = {
      or: [
        { field: 'item_id', op: 'eq', value: ITEM_ID },
        { field: 'item.type', op: 'in', value: ['book', 'food'] },
        { field: 'item.price', op: 'between', value: [10, 50] },
        { field: 'name', op: 'contains', value: 'Ord' },
        { field: 'customer_id', op: 'isNull' },
        { and: [{ field: 'customer.name', op: 'neq', value: 'Bob' }] },
      ],
    };
    expect(errorOf('orders', filter)).toBeUndefined();
  });

  it('rejects an unknown entity type', () => {
    expect(errorOf('airplanes', { field: 'name', op: 'eq', value: 'x' })).toBe(
      'unknown entityType "airplanes"',
    );
    expect(errorOf(undefined, {})).toBe('unknown entityType undefined');
  });

  it('rejects a field not in the registry, with its path', () => {
    expect(
      errorOf('orders', {
        and: [
          { field: 'item.type', op: 'eq', value: 'book' },
          { field: 'secret', op: 'eq', value: 'x' },
        ],
      }),
    ).toBe('filter.and[1].field unknown field "secret"');
  });

  it('does not accept inherited object keys as fields', () => {
    expect(
      errorOf('orders', { field: 'constructor', op: 'eq', value: 'x' }),
    ).toBe('filter.field unknown field "constructor"');
  });

  it('rejects an operator the field does not allow', () => {
    expect(errorOf('orders', { field: 'name', op: 'gt', value: 'a' })).toMatch(
      /^filter\.op "gt" is not allowed on name/,
    );
  });

  it('rejects values of the wrong type', () => {
    expect(
      errorOf('orders', { field: 'item.price', op: 'gt', value: '100' }),
    ).toBe('filter.value must be a number');
    expect(
      errorOf('orders', { field: 'item_id', op: 'eq', value: 'not-a-uuid' }),
    ).toBe('filter.value must be a uuid');
    expect(
      errorOf('orders', { field: 'item.type', op: 'in', value: ['book', 3] }),
    ).toBe('filter.value[1] must be a string');
  });

  it('checks the shape of in, between, contains and isNull', () => {
    expect(errorOf('orders', { field: 'item.type', op: 'in', value: [] })).toBe(
      'filter.value must be a non-empty array',
    );
    expect(
      errorOf('orders', {
        field: 'item.price',
        op: 'between',
        value: [50, 10],
      }),
    ).toBe('filter.value from must not be greater than to');
    expect(
      errorOf('orders', { field: 'name', op: 'contains', value: 'Or' }),
    ).toBe('filter.value must be at least 3 characters');
    expect(
      errorOf('orders', { field: 'name', op: 'isNull', value: null }),
    ).toBe('filter.value must be left out for isNull');
  });

  it('rejects malformed nodes', () => {
    expect(errorOf('orders', null)).toBe('filter must be an object');
    expect(errorOf('orders', { and: [] })).toBe(
      'filter.and must be a non-empty array',
    );
    expect(
      errorOf('orders', { field: 'name', op: 'eq', value: 'x', sql: '1=1' }),
    ).toBe('filter has unknown keys: sql');
  });

  it('enforces the depth limit of 4', () => {
    const leaf = { field: 'name', op: 'eq', value: 'x' };
    expect(errorOf('orders', { and: [{ or: [{ and: [leaf] }] }] })).toBe(
      undefined,
    );
    expect(
      errorOf('orders', { and: [{ or: [{ and: [{ or: [leaf] }] }] }] }),
    ).toBe('filter.and[0].or[0].and[0].or[0] is nested deeper than 4 levels');
  });

  it('enforces the limits of 20 conditions and 200 in values', () => {
    const leaf = { field: 'name', op: 'eq', value: 'x' };
    expect(
      errorOf('orders', { and: Array.from({ length: 20 }, () => leaf) }),
    ).toBeUndefined();
    expect(
      errorOf('orders', { and: Array.from({ length: 21 }, () => leaf) }),
    ).toBe('filter.and[20] has more than 20 conditions in the filter');
    expect(
      errorOf('orders', {
        field: 'item.type',
        op: 'in',
        value: Array.from({ length: 201 }, () => 'book'),
      }),
    ).toBe('filter.value has more than 200 values');
  });
});
