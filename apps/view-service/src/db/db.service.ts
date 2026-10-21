import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import type { SqlStatement } from '../views/sql.js';

// The read replica isn't part of the local setup yet, so the default is the
// reader role on the primary. Set PG_REPLICA_URL to use the replica (port 5433).
const DEFAULT_URL = 'postgres://atlas_reader:atlas_reader@localhost:5432/atlas';

/** Read-only Postgres access for views. S-03 adds the build queue and retries. */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool = new pg.Pool({
    connectionString: process.env.PG_REPLICA_URL ?? DEFAULT_URL,
    max: 20,
    statement_timeout: 30_000,
    application_name: 'view-service',
  });

  async query<Row extends pg.QueryResultRow>(
    stmt: SqlStatement,
  ): Promise<Row[]> {
    const result = await this.pool.query<Row>(stmt.text, stmt.values);
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
