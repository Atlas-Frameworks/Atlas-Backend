import { Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module.js';
import { ViewRegistry } from './view-registry.js';
import { ViewsController } from './views.controller.js';

@Module({
  imports: [EntitiesModule],
  controllers: [ViewsController],
  providers: [ViewRegistry],
  exports: [ViewRegistry],
})
export class ViewsModule {}
