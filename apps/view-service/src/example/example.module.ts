import { Module } from '@nestjs/common';
import { ViewsModule } from '../views/views.module.js';
import { OrdersController } from './orders.controller.js';

/** Example routes that open views with developer-written SQL. */
@Module({
  imports: [ViewsModule],
  controllers: [OrdersController],
})
export class ExampleModule {}
