import { EntityDefinition } from './entity-definition.js';
import { field } from './field.js';

export function customersEntity(): EntityDefinition {
  return new EntityDefinition('customers')
    .addField('name', field('string'))
    .addField('address', field('string'));
}
