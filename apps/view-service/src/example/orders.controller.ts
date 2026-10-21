import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  optionalList,
  optionalNumber,
  optionalUuid,
} from '../http/query-params.js';
import { ViewService, type ViewSnapshot } from '../views/view.service.js';
import { customerOrders, ordersSearch } from './orders.queries.js';

/**
 * Example of a route that opens a view. It reads the HTTP params, turns them
 * into typed values, and calls views.open — the SQL lives in orders.queries.ts.
 * The client then streams changes from GET /views/:viewKey/events (step 4).
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly views: ViewService) {}

  /** GET /orders?type=book&type=food&minPrice=50&maxPrice=300&customerId=… — every param is optional. */
  @Get()
  search(
    @Query('type') type?: string | string[],
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('customerId') customerId?: string,
  ): Promise<ViewSnapshot> {
    return this.views.open(ordersSearch, {
      types: optionalList('type', type),
      minPrice: optionalNumber('minPrice', minPrice),
      maxPrice: optionalNumber('maxPrice', maxPrice),
      customerId: optionalUuid('customerId', customerId),
    });
  }

  /** GET /orders/by-customer/:customerId?type=food — a required path param plus an optional filter. */
  @Get('by-customer/:customerId')
  byCustomer(
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Query('type') type?: string | string[],
  ): Promise<ViewSnapshot> {
    return this.views.open(customerOrders, {
      customerId: customerId.toLowerCase(),
      types: optionalList('type', type),
    });
  }
}
