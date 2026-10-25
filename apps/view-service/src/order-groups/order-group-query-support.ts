import { BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { OrderFilterDto } from './dto/order-filter.dto.js';
import {
  OrderSource,
  supportsSource,
  type GroupingDimensionDefinition,
} from './order-grouping-dimension.js';
import { applyOrderFilters } from './order-filter.js';

export const orderSchema = 'benchmark_publisher';
export type GroupPathValue = string | number | boolean | null;

export interface GroupPathFilter {
  readonly columns: readonly string[];
  readonly path: readonly GroupPathValue[];
}

export interface OrderDomainSelection {
  readonly wCampaignIds: readonly string[];
  readonly wMissionIds: readonly string[];
  readonly wPlanIds: readonly string[];
  readonly aPlanIds: readonly string[];
  readonly aMissionIds: readonly string[];
  readonly aObjectiveIds: readonly string[];
  readonly filters: readonly OrderFilterDto[];
}

export interface OrderOriginRequest {
  readonly wCampaignIds?: readonly string[];
  readonly wMissionIds?: readonly string[];
  readonly wPlanIds?: readonly string[];
  readonly aPlanIds?: readonly string[];
  readonly aMissionIds?: readonly string[];
  readonly aObjectiveIds?: readonly string[];
  readonly filters?: readonly OrderFilterDto[];
}

export interface SourceOrderDomainQuery {
  readonly source: OrderSource;
  readonly query: Knex.QueryBuilder;
}

/** Normalizes optional request origin arrays for query construction. */
export function createOrderDomainSelection(request: OrderOriginRequest): OrderDomainSelection {
  return {
    wCampaignIds: request.wCampaignIds ?? [],
    wMissionIds: request.wMissionIds ?? [],
    wPlanIds: request.wPlanIds ?? [],
    aPlanIds: request.aPlanIds ?? [],
    aMissionIds: request.aMissionIds ?? [],
    aObjectiveIds: request.aObjectiveIds ?? [],
    filters: request.filters ?? [],
  };
}

/** Creates only the relational branches identified by the supplied origin IDs. */
export function buildOrderDomainQueries(
  database: Knex,
  selection: OrderDomainSelection,
): readonly SourceOrderDomainQuery[] {
  return resolveOrderSources(selection).map((source) => ({
    source,
    query: buildSourceOrderDomainQuery(database, selection, source),
  }));
}

/** Infers relevant order branches without requiring a public source discriminator. */
export function resolveOrderSources(selection: OrderDomainSelection): readonly OrderSource[] {
  const sources: OrderSource[] = [];
  if (hasWOrigin(selection)) sources.push(OrderSource.W);
  if (hasAOrigin(selection)) sources.push(OrderSource.A);
  if (sources.length === 0) throw new BadRequestException('At least one A or W origin ID is required');
  return sources;
}

/** Rejects fields that do not exist in every selected hierarchy. */
export function validateDimensionsForSources(
  dimensions: readonly GroupingDimensionDefinition[],
  sources: readonly OrderSource[],
): void {
  if (dimensions.every((dimension) => sources.every((source) => supportsSource(dimension, source)))) return;
  throw new BadRequestException('One or more grouping fields cannot group every selected order origin');
}

/** Creates the JSON path expression used as the stable group identifier. */
export function buildGroupPathExpression(database: Knex, columns: readonly string[]): Knex.Raw {
  const placeholders = columns.map(() => '??').join(', ');
  return database.raw(`jsonb_build_array(${placeholders}) AS full_group_path`, [...columns]);
}

/** Parses and validates the value types of a serialized group path. */
export function parseSerializedGroupPath(pathId: string): readonly GroupPathValue[] {
  let path: unknown;
  try { path = JSON.parse(pathId) as unknown; } catch { throw new BadRequestException(`Group path is not a JSON array: ${pathId}`); }
  if (!Array.isArray(path) || !path.every(isGroupValue)) throw new BadRequestException(`Group path is invalid: ${pathId}`);
  return path;
}

/** Adds a grouped OR condition containing null-safe filters for every path. */
export function applyGroupPathFilters(query: Knex.QueryBuilder, filters: readonly GroupPathFilter[]): void {
  query.where((pathsQuery) => {
    filters.forEach(({ columns, path }) => pathsQuery.orWhere((pathQuery) => applySingleGroupPathFilter(pathQuery, columns, path)));
  });
}

function buildWQuery(database: Knex): Knex.QueryBuilder {
  return database.from({ root: `${orderSchema}.w_campaigns` })
    .join({ w_mission: `${orderSchema}.w_missions` }, 'w_mission.campaign_id', 'root.id')
    .join({ mission_plan: `${orderSchema}.w_mission_plans` }, 'mission_plan.mission_id', 'w_mission.id')
    .join({ w_plan: `${orderSchema}.w_plans` }, 'w_plan.id', 'mission_plan.plan_id')
    .join({ customer_order: `${orderSchema}.orders` }, 'customer_order.w_plan_id', 'w_plan.id');
}

function buildAQuery(database: Knex): Knex.QueryBuilder {
  return database.from({ root: `${orderSchema}.a_plans` })
    .join({ a_mission: `${orderSchema}.a_missions` }, 'a_mission.a_plan_id', 'root.id')
    .join({ a_objective: `${orderSchema}.a_objectives` }, function joinObjective() {
      this.on('a_objective.a_mission_id', '=', 'a_mission.id').andOn('a_objective.a_plan_id', '=', 'root.id');
    })
    .join({ customer_order: `${orderSchema}.orders` }, 'customer_order.a_objective_id', 'a_objective.id');
}

function buildSourceOrderDomainQuery(
  database: Knex,
  selection: OrderDomainSelection,
  source: OrderSource,
): Knex.QueryBuilder {
  const query = source === OrderSource.W ? buildWQuery(database) : buildAQuery(database);
  applyOriginFilters(query, selection, source);
  query.where('customer_order.source', source);
  applyOrderFilters(query, selection.filters, source);
  return query;
}

function applyOriginFilters(query: Knex.QueryBuilder, selection: OrderDomainSelection, source: OrderSource): void {
  if (source === OrderSource.W) {
    applyWhereIn(query, 'root.id', selection.wCampaignIds);
    applyWhereIn(query, 'w_mission.id', selection.wMissionIds);
    applyWhereIn(query, 'w_plan.id', selection.wPlanIds);
    return;
  }
  applyWhereIn(query, 'root.id', selection.aPlanIds);
  applyWhereIn(query, 'a_mission.id', selection.aMissionIds);
  applyWhereIn(query, 'a_objective.id', selection.aObjectiveIds);
}

function applyWhereIn(query: Knex.QueryBuilder, column: string, values: readonly string[]): void {
  if (values.length > 0) query.whereIn(column, values);
}

function hasWOrigin(selection: OrderDomainSelection): boolean {
  return selection.wCampaignIds.length > 0 || selection.wMissionIds.length > 0 || selection.wPlanIds.length > 0;
}

function hasAOrigin(selection: OrderDomainSelection): boolean {
  return selection.aPlanIds.length > 0 || selection.aMissionIds.length > 0 || selection.aObjectiveIds.length > 0;
}

function applySingleGroupPathFilter(query: Knex.QueryBuilder, columns: readonly string[], path: readonly GroupPathValue[]): void {
  columns.forEach((column, index) => {
    const value = path[index];
    if (value === undefined) throw new BadRequestException('Group path is shorter than its columns');
    query.whereRaw('?? IS NOT DISTINCT FROM ?', [column, value]);
  });
}

function isGroupValue(value: unknown): value is GroupPathValue {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
