import { BadRequestException } from '@nestjs/common';
import knex from 'knex';
import type { Knex } from 'knex';
import { GroupOrdersRequestDto } from './dto/group-orders-request.dto.js';
import { buildGroupOrdersQuery } from './group-orders-query.js';
import { OrderGroupingDimension } from './order-grouping-dimension.js';

describe('group orders query', () => {
  let database: Knex;
  beforeEach(() => { database = knex({ client: 'pg' }); });
  afterEach(() => database.destroy());

  it('filters any W group depth and selects rich order fields without pagination', () => {
    const request = createRequest([OrderGroupingDimension.W_MISSION_NAME, OrderGroupingDimension.ORDER_STATUS]);
    request.groupIds = ['["W Campaign Alpha","W Mission North"]'];
    const statement = buildGroupOrdersQuery(database, request).toSQL();
    expect(statement.sql).toContain('"w_mission"."name" IS NOT DISTINCT FROM ?');
    expect(statement.sql).toContain('"customer_order"."priority" as "priority"');
    expect(statement.sql).not.toMatch(/limit|offset|row_number/i);
  });

  it('supports include and exclude node IDs', () => {
    const request = createRequest([OrderGroupingDimension.W_PLAN_NAME]);
    request.findNodes = ['550e8400-e29b-41d4-a716-446655440000'];
    request.excludeNodes = ['550e8400-e29b-41d4-a716-446655440001'];
    const sql = buildGroupOrdersQuery(database, request).toSQL().sql;
    expect(sql).toContain('"customer_order"."id" in (?)');
    expect(sql).toContain('"origin_order"."id" not in (?)');
  });

  it('rejects a source-incompatible hierarchy', () => {
    const request = createRequest([OrderGroupingDimension.A_OBJECTIVE_NAME]);
    expect(() => buildGroupOrdersQuery(database, request)).toThrow(BadRequestException);
  });
});

function createRequest(groupBy: OrderGroupingDimension[]): GroupOrdersRequestDto {
  const request = new GroupOrdersRequestDto();
  request.wCampaignIds = ['10000000-0000-4000-8000-000000000001'];
  request.groupBy = groupBy;
  request.groupIds = ['["W Campaign Alpha"]'];
  request.filters = [];
  return request;
}
