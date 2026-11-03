import { BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import { OrderGroupsRequestDto } from './dto/order-groups-request.dto.js';
import type { GroupPaginationDto } from './dto/group-pagination.dto.js';
import { resolveGroupingDimensions } from './order-grouping-dimension.js';
import type {
  OrderGroupingDimension,
  ResolvedGroupingDimension,
} from './order-grouping-dimension.js';
import {
  buildOrderDomainQueries,
  buildGroupPathExpression,
  createOrderDomainSelection,
  parseGroupPath,
  resolveOrderSources,
  validateDimensionsForSources,
} from './order-group-query-support.js';
import type { OrderDomainSelection } from './order-group-query-support.js';
import type {
  OrderGroupQueryRow,
  PaginationOverride,
} from './order-groups.types.js';

/** Returns the root total, flat group rows and paginated leaf-order memberships. */
export function buildOrderGroupsQuery(
  database: Knex,
  request: OrderGroupsRequestDto,
): Knex.QueryBuilder<Record<string, never>, OrderGroupQueryRow[]> {
  const dimensions = resolveGroupingDimensions(request.groupBy);
  const selection = createOrderDomainSelection(request);
  validateDimensionsForSources(dimensions, resolveOrderSources(selection));
  const pagination = parsePaginationOverrides(request.pagination, request.groupBy);
  const resultRows = buildResultRows(database, dimensions);
  const query = database.with('memberships', buildMemberships(database, selection, dimensions));
  if (dimensions.length > 0) query.with('node_counts', buildNodeCounts(database, dimensions));
  return query
    .with('pagination_overrides', buildPaginationOverrides(database, pagination))
    .with('ranked_leaf_orders', buildRankedLeafOrders(database, request.defaultLimit))
    .with('paginated_leaf_orders', buildPaginatedLeafOrders(database))
    .select('*')
    .from(resultRows.as('result_row'));
}

/** Parses and validates pagination overrides keyed by serialized leaf path. */
export function parsePaginationOverrides(
  value: readonly GroupPaginationDto[] | undefined,
  fields: readonly OrderGroupingDimension[],
): readonly PaginationOverride[] {
  if (value === undefined) return [];
  const paths = new Set<string>();
  return value.map((page) => {
    const path = parsePath(page.path, fields);
    const canonicalPath = serializePath(path);
    if (paths.has(canonicalPath)) throw new BadRequestException(`Pagination path is duplicated: ${canonicalPath}`);
    paths.add(canonicalPath);
    return { path, limit: page.limit, offset: page.offset };
  });
}

/** Selects unique order-to-leaf memberships; the path holds only the requested dimensions. */
function buildMemberships(
  database: Knex,
  selection: OrderDomainSelection,
  dimensions: readonly ResolvedGroupingDimension[],
): Knex.QueryBuilder {
  const sourceQueries = buildOrderDomainQueries(database, selection, dimensions).map(({ query }) => query
    .select({ order_id: 'customer_order.id', order_name: 'customer_order.name' })
    .select(buildGroupPathExpression(database, dimensions)));
  const combinedMemberships = database.queryBuilder().unionAll(sourceQueries, true);
  return database.from(combinedMemberships.as('origin_membership')).distinct(
    'origin_membership.order_id',
    'origin_membership.order_name',
    'origin_membership.full_group_path',
  );
}

/** Counts each hierarchy depth directly from the filtered memberships. */
function buildNodeCounts(database: Knex, dimensions: readonly ResolvedGroupingDimension[]): Knex.QueryBuilder {
  const levels = dimensions.map((_, index) => index + 1);
  const queries = levels.map((level) => buildNodeCountLevel(database, dimensions.slice(0, level)));
  if (queries.length === 0) throw new BadRequestException('At least one grouping level is required');
  return database.queryBuilder().unionAll(queries, true);
}

/** Counts distinct orders for one fixed path depth. */
function buildNodeCountLevel(
  database: Knex,
  dimensions: readonly ResolvedGroupingDimension[],
): Knex.QueryBuilder {
  const level = dimensions.length;
  const pathValueExpressions = dimensions.map(() => '?::text, ?? -> (?::text)').join(', ');
  const pathBindings = dimensions.flatMap(({ field }) => [field, 'membership.full_group_path', field]);
  const currentField = dimensions.at(-1)?.field;
  if (currentField === undefined) throw new BadRequestException('A group level requires at least one field');
  const membershipsAtLevel = database.from({ membership: 'memberships' }).distinct().select(
    'membership.order_id',
    database.raw('?::integer AS level', [level]),
    database.raw(`jsonb_build_object(${pathValueExpressions}) AS group_path`, pathBindings),
    database.raw('?::text AS group_field', [currentField]),
    database.raw('?? -> (?::text) AS group_name', ['membership.full_group_path', currentField]),
  );
  return database.from(membershipsAtLevel.as('node_membership'))
    .select(
      'node_membership.level',
      'node_membership.group_path',
      'node_membership.group_field',
      'node_membership.group_name',
    )
    .count({ total: 'node_membership.order_id' })
    .groupBy(
      'node_membership.level',
      'node_membership.group_path',
      'node_membership.group_field',
      'node_membership.group_name',
    );
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

/** Unifies the root total, group rows and order memberships without constructing response JSON. */
function buildResultRows(database: Knex, dimensions: readonly ResolvedGroupingDimension[]): Knex.QueryBuilder {
  const groupRows = dimensions.length > 0 ? [buildGroupRows(database)] : [];
  return buildRootTotalRow(database).unionAll([...groupRows, buildOrderMembershipRows(database, dimensions.length)]);
}

/** Returns the distinct order count for the root node that the response adds itself. */
function buildRootTotalRow(database: Knex): Knex.QueryBuilder {
  return database.from({ membership: 'memberships' }).select(
    database.raw("'root'::text AS ??", ['rowKind']),
    database.raw('0::integer AS ??', ['level']),
    database.raw("'{}'::jsonb AS ??", ['groupPath']),
    database.raw('NULL::jsonb AS ??', ['parentPath']),
    database.raw('NULL::text AS ??', ['groupName']),
    database.raw('count(DISTINCT ??) AS ??', ['membership.order_id', 'total']),
    database.raw('NULL::uuid AS ??', ['orderId']),
    database.raw('NULL::text AS ??', ['orderName']),
  );
}

/** Returns one flat row for every unique group path below the root. */
function buildGroupRows(database: Knex): Knex.QueryBuilder {
  return database.from({ node: 'node_counts' }).select(
    database.raw("'group'::text AS ??", ['rowKind']),
    { level: 'node.level', groupPath: 'node.group_path' },
    database.raw('CASE WHEN ?? = 1 THEN NULL::jsonb ELSE ?? - ?? END AS ??', [
      'node.level', 'node.group_path', 'node.group_field', 'parentPath',
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

function parsePath(value: unknown, fields: readonly OrderGroupingDimension[]): PaginationOverride['path'] {
  const path = parseGroupPath(value);
  if (hasExactlyFields(path, fields)) return path;
  throw new BadRequestException(`Pagination path must contain fields: ${fields.join(', ')}`);
}

function hasExactlyFields(path: PaginationOverride['path'], fields: readonly OrderGroupingDimension[]): boolean {
  const pathFields = Object.keys(path);
  return pathFields.length === fields.length && fields.every((field) => Object.hasOwn(path, field));
}

function serializePath(path: PaginationOverride['path']): string {
  return JSON.stringify(Object.fromEntries(Object.entries(path).sort(([left], [right]) => left.localeCompare(right))));
}
