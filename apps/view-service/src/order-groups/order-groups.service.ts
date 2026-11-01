import { Inject, Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(OrderGroupsService.name);

  constructor(@Inject(KNEX_CONNECTION) private readonly database: Knex) {}

  async findGroups(request: OrderGroupsRequestDto): Promise<GroupingResponse> {
    const query = buildOrderGroupsQuery(this.database, request);
    console.log(query.toQuery());
    const rows = await query;
    return buildGroupingResponse(rows);
  }

  async findGroupOrders(
    request: GroupOrdersRequestDto,
  ): Promise<GroupOrdersResponse> {
    const orders = await buildGroupOrdersQuery(this.database, request);
    return { orders };
  }
}
