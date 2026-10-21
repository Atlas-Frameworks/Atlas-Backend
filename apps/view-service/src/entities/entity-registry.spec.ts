import { EntityDefinition } from './entity-definition.js';
import { EntityRegistry } from './entity-registry.js';
import { DEFAULT_OPS, field } from './field.js';
import { ordersEntity } from './orders.entity.js';

describe('EntityDefinition', () => {
  it('gives a field the default operators of its type', () => {
    const entity = new EntityDefinition('items').addField(
      'price',
      field('number'),
    );

    expect(entity.getField('price')).toEqual({
      type: 'number',
      ops: DEFAULT_OPS.number,
    });
    expect(entity.getField('missing')).toBeUndefined();
  });

  it('refuses the same field name twice', () => {
    const entity = ordersEntity();

    expect(() => entity.addField('name', field('string'))).toThrow(
      'orders.name is already defined',
    );
  });

  it('builds a fresh definition each time, so additions do not leak', () => {
    ordersEntity().addField('status', field('string'));

    expect(ordersEntity().getField('status')).toBeUndefined();
  });
});

describe('EntityRegistry', () => {
  it('finds entities by type', () => {
    const registry = new EntityRegistry([ordersEntity()]);

    expect(registry.get('orders')?.fieldNames()).toContain('item.price');
    expect(registry.get('unknown')).toBeUndefined();
    expect(registry.types()).toEqual(['orders']);
  });

  it('accepts entities registered later', () => {
    const registry = new EntityRegistry();
    registry.register(
      new EntityDefinition('distributors').addField('name', field('string')),
    );

    expect(registry.types()).toEqual(['distributors']);
  });

  it('refuses the same entity type twice', () => {
    const registry = new EntityRegistry([ordersEntity()]);

    expect(() => registry.register(ordersEntity())).toThrow(
      'entity type orders is already registered',
    );
  });
});
