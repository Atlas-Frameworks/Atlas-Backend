import type { EntityDefinition } from './entity-definition.js';

/** Every entity type this service knows, by name. */
export class EntityRegistry {
  private readonly entities = new Map<string, EntityDefinition>();

  constructor(entities: EntityDefinition[] = []) {
    entities.forEach((entity) => this.register(entity));
  }

  /** Adds an entity type. Throws if one with the same name exists. */
  register(entity: EntityDefinition): this {
    if (this.entities.has(entity.type)) {
      throw new Error(`entity type ${entity.type} is already registered`);
    }
    this.entities.set(entity.type, entity);
    return this;
  }

  get(type: string): EntityDefinition | undefined {
    return this.entities.get(type);
  }

  types(): string[] {
    return [...this.entities.keys()];
  }
}
