import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  optionalList,
  optionalNumber,
  optionalOneOf,
  optionalUuid,
  pageRequest,
} from '../http/query-params.js';
import { ViewService, type ViewPage } from '../views/view.service.js';
import { customerOrders, ORDER_BY, ordersSearch } from './orders.queries.js';

/**
 * Example of a route that opens a view. It reads the HTTP params, turns them
 * into typed values, and calls views.open — the SQL lives in orders.queries.ts.
 * Every route also takes ?offset=&limit= for the range of rows it returns;
 * they don't change the view, so every range shares one load. The order is
 * part of the query's SQL: a route that offers several takes its own param
 * (here ?orderBy=), and each order is its own view.
 * The client then streams changes from GET /views/:viewKey/events.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly views: ViewService) {}

  /** GET /orders?type=book&type=food&minPrice=50&maxPrice=300&customerId=…&orderBy=price&offset=7&limit=20 — every param is optional. */
  @Get()
  search(
    @Query() query: Record<string, unknown>,
    @Query('type') type?: string | string[],
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('customerId') customerId?: string,
    @Query('orderBy') orderBy?: string,
  ): Promise<ViewPage> {
    return this.views.open(
      ordersSearch,
      {
        types: optionalList('type', type),
        minPrice: optionalNumber('minPrice', minPrice),
        maxPrice: optionalNumber('maxPrice', maxPrice),
        customerId: optionalUuid('customerId', customerId),
        orderBy: optionalOneOf('orderBy', orderBy, ORDER_BY),
      },
      pageRequest(query),
    );
  }

  /** GET /orders/by-customer/:customerId?type=food — a required path param plus an optional filter. */
  @Get('by-customer/:customerId')
  byCustomer(
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Query() query: Record<string, unknown>,
    @Query('type') type?: string | string[],
  ): Promise<ViewPage> {
    return this.views.open(
      customerOrders,
      {
        customerId: customerId.toLowerCase(),
        types: optionalList('type', type),
      },
      pageRequest(query),
    );
  }
}
