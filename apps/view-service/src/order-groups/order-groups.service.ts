import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KNEX_CONNECTION } from '../database/database.constants.js';
import { GroupOrdersRequestDto } from './dto/group-orders-request.dto.js';
import { OrderGroupsRequestDto } from './dto/order-groups-request.dto.js';
import { buildGroupOrdersQuery } from './group-orders-query.js';
import { buildOrderGroupsQuery } from './order-groups-query.js';
import { buildGroupingResponse } from './grouping-response.js';
import type {
  GroupingResponse,
  GroupOrdersResponse,
} from './order-groups.types.js';

@Injectable()
export class OrderGroupsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly database: Knex) {}

  async findGroups(request: OrderGroupsRequestDto): Promise<GroupingResponse> {
    const rows = await buildOrderGroupsQuery(this.database, request);
    return buildGroupingResponse(rows);
  }

  async findGroupOrders(
    request: GroupOrdersRequestDto,
  ): Promise<GroupOrdersResponse> {
    const orders = await buildGroupOrdersQuery(this.database, request);
    return { orders };
  }
}
