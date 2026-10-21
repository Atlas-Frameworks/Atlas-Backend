import { Module } from '@nestjs/common';
import { ChangesModule } from '../changes/changes.module.js';
import { DbModule } from '../db/db.module.js';
import { ChangesDebugController } from './changes-debug.controller.js';
import { DependencyIndex } from './dependency-index.js';
import { TickService } from './tick.service.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import { ViewsController } from './views.controller.js';

@Module({
  imports: [DbModule, ChangesModule],
  controllers: [ViewsController, ChangesDebugController],
  providers: [
    ViewRegistry,
    ViewLoader,
    ViewService,
    DependencyIndex,
    TickService,
  ],
  exports: [ViewRegistry, ViewService, DependencyIndex],
})
export class ViewsModule {}
