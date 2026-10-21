import { Module } from '@nestjs/common';
import { ViewRegistry } from './view-registry.js';

@Module({
  providers: [ViewRegistry],
  exports: [ViewRegistry],
})
export class ViewsModule {}
