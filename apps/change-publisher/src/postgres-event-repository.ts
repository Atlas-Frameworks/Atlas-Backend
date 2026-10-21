import pg from 'pg';

import type { ClaimedEvent, EventRepository } from './contracts.js';

interface EntityTypeRow extends pg.QueryResultRow {
  entity_type: string;
}

interface ClaimedEventRow extends pg.QueryResultRow {
  event_id: string;
  payload: unknown;
}

export class PostgresEventRepository implements EventRepository {
  readonly #pool: pg.Pool;

  public constructor(connectionString: string) {
    this.#pool = new pg.Pool({ connectionString });
  }

  public async listEntityTypes(): Promise<readonly string[]> {
    const result = await this.#pool.query<EntityTypeRow>(
      'SELECT entity_type FROM synchronized_entity_types ORDER BY entity_type',
    );
    return result.rows.map((row) => row.entity_type);
  }

  public async claim(
    entityType: string,
    owner: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<readonly ClaimedEvent[]> {
    const result = await this.#pool.query<ClaimedEventRow>(
      `SELECT event_id::text, payload
       FROM claim_sync_events($1, $2, $3, $4)`,
      [entityType, owner, batchSize, leaseSeconds],
    );
    return result.rows.map((row) => ({ eventId: row.event_id, payload: row.payload }));
  }

  public async markPublished(
    entityType: string,
    owner: string,
    eventIds: readonly string[],
  ): Promise<void> {
    if (eventIds.length === 0) return;

    const result = await this.#pool.query<{ marked_count: number }>(
      'SELECT mark_sync_events_published($1, $2, $3::bigint[]) AS marked_count',
      [entityType, owner, eventIds],
    );
    const markedCount = result.rows[0]?.marked_count ?? 0;
    if (markedCount !== eventIds.length) {
      throw new Error(`Expected to mark ${eventIds.length} ${entityType} events, marked ${markedCount}`);
    }
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }
}
