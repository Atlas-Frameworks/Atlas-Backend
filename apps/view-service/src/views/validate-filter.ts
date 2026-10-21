import type { EntityDefinition } from '../entities/entity-definition.js';
import type { EntityRegistry } from '../entities/entity-registry.js';
import type { FieldType } from '../entities/field.js';
import type { FilterTree } from './view-key.js';

// Limits from contracts §5.
const MAX_DEPTH = 4;
const MAX_CONDITIONS = 20;
const MAX_IN_VALUES = 200;
const MIN_CONTAINS_LENGTH = 3;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FilterResult =
  { ok: true; filter: FilterTree } | { ok: false; message: string };

class FilterError extends Error {}

/**
 * Checks a filter tree from a client: known entity type, known fields,
 * allowed operators, values of the right type, and the size limits.
 */
export function validateFilter(
  registry: EntityRegistry,
  entityType: unknown,
  filter: unknown,
): FilterResult {
  const entity =
    typeof entityType === 'string' ? registry.get(entityType) : undefined;
  if (!entity) {
    return {
      ok: false,
      message: `unknown entityType ${JSON.stringify(entityType)}`,
    };
  }
  const state = { conditions: 0 };
  try {
    checkNode(entity, filter, 'filter', 1, state);
  } catch (err) {
    if (err instanceof FilterError) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
  return { ok: true, filter: filter as FilterTree };
}

function checkNode(
  entity: EntityDefinition,
  node: unknown,
  path: string,
  depth: number,
  state: { conditions: number },
): void {
  if (depth > MAX_DEPTH) {
    fail(path, `is nested deeper than ${MAX_DEPTH} levels`);
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    fail(path, 'must be an object');
  }
  const keys = Object.keys(node);

  if (keys.length === 1 && (keys[0] === 'and' || keys[0] === 'or')) {
    const group = keys[0];
    const children = (node as Record<string, unknown>)[group];
    if (!Array.isArray(children) || children.length === 0) {
      fail(`${path}.${group}`, 'must be a non-empty array');
    }
    children.forEach((child, i) =>
      checkNode(entity, child, `${path}.${group}[${i}]`, depth + 1, state),
    );
    return;
  }

  state.conditions += 1;
  if (state.conditions > MAX_CONDITIONS) {
    fail(path, `has more than ${MAX_CONDITIONS} conditions in the filter`);
  }
  checkCondition(entity, node as Record<string, unknown>, keys, path);
}

function checkCondition(
  entity: EntityDefinition,
  node: Record<string, unknown>,
  keys: string[],
  path: string,
): void {
  const extra = keys.filter(
    (k) => k !== 'field' && k !== 'op' && k !== 'value',
  );
  if (extra.length > 0) {
    fail(path, `has unknown keys: ${extra.join(', ')}`);
  }
  const { field, op, value } = node;
  const def = typeof field === 'string' ? entity.getField(field) : undefined;
  if (!def) {
    fail(`${path}.field`, `unknown field ${JSON.stringify(field)}`);
  }
  if (typeof op !== 'string' || !def.ops.includes(op as never)) {
    fail(
      `${path}.op`,
      `${JSON.stringify(op)} is not allowed on ${field as string}; use one of ${def.ops.join(', ')}`,
    );
  }

  const valuePath = `${path}.value`;
  switch (op) {
    case 'isNull':
    case 'notNull':
      if ('value' in node) {
        fail(valuePath, `must be left out for ${op}`);
      }
      return;
    case 'in':
    case 'nin':
      if (!Array.isArray(value) || value.length === 0) {
        fail(valuePath, 'must be a non-empty array');
      }
      if (value.length > MAX_IN_VALUES) {
        fail(valuePath, `has more than ${MAX_IN_VALUES} values`);
      }
      value.forEach((v, i) => checkValue(def.type, v, `${valuePath}[${i}]`));
      return;
    case 'between':
      if (!Array.isArray(value) || value.length !== 2) {
        fail(valuePath, 'must be [from, to]');
      }
      checkValue(def.type, value[0], `${valuePath}[0]`);
      checkValue(def.type, value[1], `${valuePath}[1]`);
      if ((value[0] as number) > (value[1] as number)) {
        fail(valuePath, 'from must not be greater than to');
      }
      return;
    case 'contains':
      checkValue(def.type, value, valuePath);
      if ((value as string).length < MIN_CONTAINS_LENGTH) {
        fail(valuePath, `must be at least ${MIN_CONTAINS_LENGTH} characters`);
      }
      return;
    default:
      checkValue(def.type, value, valuePath);
  }
}

function checkValue(type: FieldType, value: unknown, path: string): void {
  const valid =
    type === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : type === 'uuid'
        ? typeof value === 'string' && UUID_RE.test(value)
        : typeof value === 'string';
  if (!valid) {
    fail(path, `must be a ${type}`);
  }
}

function fail(path: string, problem: string): never {
  throw new FilterError(`${path} ${problem}`);
}
