import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  projectRoot,
  runPsql,
  waitForDebeziumSlot,
  waitForPostgres,
} from './docker-postgres.mjs';

const rollBack = process.argv.includes('--rollback');

async function main() {
  await waitForPostgres();
  await waitForDebeziumSlot(1);

  const sqlFiles = [
    path.join(projectRoot, 'infra/postgres/init/02-schema.sql'),
    path.join(projectRoot, 'infra/postgres/init/05-register-commerce.sql'),
    path.join(projectRoot, 'infra/postgres/seed/01-initial-data.sql'),
  ];
  const [schemaSql, registrationSql, seedSql] = await Promise.all(
    sqlFiles.map((filePath) => readFile(filePath, 'utf8')),
  );

  await runPsql(
    ['BEGIN;', schemaSql, registrationSql, 'COMMIT;'].join('\n\n'),
  );
  console.log('Commerce tables and synchronization triggers are ready.');

  const seedDataSql = [
    'BEGIN;',
    'SET LOCAL ROLE atlas_writer;',
    seedSql,
    rollBack ? 'ROLLBACK;' : 'COMMIT;',
  ].join('\n\n');

  await runPsql(seedDataSql);
  console.log(
    rollBack
      ? 'Initial commerce data was validated and rolled back.'
      : 'Initial commerce data committed successfully.',
  );
}

try {
  await main();
} catch (error) {
  console.error(`Commerce seed failed: ${error.message}`);
  process.exitCode = 1;
}
