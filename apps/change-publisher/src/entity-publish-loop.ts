import type { EventPublisher, EventRepository } from './contracts.js';

export interface EntityPublishLoopOptions {
  readonly entityType: string;
  readonly owner: string;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly idleDelayMilliseconds: number;
}

export type ErrorReporter = (entityType: string, error: unknown) => void;

export async function publishOneBatch(
  repository: EventRepository,
  publisher: EventPublisher,
  options: EntityPublishLoopOptions,
): Promise<number> {
  const events = await repository.claim(
    options.entityType,
    options.owner,
    options.batchSize,
    options.leaseSeconds,
  );
  if (events.length === 0) return 0;

  await publisher.publish(options.entityType, events);
  await repository.markPublished(
    options.entityType,
    options.owner,
    events.map((event) => event.eventId),
  );
  return events.length;
}

export async function runEntityPublishLoop(
  repository: EventRepository,
  publisher: EventPublisher,
  options: EntityPublishLoopOptions,
  signal: AbortSignal,
  reportError: ErrorReporter,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const publishedCount = await publishOneBatch(repository, publisher, options);
      if (publishedCount === 0) {
        await abortableDelay(options.idleDelayMilliseconds, signal);
      }
    } catch (error: unknown) {
      reportError(options.entityType, error);
      await abortableDelay(options.idleDelayMilliseconds, signal);
    }
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
