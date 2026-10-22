import { Module } from '@nestjs/common';
import { ExampleModule } from './example/example.module.js';
import { ViewsModule } from './views/views.module.js';

@Module({
  imports: [ViewsModule, ExampleModule],
})
export class AppModule {}
