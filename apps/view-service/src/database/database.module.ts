import {
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import knex from 'knex';
import type { Knex } from 'knex';
import { KNEX_CONNECTION } from './database.constants.js';

const localDatabaseUrl =
  'postgresql://atlas_reader:atlas_reader@localhost:5432/atlas';

function createConnection(): Knex {
  return knex({
    client: 'pg',
    connection: process.env['DATABASE_URL'] ?? localDatabaseUrl,
    pool: { min: 0, max: 10 },
  });
}

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(KNEX_CONNECTION) private readonly connection: Knex) {}

  onApplicationShutdown(): Promise<void> {
    return this.connection.destroy();
  }
}

@Module({
  providers: [
    { provide: KNEX_CONNECTION, useFactory: createConnection },
    DatabaseLifecycle,
  ],
  exports: [KNEX_CONNECTION],
})
export class DatabaseModule {}
