import { buildGroupingResponse } from './grouping-response.js';
import type { OrderGroupQueryRow } from './order-groups.types.js';

describe('grouping response', () => {
  it('builds depth-first flat nodes and keeps shared orders unique', () => {
    const rows: OrderGroupQueryRow[] = [
      group(1, ['Campaign'], null, 'Campaign', 2),
      group(2, ['Campaign', 'Mission B'], ['Campaign'], 'Mission B', 1),
      group(2, ['Campaign', 'Mission A'], ['Campaign'], 'Mission A', 2),
      order(['Campaign', 'Mission B'], '0002', 'Shared order'),
      order(['Campaign', 'Mission A'], '0001', 'First order'),
      order(['Campaign', 'Mission A'], '0002', 'Shared order'),
    ];

    const response = buildGroupingResponse(rows);

    expect(response.nodes.map(({ id }) => id)).toEqual([
      '["Campaign"]',
      '["Campaign", "Mission A"]',
      '0001',
      '0002',
      '["Campaign", "Mission B"]',
    ]);
    expect(response.nodes[0]?.children).toEqual([
      '["Campaign", "Mission A"]',
      '["Campaign", "Mission B"]',
    ]);
    expect(response.nodes[3]?.parentIds).toEqual([
      '["Campaign", "Mission A"]',
      '["Campaign", "Mission B"]',
    ]);
    expect(response.nodes[4]?.children).toEqual(['0002']);
  });

  it('returns an empty node list for no database rows', () => {
    expect(buildGroupingResponse([])).toEqual({ nodes: [] });
  });
});

function group(
  level: number,
  groupPath: readonly unknown[],
  parentPath: readonly unknown[] | null,
  groupName: string,
  total: number,
): OrderGroupQueryRow {
  return {
    rowKind: 'group', level, groupPath, parentPath, groupName, total,
    orderId: null, orderName: null,
  };
}

function order(
  groupPath: readonly unknown[],
  orderId: string,
  orderName: string,
): OrderGroupQueryRow {
  return {
    rowKind: 'order', level: groupPath.length, groupPath, parentPath: null,
    groupName: null, total: null, orderId, orderName,
  };
}
