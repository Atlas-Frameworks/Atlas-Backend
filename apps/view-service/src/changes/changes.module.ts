import { Module } from '@nestjs/common';
import { ChangeBuffer } from './change-buffer.js';
import { ChangeFeed } from './change-feed.js';
import { RedisStreamReader, StreamReader } from './stream-reader.js';

// The master-only proxy, so a local app follows Redis failovers (infra/README.md).
const DEFAULT_REDIS_URL = 'redis://localhost:6380';

@Module({
  providers: [
    {
      provide: StreamReader,
      useFactory: () =>
        new RedisStreamReader(process.env.REDIS_URL ?? DEFAULT_REDIS_URL),
    },
    ChangeBuffer,
    ChangeFeed,
  ],
  exports: [ChangeBuffer, ChangeFeed],
})
export class ChangesModule {}
