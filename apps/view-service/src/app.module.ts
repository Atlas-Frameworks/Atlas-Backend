import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ExampleModule } from './example/example.module.js';
import { ViewsModule } from './views/views.module.js';

@Module({
  imports: [ViewsModule, ExampleModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
