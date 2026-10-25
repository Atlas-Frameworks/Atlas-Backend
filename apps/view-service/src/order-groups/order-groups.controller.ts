import { Body, Controller, Post } from '@nestjs/common';
import { GroupOrdersRequestDto } from './dto/group-orders-request.dto.js';
import { OrderGroupsRequestDto } from './dto/order-groups-request.dto.js';
import { OrderGroupsService } from './order-groups.service.js';
import type {
  GroupingResponse,
  GroupOrdersResponse,
} from './order-groups.types.js';

@Controller('order-groups')
export class OrderGroupsController {
  constructor(private readonly orderGroupsService: OrderGroupsService) {}

  @Post()
  findGroups(
    @Body() request: OrderGroupsRequestDto,
  ): Promise<GroupingResponse> {
    return this.orderGroupsService.findGroups(request);
  }

  @Post('orders')
  findGroupOrders(
    @Body() request: GroupOrdersRequestDto,
  ): Promise<GroupOrdersResponse> {
    return this.orderGroupsService.findGroupOrders(request);
  }
}
