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
    path.join(projectRoot, 'infra/postgres/init/03-outbox.sql'),
    path.join(projectRoot, 'infra/postgres/init/04-commerce-sync.sql'),
  ];
  const sqlParts = await Promise.all(
    sqlFiles.map((filePath) => readFile(filePath, 'utf8')),
  );

  await runPsql(['BEGIN;', ...sqlParts, 'COMMIT;'].join('\n\n'));
  console.log('Durable outbox tables and synchronization functions are ready.');
}

try {
  await main();
} catch (error) {
  console.error(`Postgres synchronization setup failed: ${error.message}`);
  process.exitCode = 1;
}
