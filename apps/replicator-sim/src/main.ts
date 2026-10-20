import { NestFactory } from '@nestjs/core';
import { NestPinoLogger, createLogger } from '@atlas/node-common';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

async function bootstrap() {
  const config = loadConfig();
  const logger = createLogger('replicator-sim', {
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });
  const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger(logger) });
  await app.listen(config.PORT);
  logger.info({ port: config.PORT }, 'replicator-sim listening');
}
await bootstrap();
