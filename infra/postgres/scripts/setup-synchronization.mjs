import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  projectRoot,
  runPsql,
  waitForPostgres,
} from './docker-postgres.mjs';

async function main() {
  await waitForPostgres();

  const sqlFiles = [
    path.join(projectRoot, 'infra/postgres/init/02-schema.sql'),
    path.join(projectRoot, 'infra/postgres/init/03-outbox.sql'),
    path.join(projectRoot, 'infra/postgres/init/04-commerce-sync.sql'),
    path.join(projectRoot, 'infra/postgres/init/05-register-order-domain.sql'),
    path.join(projectRoot, 'infra/postgres/init/06-debezium-sync.sql'),
  ];
  const sqlParts = await Promise.all(
    sqlFiles.map((filePath) => readFile(filePath, 'utf8')),
  );

  await runPsql(['BEGIN;', ...sqlParts, 'COMMIT;'].join('\n\n'));
  console.log('Publisher and Debezium schemas are ready.');
}

try {
  await main();
} catch (error) {
  console.error(`Postgres synchronization setup failed: ${error.message}`);
  process.exitCode = 1;
}
