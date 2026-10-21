import { readPublisherConfig } from './config.js';
import { runEntityPublishLoop } from './entity-publish-loop.js';
import { PostgresEventRepository } from './postgres-event-repository.js';
import { RedisEventPublisher } from './redis-event-publisher.js';

const config = readPublisherConfig(process.env);
const repository = new PostgresEventRepository(config.databaseUrl);
const publisher = new RedisEventPublisher(config.redisUrl);
const abortController = new AbortController();

process.once('SIGINT', () => abortController.abort());
process.once('SIGTERM', () => abortController.abort());

try {
  const entityTypes = await repository.listEntityTypes();
  if (entityTypes.length === 0) {
    throw new Error('No synchronized entity types are registered');
  }

  console.log(`Starting independent publish loops for: ${entityTypes.join(', ')}`);
  await Promise.all(
    entityTypes.map((entityType) =>
      runEntityPublishLoop(
        repository,
        publisher,
        {
          entityType,
          owner: config.owner,
          batchSize: config.batchSize,
          leaseSeconds: config.leaseSeconds,
          idleDelayMilliseconds: config.idleDelayMilliseconds,
        },
        abortController.signal,
        (failedEntityType, error) => {
          console.error(`Publish failed for ${failedEntityType}; the batch will be retried`, error);
        },
      ),
    ),
  );
} finally {
  await Promise.allSettled([repository.close(), publisher.close()]);
}
