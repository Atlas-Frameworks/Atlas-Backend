import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { DependencyIndex } from './dependency-index.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import { ViewsController } from './views.controller.js';

@Module({
  imports: [DbModule],
  controllers: [ViewsController],
  providers: [ViewRegistry, ViewLoader, ViewService, DependencyIndex],
  exports: [ViewRegistry, ViewService, DependencyIndex],
})
export class ViewsModule {}
