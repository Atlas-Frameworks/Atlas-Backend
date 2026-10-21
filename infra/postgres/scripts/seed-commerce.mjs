import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  projectRoot,
  runPsql,
  waitForPostgres,
} from './docker-postgres.mjs';

const rollBack = process.argv.includes('--rollback');

async function main() {
  await waitForPostgres();
  const seedSql = await readFile(
    path.join(projectRoot, 'infra/postgres/seed/01-initial-data.sql'),
    'utf8',
  );

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
      : 'Identical commerce data committed to both benchmark schemas.',
  );
}

try {
  await main();
} catch (error) {
  console.error(`Commerce seed failed: ${error.message}`);
  process.exitCode = 1;
}
