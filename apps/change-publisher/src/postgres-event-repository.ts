import pg from 'pg';

import type { ClaimedEvent, EventRepository } from './contracts.js';

interface EntityTypeRow extends pg.QueryResultRow {
  entity_type: string;
}

interface ClaimedEventRow extends pg.QueryResultRow {
  event_id: string;
  payload: unknown;
}

interface PostgresEventRepositoryOptions {
  readonly connectionString: string;
  readonly sourceSchema: string;
}

export class PostgresEventRepository implements EventRepository {
  readonly #pool: pg.Pool;
  readonly #sourceSchema: string;

  public constructor(options: PostgresEventRepositoryOptions) {
    this.#pool = new pg.Pool({ connectionString: options.connectionString });
    this.#sourceSchema = options.sourceSchema;
  }

  public async listEntityTypes(): Promise<readonly string[]> {
    const result = await this.#pool.query<EntityTypeRow>(
      `SELECT registry.entity_type
       FROM public.synchronized_entity_types AS registry
       JOIN pg_class AS source ON source.oid = registry.source_table
       JOIN pg_namespace AS namespace ON namespace.oid = source.relnamespace
       WHERE namespace.nspname = $1
       ORDER BY registry.entity_type`,
      [this.#sourceSchema],
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
       FROM public.claim_sync_events($1, $2, $3, $4)`,
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
      'SELECT public.mark_sync_events_published($1, $2, $3::bigint[]) AS marked_count',
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
