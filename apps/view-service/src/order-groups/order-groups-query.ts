import { BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import { OrderGroupsRequestDto } from './dto/order-groups-request.dto.js';
import { resolveGroupingDimensions } from './order-grouping-dimension.js';
import type { GroupingDimensionDefinition } from './order-grouping-dimension.js';
import {
  buildOrderDomainQueries,
  buildGroupPathExpression,
  createOrderDomainSelection,
  parseSerializedGroupPath,
  resolveOrderSources,
  validateDimensionsForSources,
} from './order-group-query-support.js';
import type { OrderDomainSelection } from './order-group-query-support.js';
import type {
  OrderGroupQueryRow,
  PaginationOverride,
} from './order-groups.types.js';

interface PaginationValues {
  readonly limit: number;
  readonly offset: number;
}

const maximumPageSize = 1000;
const maximumPostgresInteger = 2_147_483_647;

/** Returns flat group rows and paginated leaf-order memberships. */
export function buildOrderGroupsQuery(
  database: Knex,
  request: OrderGroupsRequestDto,
): Knex.QueryBuilder<Record<string, never>, OrderGroupQueryRow[]> {
  const dimensions = resolveGroupingDimensions(request.groupBy);
  const selection = createOrderDomainSelection(request);
  validateDimensionsForSources(dimensions, resolveOrderSources(selection));
  const pathLength = dimensions.length + 1;
  const pagination = parsePaginationOverrides(request.pagination, pathLength);
  const resultRows = buildResultRows(database, pathLength);
  return database
    .with('memberships', buildMemberships(database, selection, dimensions))
    .with('node_counts', buildNodeCounts(database, pathLength))
    .with('pagination_overrides', buildPaginationOverrides(database, pagination))
    .with('ranked_leaf_orders', buildRankedLeafOrders(database, request.defaultLimit))
    .with('paginated_leaf_orders', buildPaginatedLeafOrders(database))
    .select('*')
    .from(resultRows.as('result_row'));
}

/** Parses and validates pagination overrides keyed by serialized leaf path. */
export function parsePaginationOverrides(
  value: Record<string, unknown> | undefined,
  pathLength: number,
): readonly PaginationOverride[] {
  if (value === undefined) return [];
  const paths = new Set<string>();
  return Object.entries(value).map(([pathId, page]) => {
    const path = parsePath(pathId, pathLength);
    const canonicalPath = JSON.stringify(path);
    if (paths.has(canonicalPath)) throw new BadRequestException(`Pagination path is duplicated: ${pathId}`);
    paths.add(canonicalPath);
    return { path, ...parsePaginationValues(page, pathId) };
  });
}

/** Selects unique order-to-leaf memberships for the requested root. */
function buildMemberships(
  database: Knex,
  selection: OrderDomainSelection,
  dimensions: readonly GroupingDimensionDefinition[],
): Knex.QueryBuilder {
  const pathColumns = ['root.name', ...dimensions.map(({ column }) => column)];
  const sourceQueries = buildOrderDomainQueries(database, selection).map(({ query }) => query
    .select({ order_id: 'customer_order.id', order_name: 'customer_order.name' })
    .select(buildGroupPathExpression(database, pathColumns)));
  const combinedMemberships = database.queryBuilder().unionAll(sourceQueries, true);
  return database.from(combinedMemberships.as('origin_membership')).distinct(
    'origin_membership.order_id',
    'origin_membership.order_name',
    'origin_membership.full_group_path',
  );
}

/** Counts each hierarchy depth directly from the filtered memberships. */
function buildNodeCounts(database: Knex, pathLength: number): Knex.QueryBuilder {
  const levels = Array.from({ length: pathLength }, (_, index) => index + 1);
  const queries = levels.map((level) => buildNodeCountLevel(database, level));
  if (queries.length === 0) throw new BadRequestException('At least one grouping level is required');
  return database.queryBuilder().unionAll(queries, true);
}

/** Counts distinct orders for one fixed path depth. */
function buildNodeCountLevel(database: Knex, level: number): Knex.QueryBuilder {
  const pathValueExpressions = Array.from({ length: level }, () => '?? -> (?::integer)').join(', ');
  const pathBindings = Array.from({ length: level }, (_, index) => ['membership.full_group_path', index]).flat();
  const membershipsAtLevel = database.from({ membership: 'memberships' }).distinct().select(
    'membership.order_id',
    database.raw('?::integer AS level', [level]),
    database.raw(`jsonb_build_array(${pathValueExpressions}) AS group_path`, pathBindings),
    database.raw('?? -> (?::integer) AS group_name', ['membership.full_group_path', level - 1]),
  );
  return database.from(membershipsAtLevel.as('node_membership'))
    .select('node_membership.level', 'node_membership.group_path', 'node_membership.group_name')
    .count({ total: 'node_membership.order_id' })
    .groupBy('node_membership.level', 'node_membership.group_path', 'node_membership.group_name');
}

/** Converts validated pagination overrides into a queryable relation. */
function buildPaginationOverrides(
  database: Knex,
  pagination: readonly PaginationOverride[],
): Knex.QueryBuilder {
  return database.from(database.raw('jsonb_array_elements(?::jsonb) AS page_override(value)', [JSON.stringify(pagination)]))
    .select(
      database.raw("page_override.value -> 'path' AS group_path"),
      database.raw("(page_override.value ->> 'limit')::integer AS page_limit"),
      database.raw("(page_override.value ->> 'offset')::integer AS page_offset"),
    );
}

/** Ranks orders only inside their leaf and attaches its page settings. */
function buildRankedLeafOrders(database: Knex, defaultLimit: number): Knex.QueryBuilder {
  return database.from({ leaf: 'memberships' })
    .leftJoin({ page_override: 'pagination_overrides' }, 'page_override.group_path', 'leaf.full_group_path')
    .select({ group_path: 'leaf.full_group_path' }, 'leaf.order_id', 'leaf.order_name')
    .select(
      database.raw('row_number() OVER (PARTITION BY ?? ORDER BY ??) AS row_number', ['leaf.full_group_path', 'leaf.order_id']),
      database.raw('COALESCE(??, ?) AS page_limit', ['page_override.page_limit', defaultLimit]),
      database.raw('COALESCE(??, 0) AS page_offset', ['page_override.page_offset']),
    );
}

/** Selects only the orders inside each leaf's requested page. */
function buildPaginatedLeafOrders(database: Knex): Knex.QueryBuilder {
  return database.from({ ranked_order: 'ranked_leaf_orders' })
    .whereRaw('?? > ?? AND ?? <= ?? + ??', [
      'ranked_order.row_number', 'ranked_order.page_offset',
      'ranked_order.row_number', 'ranked_order.page_offset', 'ranked_order.page_limit',
    ])
    .select('ranked_order.group_path', 'ranked_order.order_id', 'ranked_order.order_name');
}

/** Unifies group rows and order memberships without constructing response JSON. */
function buildResultRows(database: Knex, leafLevel: number): Knex.QueryBuilder {
  return buildGroupRows(database).unionAll(buildOrderMembershipRows(database, leafLevel));
}

/** Returns one flat row for every unique group path. */
function buildGroupRows(database: Knex): Knex.QueryBuilder {
  return database.from({ node: 'node_counts' }).select(
    database.raw("'group'::text AS ??", ['rowKind']),
    { level: 'node.level', groupPath: 'node.group_path' },
    database.raw('CASE WHEN ?? = 1 THEN NULL::jsonb ELSE ?? - (?? - 1) END AS ??', [
      'node.level', 'node.group_path', 'node.level', 'parentPath',
    ]),
    database.raw("COALESCE(?? #>> '{}', 'null') AS ??", ['node.group_name', 'groupName']),
    { total: 'node.total' },
    database.raw('NULL::uuid AS ??', ['orderId']),
    database.raw('NULL::text AS ??', ['orderName']),
  );
}

/** Returns one row per paginated order-to-leaf membership. */
function buildOrderMembershipRows(database: Knex, leafLevel: number): Knex.QueryBuilder {
  return database.from({ leaf_order: 'paginated_leaf_orders' }).select(
    database.raw("'order'::text AS ??", ['rowKind']),
    database.raw('?::integer AS ??', [leafLevel, 'level']),
    { groupPath: 'leaf_order.group_path' },
    database.raw('NULL::jsonb AS ??', ['parentPath']),
    database.raw('NULL::text AS ??', ['groupName']),
    database.raw('NULL::bigint AS ??', ['total']),
    { orderId: 'leaf_order.order_id', orderName: 'leaf_order.order_name' },
  );
}

function parsePath(pathId: string, expectedLength: number): readonly unknown[] {
  const path = parseSerializedGroupPath(pathId);
  if (path.length === expectedLength) return path;
  throw new BadRequestException(`Pagination key must contain ${expectedLength} path values: ${pathId}`);
}

function parsePaginationValues(value: unknown, pathId: string): PaginationValues {
  if (!isRecord(value)) throw new BadRequestException(`Pagination value must be an object: ${pathId}`);
  const limit = value['limit'];
  const offset = value['offset'];
  if (!isIntegerInRange(limit, 1, maximumPageSize)) {
    throw new BadRequestException(`Pagination limit must be between 1 and ${maximumPageSize}: ${pathId}`);
  }
  if (!isIntegerInRange(offset, 0, maximumPostgresInteger)) {
    throw new BadRequestException(`Pagination offset must be non-negative: ${pathId}`);
  }
  return { limit, offset };
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
