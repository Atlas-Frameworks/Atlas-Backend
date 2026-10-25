import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { OrderGroupsModule } from './order-groups/order-groups.module.js';

@Module({
  imports: [OrderGroupsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
