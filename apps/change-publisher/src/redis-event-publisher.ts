import { Redis } from 'ioredis';

import type { ClaimedEvent, EventPublisher } from './contracts.js';

export class RedisEventPublisher implements EventPublisher {
  readonly #redis: Redis;

  public constructor(redisUrl: string) {
    this.#redis = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  }

  public async publish(entityType: string, events: readonly ClaimedEvent[]): Promise<void> {
    if (events.length === 0) return;

    const stream = `changes:${entityType}`;
    const pipeline = this.#redis.pipeline();
    for (const event of events) {
      pipeline.xadd(stream, '*', 'value', JSON.stringify(event.payload));
    }

    const results = await pipeline.exec();
    if (results === null || results.length !== events.length) {
      throw new Error(`Redis did not return a result for every ${entityType} event`);
    }
    for (const [error] of results) {
      if (error !== null) throw error;
    }
  }

  public async close(): Promise<void> {
    this.#redis.disconnect();
  }
}
