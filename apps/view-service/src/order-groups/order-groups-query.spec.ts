import { BadRequestException } from '@nestjs/common';
import knex from 'knex';
import type { Knex } from 'knex';
import { OrderGroupsRequestDto } from './dto/order-groups-request.dto.js';
import { OrderGroupingDimension, OrderSource } from './order-grouping-dimension.js';
import { OrderFilterOperator } from './order-filter.js';
import { buildOrderGroupsQuery, parsePaginationOverrides } from './order-groups-query.js';

describe('order groups query', () => {
  let database: Knex;
  beforeEach(() => { database = knex({ client: 'pg' }); });
  afterEach(() => database.destroy());

  it('builds the W hierarchy in the requested grouping order', () => {
    const request = createRequest(OrderSource.W, [
      OrderGroupingDimension.W_MISSION_NAME,
      OrderGroupingDimension.W_PLAN_NUMBER,
      OrderGroupingDimension.ORDER_STATUS,
    ]);
    request.wCampaignIds = [];
    request.wMissionIds = [validWMissionId];
    const statement = buildOrderGroupsQuery(database, request).toSQL();
    expect(statement.sql).toContain('benchmark_publisher"."w_campaigns');
    expect(statement.sql).toContain('"w_mission"."id" in (?)');
    expect(statement.sql).not.toContain('benchmark_publisher"."a_plans');
    expect(statement.sql).toContain('jsonb_build_array("w_mission"."name", "w_plan"."number", "customer_order"."status")');
    expect(statement.sql).not.toContain('"root"."name"');
    expect(statement.sql).toContain('count("node_membership"."order_id")');
  });

  it('builds the A hierarchy and binds filters', () => {
    const request = createRequest(OrderSource.A, [OrderGroupingDimension.A_OBJECTIVE_CATEGORY]);
    request.filters = [{ field: OrderGroupingDimension.ORDER_COUNTRY, operator: OrderFilterOperator.EQ, value: 'IL' }];
    const statement = buildOrderGroupsQuery(database, request).toSQL();
    expect(statement.sql).toContain('benchmark_publisher"."a_objectives');
    expect(statement.sql).toContain('"customer_order"."country" = ?');
    expect(statement.bindings).toEqual(expect.arrayContaining([validAPlanId, OrderSource.A, 'IL']));
  });

  it('keeps null equality filtering null-safe', () => {
    const request = createRequest(OrderSource.A, [OrderGroupingDimension.A_OBJECTIVE_CATEGORY]);
    request.filters = [{ field: OrderGroupingDimension.ORDER_COUNTRY, operator: OrderFilterOperator.EQ, value: null }];
    const statement = buildOrderGroupsQuery(database, request).toSQL();
    expect(statement.sql).toContain('"customer_order"."country" is null');
  });

  it('rejects source-incompatible dimensions', () => {
    const request = createRequest(OrderSource.W, [OrderGroupingDimension.A_OBJECTIVE_NAME]);
    expect(() => buildOrderGroupsQuery(database, request)).toThrow(BadRequestException);
  });

  it('rejects requests without any origin IDs', () => {
    const request = createRequest(OrderSource.W, [OrderGroupingDimension.ORDER_STATUS]);
    request.wCampaignIds = [];
    expect(() => buildOrderGroupsQuery(database, request)).toThrow(BadRequestException);
  });

  it('combines A and W when both origin families are populated', () => {
    const request = createRequest(OrderSource.W, [OrderGroupingDimension.ORDER_STATUS]);
    request.aPlanIds = [validAPlanId];
    const statement = buildOrderGroupsQuery(database, request).toSQL();
    expect(statement.sql).toContain('benchmark_publisher"."w_campaigns');
    expect(statement.sql).toContain('benchmark_publisher"."a_plans');
    expect(statement.sql).toContain('union all');
  });

  it('rejects a source-specific field when both origin families are populated', () => {
    const request = createRequest(OrderSource.W, [OrderGroupingDimension.W_MISSION_NAME]);
    request.aPlanIds = [validAPlanId];
    expect(() => buildOrderGroupsQuery(database, request)).toThrow(BadRequestException);
  });

  it('returns a root total plus flat group and order-membership rows without response JSON', () => {
    const request = createRequest(OrderSource.W, [OrderGroupingDimension.W_PLAN_NAME]);
    const sql = buildOrderGroupsQuery(database, request).toSQL().sql;
    expect(sql).toContain('row_number() OVER');
    expect(sql).toContain('union all');
    expect(sql).toContain('count(DISTINCT "membership"."order_id") AS "total"');
    expect(sql).toContain("'root'::text");
    expect(sql).toContain("'group'::text");
    expect(sql).toContain("'order'::text");
    expect(sql).not.toContain('jsonb_build_object');
    expect(sql).not.toContain('materialized');
  });

  it('skips group levels and returns orders on the empty path when nothing is grouped', () => {
    const request = createRequest(OrderSource.A, []);
    const sql = buildOrderGroupsQuery(database, request).toSQL().sql;
    expect(sql).toContain('jsonb_build_array() AS full_group_path');
    expect(sql).not.toContain('node_counts');
    expect(sql).not.toContain("'group'::text");
    expect(sql).toContain("'order'::text");
  });
});

describe('pagination overrides', () => {
  it('parses a valid full-path override', () => {
    expect(parsePaginationOverrides({ '["W Mission North","W Plan One"]': { limit: 5, offset: 10 } }, 2))
      .toEqual([{ path: ['W Mission North', 'W Plan One'], limit: 5, offset: 10 }]);
  });
  it('rejects a non-leaf override', () => {
    expect(() => parsePaginationOverrides({ '["W Mission North"]': { limit: 5, offset: 0 } }, 2))
      .toThrow(BadRequestException);
  });
  it('maps the root key to the empty path when nothing is grouped', () => {
    expect(parsePaginationOverrides({ root: { limit: 5, offset: 0 } }, 0))
      .toEqual([{ path: [], limit: 5, offset: 0 }]);
    expect(() => parsePaginationOverrides({ root: { limit: 5, offset: 0 } }, 1)).toThrow(BadRequestException);
  });
});

function createRequest(source: OrderSource, groupBy: OrderGroupingDimension[]): OrderGroupsRequestDto {
  const request = new OrderGroupsRequestDto();
  if (source === OrderSource.W) request.wCampaignIds = [validWCampaignId];
  else request.aPlanIds = [validAPlanId];
  request.groupBy = groupBy;
  request.defaultLimit = 10;
  request.filters = [];
  return request;
}

const validWCampaignId = '10000000-0000-4000-8000-000000000001';
const validWMissionId = '11000000-0000-4000-8000-000000000001';
const validAPlanId = '20000000-0000-4000-8000-000000000001';
