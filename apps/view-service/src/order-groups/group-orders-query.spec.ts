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
    request.groupIds = ['{"W_MISSION_NAME":"W Mission North","ORDER_STATUS":"DONE"}'];
    const statement = buildGroupOrdersQuery(database, request).toSQL();
    expect(statement.sql).toContain('"w_mission"."name" IS NOT DISTINCT FROM ?');
    expect(statement.sql).toContain('"customer_order"."status" IS NOT DISTINCT FROM ?');
    expect(statement.sql).not.toContain('"root"."name" IS NOT DISTINCT FROM');
    expect(statement.sql).toContain('"customer_order"."priority" as "priority"');
    expect(statement.sql).not.toMatch(/limit|offset|row_number/i);
  });

  it('filters orders by O plan and O plan W mission groups', () => {
    const request = createRequest([OrderGroupingDimension.O_PLAN_NAME, OrderGroupingDimension.O_PLAN_W_MISSION_NAME]);
    request.groupIds = [
      '{"O_PLAN_NAME":"O Plan North","O_PLAN_W_MISSION_NAME":"W Mission North"}',
      '{"O_PLAN_NAME":null}',
    ];
    const sql = buildGroupOrdersQuery(database, request).toSQL().sql;
    expect(sql).toContain('"benchmark_publisher"."o_plans"');
    expect(sql).toContain('"o_plan"."name" IS NOT DISTINCT FROM ?');
    expect(sql).toContain('"o_plan_w_mission"."name" IS NOT DISTINCT FROM ?');
  });

  it('supports include and exclude node IDs', () => {
    const request = createRequest([OrderGroupingDimension.W_PLAN_NAME]);
    request.findNodes = ['550e8400-e29b-41d4-a716-446655440000'];
    request.excludeNodes = ['550e8400-e29b-41d4-a716-446655440001'];
    const sql = buildGroupOrdersQuery(database, request).toSQL().sql;
    expect(sql).toContain('"customer_order"."id" in (?)');
    expect(sql).toContain('"origin_order"."id" not in (?)');
  });

  it('selects every order for the root group ID', () => {
    const request = createRequest([OrderGroupingDimension.ORDER_STATUS]);
    request.groupIds = ['root', '{"ORDER_STATUS":"DONE"}'];
    const sql = buildGroupOrdersQuery(database, request).toSQL().sql;
    expect(sql).toMatch(/\(TRUE\) or \("customer_order"\."status" IS NOT DISTINCT FROM \?\)/);
  });

  it('rejects a group path deeper than the hierarchy', () => {
    const request = createRequest([OrderGroupingDimension.ORDER_STATUS]);
    request.groupIds = ['{"ORDER_STATUS":"DONE","ORDER_COUNTRY":"EXPRESS"}'];
    expect(() => buildGroupOrdersQuery(database, request)).toThrow(BadRequestException);
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
  request.groupIds = ['root'];
  request.filters = [];
  return request;
}
