import {
  FILTER_LIMITS,
  MAX_GROUP_DEPTH,
  buildFilter,
  emptyGroup,
  newCondition,
  valueEditor,
} from './filter-model';
import type { ConditionDraft, FilterDraft, GroupDraft } from './filter-model';
import { parseRegistry } from './registry';
import type { RegistryField, RegistryType } from './registry';

const STRING_OPS = ['eq', 'neq', 'in', 'nin', 'contains', 'isNull', 'notNull'] as const;
const NUMBER_OPS = [
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
] as const;

const AIRPLANES: RegistryType = parseRegistry({
  types: [
    {
      type: 'airplanes',
      label: 'Airplanes',
      map: true,
      defaultSort: 'callsign',
      fields: [
        { name: 'callsign', label: 'Callsign', type: 'string', ops: STRING_OPS, sortable: true },
        {
          name: 'airline',
          label: 'Airline',
          type: 'string',
          ops: STRING_OPS,
          groupable: true,
          values: ['LY', 'BA'],
        },
        {
          name: 'aircraftKind',
          label: 'Aircraft',
          type: 'string',
          ops: STRING_OPS,
          values: ['B738', 'B789', 'A320'],
        },
        { name: 'airport.runwayCount', label: 'Runways', type: 'number', ops: NUMBER_OPS },
        { name: 'onGround', label: 'On ground', type: 'boolean', ops: ['eq', 'bogus'] },
      ],
    },
  ],
})[0];

const field = (name: string): RegistryField => AIRPLANES.fields.find((f) => f.name === name)!;

function cond(
  name: string,
  op: ConditionDraft['op'],
  patch: Partial<ConditionDraft> = {},
): ConditionDraft {
  return { ...newCondition(field(name)), op, ...patch };
}

function group(join: 'and' | 'or', ...children: FilterDraft[]): GroupDraft {
  return { ...emptyGroup(join), children };
}

describe('parseRegistry', () => {
  it('keeps known operators and optional enum values', () => {
    expect(field('onGround').ops).toEqual(['eq']);
    expect(field('airline')).toMatchObject({
      groupable: true,
      sortable: false,
      values: ['LY', 'BA'],
    });
    expect(field('callsign').values).toBeUndefined();
  });

  it('rejects a body without types', () => {
    expect(() => parseRegistry({})).toThrow(/types/);
  });
});

const many = (n: number) =>
  group('and', ...Array.from({ length: n }, () => cond('callsign', 'eq', { value: 'x' })));
const list = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`).join(',');

describe('buildFilter', () => {
  it('produces the contracts §5 example tree', () => {
    const draft = group(
      'and',
      cond('airline', 'eq', { value: 'LY' }),
      cond('airport.runwayCount', 'gte', { value: '3' }),
      group(
        'or',
        cond('callsign', 'contains', { value: 'LY0' }),
        cond('aircraftKind', 'in', { values: ['B738', 'B789'] }),
      ),
    );
    const { tree, issues } = buildFilter(draft, AIRPLANES);
    expect(issues).toEqual([]);
    expect(tree).toEqual({
      and: [
        { field: 'airline', op: 'eq', value: 'LY' },
        { field: 'airport.runwayCount', op: 'gte', value: 3 },
        {
          or: [
            { field: 'callsign', op: 'contains', value: 'LY0' },
            { field: 'aircraftKind', op: 'in', value: ['B738', 'B789'] },
          ],
        },
      ],
    });
  });

  it('is null for an empty root and has no value for isNull / notNull', () => {
    expect(buildFilter(emptyGroup(), AIRPLANES)).toEqual({ tree: null, issues: [] });
    expect(
      buildFilter(group('or', cond('callsign', 'isNull', { value: 'x' })), AIRPLANES).tree,
    ).toEqual({
      or: [{ field: 'callsign', op: 'isNull' }],
    });
  });

  it('parses numbers, booleans, between and comma lists', () => {
    const { tree } = buildFilter(
      group(
        'and',
        cond('airport.runwayCount', 'between', { value: '2', to: ' 4 ' }),
        cond('airport.runwayCount', 'nin', { value: '1, 2,,3' }),
        cond('callsign', 'in', { value: 'LY001, BA002' }),
        cond('onGround', 'eq', { value: 'false' }),
      ),
      AIRPLANES,
    );
    expect(tree).toEqual({
      and: [
        { field: 'airport.runwayCount', op: 'between', value: [2, 4] },
        { field: 'airport.runwayCount', op: 'nin', value: [1, 2, 3] },
        { field: 'callsign', op: 'in', value: ['LY001', 'BA002'] },
        { field: 'onGround', op: 'eq', value: false },
      ],
    });
  });

  it('enforces the depth limit (4 levels: root, two nested groups, conditions)', () => {
    const leaf = cond('callsign', 'eq', { value: 'LY001' });
    const ok = group('and', group('or', group('and', leaf)));
    expect(buildFilter(ok, AIRPLANES).issues).toEqual([]);
    expect(MAX_GROUP_DEPTH).toBe(3);

    const tooDeep = group('and', group('or', group('and', group('or', leaf))));
    const { tree, issues } = buildFilter(tooDeep, AIRPLANES);
    expect(tree).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/deeper than 4/);
  });

  it('enforces at most 20 conditions', () => {
    expect(buildFilter(many(FILTER_LIMITS.conditions), AIRPLANES).issues).toEqual([]);
    const over = many(FILTER_LIMITS.conditions + 1);
    expect(buildFilter(over, AIRPLANES).issues).toEqual([
      { nodeId: over.id, message: 'At most 20 conditions (21)' },
    ]);
  });

  it('enforces at most 200 values for in / nin', () => {
    expect(
      buildFilter(group('and', cond('callsign', 'in', { value: list(200) })), AIRPLANES).issues,
    ).toEqual([]);
    const c = cond('callsign', 'nin', { value: list(201) });
    expect(buildFilter(group('and', c), AIRPLANES).issues).toEqual([
      { nodeId: c.id, message: 'At most 200 values (201)' },
    ]);
  });

  it('reports each invalid condition against its node', () => {
    const short = cond('callsign', 'contains', { value: 'LY' });
    const nan = cond('airport.runwayCount', 'gt', { value: 'three' });
    const empty = cond('airline', 'in');
    const range = cond('airport.runwayCount', 'between', { value: '5', to: '1' });
    const op = cond('airline', 'gt', { value: 'LY' });
    const unknown: ConditionDraft = { ...cond('callsign', 'eq', { value: 'x' }), field: 'nope' };
    const hollow = group('or');
    const { tree, issues } = buildFilter(
      group('and', short, nan, empty, range, op, unknown, hollow),
      AIRPLANES,
    );
    expect(tree).toBeNull();
    expect(new Map(issues.map((i) => [i.nodeId, i.message]))).toEqual(
      new Map([
        [short.id, '"contains" needs at least 3 characters'],
        [nan.id, 'Not a number'],
        [empty.id, 'Pick at least one value'],
        [range.id, 'Lower bound is above the upper bound'],
        [op.id, '">" is not allowed on Airline'],
        [unknown.id, 'Unknown field "nope"'],
        [hollow.id, 'Empty group'],
      ]),
    );
  });
});

describe('valueEditor', () => {
  it('picks an editor from the field type, its values and the operator', () => {
    expect(valueEditor(field('airline'), 'eq')).toBe('enum');
    expect(valueEditor(field('airline'), 'in')).toBe('enum-list');
    expect(valueEditor(field('airline'), 'contains')).toBe('single');
    expect(valueEditor(field('callsign'), 'nin')).toBe('list');
    expect(valueEditor(field('airport.runwayCount'), 'between')).toBe('range');
    expect(valueEditor(field('onGround'), 'eq')).toBe('boolean');
    expect(valueEditor(field('callsign'), 'notNull')).toBe('none');
  });
});
