import { BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import { GroupOrdersRequestDto } from './dto/group-orders-request.dto.js';
import { resolveGroupingDimensions, type GroupingDimensionDefinition } from './order-grouping-dimension.js';
import {
  applyGroupPathFilters,
  buildOrderDomainQueries,
  createOrderDomainSelection,
  resolveOrderSources,
  type GroupPathFilter,
  type GroupPathValue,
  type OrderDomainSelection,
  parseSerializedGroupPath,
  validateDimensionsForSources,
} from './order-group-query-support.js';
import type { GroupOrder } from './order-groups.types.js';

interface OrderSelection {
  readonly origin: OrderDomainSelection;
  readonly dimensions: readonly GroupingDimensionDefinition[];
  readonly paths: readonly (readonly GroupPathValue[])[];
  readonly orderIds: readonly string[];
}

/** Builds a direct query for included orders minus explicit and group exclusions. */
export function buildGroupOrdersQuery(
  database: Knex,
  request: GroupOrdersRequestDto,
): Knex.QueryBuilder<Record<string, never>, GroupOrder[]> {
  const dimensions = resolveGroupingDimensions(request.groupBy);
  const origin = createOrderDomainSelection(request);
  validateDimensionsForSources(dimensions, resolveOrderSources(origin));
  const maximumDepth = dimensions.length + 1;
  const includedPaths = parseGroupPaths(request.groupIds, maximumDepth);
  assertIncludedPaths(includedPaths);
  const includedOrders = buildOrderSelectionQuery(database, {
    origin, dimensions, paths: includedPaths, orderIds: request.findNodes ?? [],
  });
  const excludedPaths = parseGroupPaths(request.excludeGroups ?? [], maximumDepth);
  if (excludedPaths.length === 0) {
    if ((request.excludeNodes ?? []).length > 0) includedOrders.whereNotIn('origin_order.id', request.excludeNodes);
    return includedOrders;
  }
  const excludedOrders = buildOrderSelectionQuery(database, {
    origin, dimensions, paths: excludedPaths, orderIds: request.excludeNodes ?? [],
  });
  return subtractExcludedOrders(database, includedOrders, excludedOrders);
}

/** Builds one root-scoped distinct order set from group paths and order IDs. */
function buildOrderSelectionQuery(
  database: Knex,
  selection: OrderSelection,
): Knex.QueryBuilder<Record<string, never>, GroupOrder[]> {
  const queries = buildOrderDomainQueries(database, selection.origin).map(({ query }) => {
    const filters = createGroupPathFilters(selection.paths, selection.dimensions);
    applyOrderSelectionFilters(query, filters, selection.orderIds);
    return query.distinct(orderColumns());
  });
  const combinedOrders = database.queryBuilder().unionAll(queries, true);
  return database.from(combinedOrders.as('origin_order')).distinct(
    Object.keys(orderColumns()).map((column) => `origin_order.${column}`),
  );
}

/** Applies union semantics between selected group paths and explicit order IDs. */
function applyOrderSelectionFilters(
  query: Knex.QueryBuilder,
  filters: readonly GroupPathFilter[],
  orderIds: readonly string[],
): void {
  query.where((selectionQuery) => {
    if (filters.length > 0) selectionQuery.orWhere((pathQuery) => applyGroupPathFilters(pathQuery, filters));
    if (orderIds.length > 0) selectionQuery.orWhereIn('customer_order.id', orderIds);
  });
}

/** Removes the excluded order set with an anti-join executed by PostgreSQL. */
function subtractExcludedOrders(
  database: Knex,
  includedOrders: Knex.QueryBuilder,
  excludedOrders: Knex.QueryBuilder,
): Knex.QueryBuilder<Record<string, never>, GroupOrder[]> {
  return database.with('included_orders', includedOrders).with('excluded_orders', excludedOrders)
    .from({ included_order: 'included_orders' })
    .leftJoin({ excluded_order: 'excluded_orders' }, 'excluded_order.id', 'included_order.id')
    .whereNull('excluded_order.id')
    .select(Object.keys(orderColumns()).map((column) => `included_order.${column}`));
}

function orderColumns(): Record<keyof GroupOrder, string> {
  return {
    id: 'customer_order.id', name: 'customer_order.name', number: 'customer_order.number',
    status: 'customer_order.status', country: 'customer_order.country', priority: 'customer_order.priority',
    amount: 'customer_order.amount', category: 'customer_order.category',
  };
}

function parseGroupPaths(groupIds: readonly string[], maximumDepth: number): readonly (readonly GroupPathValue[])[] {
  return groupIds.map((groupId) => {
    const path = parseSerializedGroupPath(groupId);
    if (path.length < 1 || path.length > maximumDepth) {
      throw new BadRequestException(`Group path must contain between 1 and ${maximumDepth} values`);
    }
    return path;
  });
}

function assertIncludedPaths(paths: readonly (readonly GroupPathValue[])[]): void {
  if (paths.length === 0) throw new BadRequestException('At least one group ID is required');
}

function createGroupPathFilters(
  paths: readonly (readonly GroupPathValue[])[],
  dimensions: readonly GroupingDimensionDefinition[],
): readonly GroupPathFilter[] {
  return paths.map((path) => ({
    columns: ['root.name', ...dimensions.slice(0, path.length - 1).map(({ column }) => column)],
    path,
  }));
}
