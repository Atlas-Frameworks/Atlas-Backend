import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OrderGroupsController } from './order-groups.controller.js';
import { OrderGroupsService } from './order-groups.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [OrderGroupsController],
  providers: [OrderGroupsService],
})
export class OrderGroupsModule {}
