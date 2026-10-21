import type { FieldDef } from './field.js';

/**
 * One entity type and the fields a filter may use on it.
 * Dotted names (e.g. "item.price") are fields of a related entity.
 */
export class EntityDefinition {
  private readonly fields = new Map<string, FieldDef>();

  constructor(readonly type: string) {}

  /** Adds a filterable field. Throws if the name is already taken. */
  addField(name: string, def: FieldDef): this {
    if (this.fields.has(name)) {
      throw new Error(`${this.type}.${name} is already defined`);
    }
    this.fields.set(name, def);
    return this;
  }

  getField(name: string): FieldDef | undefined {
    return this.fields.get(name);
  }

  fieldNames(): string[] {
    return [...this.fields.keys()];
  }
}
