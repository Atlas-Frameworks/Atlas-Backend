import type { FilterOp, RegistryField, RegistryType } from './registry';

/**
 * The filter builder's editable model and its conversion to the contracts §5 filter tree.
 *
 * Editors keep every value as text (what the inputs hold); `buildFilter` parses and checks it
 * against the registry and the documented limits, so the server's `INVALID_FILTER` is the
 * exception rather than the feedback loop.
 */

/** Contracts §5 limits. */
export const FILTER_LIMITS = {
  /** Nesting depth of the tree; the root `and` is depth 1, its conditions depth 2. */
  depth: 4,
  conditions: 20,
  inValues: 200,
  containsMin: 3,
} as const;

/** Deepest group that can still hold conditions (they sit one level below it). */
export const MAX_GROUP_DEPTH = FILTER_LIMITS.depth - 1;

export interface ConditionDraft {
  kind: 'condition';
  id: number;
  field: string;
  op: FilterOp;
  /** Single value; for text `in`/`nin` a comma-separated list; the lower bound of `between`. */
  value: string;
  /** Upper bound of `between`. */
  to: string;
  /** Picked enum values for `in`/`nin` on a field with `values`. */
  values: string[];
}

export interface GroupDraft {
  kind: 'group';
  id: number;
  join: 'and' | 'or';
  children: FilterDraft[];
}

export type FilterDraft = ConditionDraft | GroupDraft;

export type FilterValue = string | number | boolean | (string | number | boolean)[];

/** A contracts §5 node. */
export type FilterTree =
  | { and: FilterTree[] }
  | { or: FilterTree[] }
  | { field: string; op: FilterOp; value?: FilterValue };

export interface FilterIssue {
  /** The draft node the message is about. */
  nodeId: number;
  message: string;
}

export interface BuiltFilter {
  /** `null` = no filter (an empty root group). */
  tree: FilterTree | null;
  issues: FilterIssue[];
}

let nextId = 1;
const newId = () => nextId++;

export function emptyGroup(join: 'and' | 'or' = 'and'): GroupDraft {
  return { kind: 'group', id: newId(), join, children: [] };
}

/** A condition on `field` with its first allowed operator. */
export function newCondition(field: RegistryField | undefined): ConditionDraft {
  return {
    kind: 'condition',
    id: newId(),
    field: field?.name ?? '',
    op: field?.ops[0] ?? 'eq',
    value: '',
    to: '',
    values: [],
  };
}

/** Gives every node a fresh id (drafts loaded from storage must not collide with live ones). */
export function reId(node: FilterDraft): FilterDraft {
  return node.kind === 'group'
    ? { ...node, id: newId(), children: node.children.map(reId) }
    : { ...node, id: newId() };
}

/** What value editor an operator needs. */
export type ValueEditor = 'none' | 'single' | 'enum' | 'list' | 'enum-list' | 'range' | 'boolean';

export function valueEditor(field: RegistryField | undefined, op: FilterOp): ValueEditor {
  if (op === 'isNull' || op === 'notNull') return 'none';
  if (op === 'between') return 'range';
  const hasValues = (field?.values?.length ?? 0) > 0;
  if (op === 'in' || op === 'nin') return hasValues ? 'enum-list' : 'list';
  if (field?.type === 'boolean') return 'boolean';
  if ((op === 'eq' || op === 'neq') && hasValues) return 'enum';
  return 'single';
}

export const OP_LABELS: Record<FilterOp, string> = {
  eq: '=',
  neq: '≠',
  in: 'in',
  nin: 'not in',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  contains: 'contains',
  isNull: 'is empty',
  notNull: 'is set',
};

/** Number of conditions in a draft (the `conditions` limit counts these). */
export function countConditions(node: FilterDraft): number {
  return node.kind === 'condition' ? 1 : node.children.reduce((n, c) => n + countConditions(c), 0);
}

/** Converts the draft to a contracts §5 tree and lists everything the server would reject. */
export function buildFilter(root: GroupDraft, type: RegistryType | undefined): BuiltFilter {
  const issues: FilterIssue[] = [];
  const fields = new Map((type?.fields ?? []).map((f) => [f.name, f]));
  let conditions = 0;

  const group = (g: GroupDraft, depth: number): FilterTree | null => {
    if (g.children.length === 0) {
      if (depth > 1) issues.push({ nodeId: g.id, message: 'Empty group' });
      return null;
    }
    if (depth >= FILTER_LIMITS.depth) {
      issues.push({ nodeId: g.id, message: `Nested deeper than ${FILTER_LIMITS.depth} levels` });
      return null;
    }
    const children: FilterTree[] = [];
    for (const c of g.children) {
      const t = c.kind === 'group' ? group(c, depth + 1) : condition(c);
      if (t) children.push(t);
    }
    return g.join === 'and' ? { and: children } : { or: children };
  };

  const condition = (c: ConditionDraft): FilterTree | null => {
    conditions++;
    const issue = (message: string) => {
      issues.push({ nodeId: c.id, message });
      return null;
    };
    const field = fields.get(c.field);
    if (!field) return issue(c.field ? `Unknown field "${c.field}"` : 'Pick a field');
    if (!field.ops.includes(c.op))
      return issue(`"${OP_LABELS[c.op]}" is not allowed on ${field.label}`);
    const editor = valueEditor(field, c.op);
    switch (editor) {
      case 'none':
        return { field: field.name, op: c.op };
      case 'range': {
        const lo = parseScalar(field, c.value);
        const hi = parseScalar(field, c.to);
        if (lo === undefined || hi === undefined) return issue('Enter both bounds');
        if (typeof lo === 'number' && typeof hi === 'number' && lo > hi)
          return issue('Lower bound is above the upper bound');
        return { field: field.name, op: c.op, value: [lo, hi] };
      }
      case 'enum-list':
      case 'list': {
        const raw = editor === 'enum-list' ? c.values : splitList(c.value);
        if (raw.length === 0) return issue('Pick at least one value');
        if (raw.length > FILTER_LIMITS.inValues)
          return issue(`At most ${FILTER_LIMITS.inValues} values (${raw.length})`);
        const values: (string | number | boolean)[] = [];
        for (const r of raw) {
          const v = parseScalar(field, r);
          if (v === undefined) return issue(`"${r}" is not a ${field.type}`);
          values.push(v);
        }
        return { field: field.name, op: c.op, value: values };
      }
      default: {
        if (c.op === 'contains' && c.value.trim().length < FILTER_LIMITS.containsMin)
          return issue(`"contains" needs at least ${FILTER_LIMITS.containsMin} characters`);
        const v = parseScalar(field, c.value);
        if (v === undefined)
          return issue(c.value.trim() === '' ? 'Enter a value' : `Not a ${field.type}`);
        return { field: field.name, op: c.op, value: v };
      }
    }
  };

  const tree = group(root, 1);
  if (conditions > FILTER_LIMITS.conditions) {
    issues.push({
      nodeId: root.id,
      message: `At most ${FILTER_LIMITS.conditions} conditions (${conditions})`,
    });
  }
  return { tree: issues.length === 0 ? tree : null, issues };
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Parses one editor value for `field`; `undefined` when it is empty or of the wrong type. */
function parseScalar(field: RegistryField, text: string): string | number | boolean | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  if (field.type === 'number') {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  if (field.type === 'boolean') return s === 'true' ? true : s === 'false' ? false : undefined;
  return s;
}
