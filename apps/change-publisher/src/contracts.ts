export interface ClaimedEvent {
  readonly eventId: string;
  readonly payload: unknown;
}

export interface EventRepository {
  listEntityTypes(): Promise<readonly string[]>;
  claim(entityType: string, owner: string, batchSize: number, leaseSeconds: number): Promise<readonly ClaimedEvent[]>;
  markPublished(entityType: string, owner: string, eventIds: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export interface EventPublisher {
  publish(entityType: string, events: readonly ClaimedEvent[]): Promise<void>;
  close(): Promise<void>;
}
