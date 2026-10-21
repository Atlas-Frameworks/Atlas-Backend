import { EntityDefinition } from './entity-definition.js';
import { field } from './field.js';

export function itemsEntity(): EntityDefinition {
  return new EntityDefinition('items')
    .addField('type', field('string'))
    .addField('price', field('number'));
}
