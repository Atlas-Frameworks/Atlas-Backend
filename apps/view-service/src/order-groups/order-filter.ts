import { BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { OrderFilterDto } from './dto/order-filter.dto.js';
import { resolveGroupingDimensions, supportsSource, type OrderSource } from './order-grouping-dimension.js';

export enum OrderFilterOperator { EQ = 'EQ', NE = 'NE', GT = 'GT', GTE = 'GTE', LT = 'LT', LTE = 'LTE', IN = 'IN' }

export function applyOrderFilters(query: Knex.QueryBuilder, filters: readonly OrderFilterDto[], source: OrderSource): void {
  filters.forEach((filter) => applyOrderFilter(query, filter, source));
}

function applyOrderFilter(query: Knex.QueryBuilder, filter: OrderFilterDto, source: OrderSource): void {
  const definition = resolveGroupingDimensions([filter.field])[0];
  if (!definition || !supportsSource(definition, source)) throw new BadRequestException(`${filter.field} cannot filter source ${source}`);
  const values = parseFilterValues(filter.value, filter.operator);
  if (filter.operator === OrderFilterOperator.IN) { query.whereIn(definition.column, values); return; }
  const value = values[0];
  if (filter.operator === OrderFilterOperator.EQ) {
    if (value === null) query.whereNull(definition.column);
    else query.where(definition.column, value);
    return;
  }
  if (filter.operator === OrderFilterOperator.NE) { query.whereRaw('?? IS DISTINCT FROM ?', [definition.column, value]); return; }
  if (value === null) throw new BadRequestException(`${filter.operator} does not accept null`);
  const sqlOperator = { GT: '>', GTE: '>=', LT: '<', LTE: '<=' }[filter.operator];
  query.where(definition.column, sqlOperator, value);
}

function parseFilterValues(value: unknown, operator: OrderFilterOperator): readonly (string | number | boolean | null)[] {
  const values = operator === OrderFilterOperator.IN ? value : [value];
  if (!Array.isArray(values) || values.length === 0 || !values.every(isScalar)) {
    throw new BadRequestException(`${operator} requires ${operator === OrderFilterOperator.IN ? 'a non-empty scalar array' : 'a scalar value'}`);
  }
  return values;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
