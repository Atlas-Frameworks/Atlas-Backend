import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ViewsModule } from './views/views.module.js';

@Module({
  imports: [ViewsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
