import { EntityDefinition } from './entity-definition.js';
import { field } from './field.js';

export function ordersEntity(): EntityDefinition {
  return new EntityDefinition('orders')
    .addField('name', field('string'))
    .addField('item_id', field('uuid'))
    .addField('customer_id', field('uuid'))
    .addField('item.type', field('string'))
    .addField('item.price', field('number'))
    .addField('customer.name', field('string'));
}
