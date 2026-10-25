import type {
  GroupingNode,
  GroupingResponse,
  OrderGroupQueryRow,
} from './order-groups.types.js';

interface MutableGroupingNode {
  readonly id: string;
  readonly name: string;
  readonly parentIds: string[];
  readonly total: number;
  readonly children: string[];
}

interface GroupRecord {
  readonly node: MutableGroupingNode;
  readonly childIds: Set<string>;
}

interface OrderNodeRecord {
  readonly id: string;
  readonly name: string;
  readonly parentIds: Set<string>;
}

/** Converts PostgreSQL's flat group and membership rows into display nodes. */
export function buildGroupingResponse(rows: readonly OrderGroupQueryRow[]): GroupingResponse {
  const groups = createGroups(rows);
  connectGroups(groups);
  const orders = createOrders(rows, groups);
  sortGroupChildren(groups);
  return { nodes: orderNodesDepthFirst(groups, orders) };
}

function createGroups(rows: readonly OrderGroupQueryRow[]): Map<string, GroupRecord> {
  const groups = new Map<string, GroupRecord>();
  rows.filter(isGroupRow).forEach((row) => {
    const id = serializeGroupPath(row.groupPath);
    groups.set(id, {
      node: {
        id,
        name: row.groupName ?? 'null',
        parentIds: row.parentPath === null ? [] : [serializeGroupPath(row.parentPath)],
        total: Number(row.total ?? 0),
        children: [],
      },
      childIds: new Set<string>(),
    });
  });
  return groups;
}

function connectGroups(groups: ReadonlyMap<string, GroupRecord>): void {
  groups.forEach(({ node }) => {
    const parentId = node.parentIds[0];
    if (parentId === undefined) return;
    groups.get(parentId)?.childIds.add(node.id);
  });
}

function createOrders(
  rows: readonly OrderGroupQueryRow[],
  groups: ReadonlyMap<string, GroupRecord>,
): Map<string, OrderNodeRecord> {
  const orders = new Map<string, OrderNodeRecord>();
  rows.filter(isOrderRow).forEach((row) => addOrderMembership(row, groups, orders));
  return orders;
}

function addOrderMembership(
  row: OrderGroupQueryRow,
  groups: ReadonlyMap<string, GroupRecord>,
  orders: Map<string, OrderNodeRecord>,
): void {
  if (row.orderId === null || row.orderName === null) return;
  const parentId = serializeGroupPath(row.groupPath);
  groups.get(parentId)?.childIds.add(row.orderId);
  const order = orders.get(row.orderId) ?? createOrderRecord(row.orderId, row.orderName);
  order.parentIds.add(parentId);
  orders.set(row.orderId, order);
}

function createOrderRecord(id: string, name: string): OrderNodeRecord {
  return { id, name, parentIds: new Set<string>() };
}

function sortGroupChildren(groups: ReadonlyMap<string, GroupRecord>): void {
  groups.forEach((group) => group.node.children.push(...[...group.childIds].sort(compareText)));
}

function orderNodesDepthFirst(
  groups: ReadonlyMap<string, GroupRecord>,
  orders: ReadonlyMap<string, OrderNodeRecord>,
): readonly GroupingNode[] {
  const result: GroupingNode[] = [];
  const displayParentByOrder = resolveDisplayParents(orders);
  const roots = [...groups.values()].map(({ node }) => node)
    .filter((group) => group.parentIds.length === 0).sort(compareNodes);
  roots.forEach((root) => appendGroupBranch(root, groups, orders, displayParentByOrder, result));
  return result;
}

function appendGroupBranch(
  group: MutableGroupingNode,
  groups: ReadonlyMap<string, GroupRecord>,
  orders: ReadonlyMap<string, OrderNodeRecord>,
  displayParentByOrder: ReadonlyMap<string, string>,
  result: GroupingNode[],
): void {
  result.push(group);
  group.children.filter((id) => groups.has(id)).forEach((id) => {
    const child = groups.get(id)?.node;
    if (child !== undefined) appendGroupBranch(child, groups, orders, displayParentByOrder, result);
  });
  group.children.filter((id) => displayParentByOrder.get(id) === group.id).forEach((id) => {
    const order = orders.get(id);
    if (order !== undefined) result.push(toGroupingNode(order));
  });
}

function resolveDisplayParents(orders: ReadonlyMap<string, OrderNodeRecord>): Map<string, string> {
  const displayParents = new Map<string, string>();
  orders.forEach((order) => {
    const parentId = [...order.parentIds].sort(compareText)[0];
    if (parentId !== undefined) displayParents.set(order.id, parentId);
  });
  return displayParents;
}

function toGroupingNode(order: OrderNodeRecord): GroupingNode {
  return {
    id: order.id,
    name: order.name,
    parentIds: [...order.parentIds].sort(compareText),
    total: 0,
    children: [],
  };
}

function serializeGroupPath(path: readonly unknown[]): string {
  return `[${path.map((value) => JSON.stringify(value) ?? 'null').join(', ')}]`;
}

function isGroupRow(row: OrderGroupQueryRow): boolean {
  return row.rowKind === 'group';
}

function isOrderRow(row: OrderGroupQueryRow): boolean {
  return row.rowKind === 'order';
}

function compareNodes(left: MutableGroupingNode, right: MutableGroupingNode): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
