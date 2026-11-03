import { buildGroupingResponse } from './grouping-response.js';
import type { GroupPath } from './order-group-query-support.js';
import type { OrderGroupQueryRow } from './order-groups.types.js';

describe('grouping response', () => {
  it('builds depth-first flat nodes under the root and keeps shared orders unique', () => {
    const rows: OrderGroupQueryRow[] = [
      root(2),
      group({ W_MISSION_NAME: 'Mission B' }, null, 'Mission B', 1),
      group({ W_MISSION_NAME: 'Mission A' }, null, 'Mission A', 2),
      order({ W_MISSION_NAME: 'Mission B' }, '0002', 'Shared order'),
      order({ W_MISSION_NAME: 'Mission A' }, '0001', 'First order'),
      order({ W_MISSION_NAME: 'Mission A' }, '0002', 'Shared order'),
    ];

    const response = buildGroupingResponse(rows);

    expect(response.nodes.map(({ id }) => id)).toEqual([
      'root',
      '{"W_MISSION_NAME":"Mission A"}',
      '0001',
      '0002',
      '{"W_MISSION_NAME":"Mission B"}',
    ]);
    expect(response.nodes[0]).toEqual({
      id: 'root', path: {}, name: 'root', parentIds: [], total: 2,
      children: ['{"W_MISSION_NAME":"Mission A"}', '{"W_MISSION_NAME":"Mission B"}'],
    });
    expect(response.nodes[1]?.parentIds).toEqual(['root']);
    expect(response.nodes[3]?.parentIds).toEqual([
      '{"W_MISSION_NAME":"Mission A"}',
      '{"W_MISSION_NAME":"Mission B"}',
    ]);
    expect(response.nodes[4]?.children).toEqual(['0002']);
  });

  it('nests deeper groups under their parent path', () => {
    const response = buildGroupingResponse([
      root(1),
      group({ ORDER_STATUS: 'DONE' }, null, 'DONE', 1),
      group({ ORDER_STATUS: 'DONE', ORDER_COUNTRY: null }, { ORDER_STATUS: 'DONE' }, 'null', 1),
      order({ ORDER_STATUS: 'DONE', ORDER_COUNTRY: null }, '0001', 'First order'),
    ]);

    expect(response.nodes.map(({ id }) => id)).toEqual([
      'root',
      '{"ORDER_STATUS":"DONE"}',
      '{"ORDER_COUNTRY":null,"ORDER_STATUS":"DONE"}',
      '0001',
    ]);
    expect(response.nodes[2]?.parentIds).toEqual(['{"ORDER_STATUS":"DONE"}']);
  });

  it('puts orders directly under the root when nothing is grouped', () => {
    const response = buildGroupingResponse([root(2), order({}, '0002', 'Second order'), order({}, '0001', 'First order')]);

    expect(response.nodes.map(({ id }) => id)).toEqual(['root', '0001', '0002']);
    expect(response.nodes[0]?.children).toEqual(['0001', '0002']);
    expect(response.nodes[1]?.parentIds).toEqual(['root']);
  });

  it('returns only an empty root node for no database rows', () => {
    expect(buildGroupingResponse([])).toEqual({
      nodes: [{ id: 'root', path: {}, name: 'root', parentIds: [], total: 0, children: [] }],
    });
  });
});

function root(total: number): OrderGroupQueryRow {
  return {
    rowKind: 'root', level: 0, groupPath: {}, parentPath: null, groupName: null, total,
    orderId: null, orderName: null,
  };
}

function group(
  groupPath: GroupPath,
  parentPath: GroupPath | null,
  groupName: string,
  total: number,
): OrderGroupQueryRow {
  return {
    rowKind: 'group', level: Object.keys(groupPath).length, groupPath, parentPath, groupName, total,
    orderId: null, orderName: null,
  };
}

function order(
  groupPath: GroupPath,
  orderId: string,
  orderName: string,
): OrderGroupQueryRow {
  return {
    rowKind: 'order', level: Object.keys(groupPath).length, groupPath, parentPath: null,
    groupName: null, total: null, orderId, orderName,
  };
}
