import { describe, expect, it, vi } from 'vitest';

import type { ClaimedEvent, EventPublisher, EventRepository } from './contracts.js';
import { publishOneBatch } from './entity-publish-loop.js';

const options = {
  entityType: 'items',
  owner: 'publisher-1',
  batchSize: 100,
  leaseSeconds: 30,
  idleDelayMilliseconds: 10,
};

describe('publishOneBatch', () => {
  it('marks a claimed batch only after Redis accepts it', async () => {
    const calls: string[] = [];
    const events: readonly ClaimedEvent[] = [{ eventId: '7', payload: { typeSeq: 3 } }];
    const repository = createRepository(events, calls);
    const publisher = createPublisher(calls);

    await expect(publishOneBatch(repository, publisher, options)).resolves.toBe(1);

    expect(calls).toEqual(['claim', 'publish', 'mark:7']);
  });

  it('leaves the batch pending when Redis fails', async () => {
    const calls: string[] = [];
    const repository = createRepository([{ eventId: '8', payload: { typeSeq: 4 } }], calls);
    const publisher: EventPublisher = {
      publish: vi.fn(async () => {
        calls.push('publish');
        throw new Error('Redis unavailable');
      }),
      close: vi.fn(async () => undefined),
    };

    await expect(publishOneBatch(repository, publisher, options)).rejects.toThrow('Redis unavailable');
    expect(calls).toEqual(['claim', 'publish']);
  });
});

function createRepository(events: readonly ClaimedEvent[], calls: string[]): EventRepository {
  return {
    listEntityTypes: vi.fn(async () => ['items']),
    claim: vi.fn(async () => {
      calls.push('claim');
      return events;
    }),
    markPublished: vi.fn(async (_entityType, _owner, eventIds) => {
      calls.push(`mark:${eventIds.join(',')}`);
    }),
    close: vi.fn(async () => undefined),
  };
}

function createPublisher(calls: string[]): EventPublisher {
  return {
    publish: vi.fn(async () => {
      calls.push('publish');
    }),
    close: vi.fn(async () => undefined),
  };
}
