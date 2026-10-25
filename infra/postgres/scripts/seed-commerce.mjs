import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  projectRoot,
  runPsql,
  waitForPostgres,
} from './docker-postgres.mjs';

const rollBack = process.argv.includes('--rollback');
const orderGroupsLoad = process.argv.includes('--order-groups-load');

async function main() {
  await waitForPostgres();
  const seedFileName = orderGroupsLoad
    ? '02-order-groups-load.sql'
    : '01-initial-data.sql';
  const seedSql = await readFile(
    path.join(projectRoot, 'infra/postgres/seed', seedFileName),
    'utf8',
  );

  const seedDataSql = [
    'BEGIN;',
    orderGroupsLoad ? 'SET LOCAL session_replication_role = replica;' : '',
    'SET LOCAL ROLE atlas_writer;',
    seedSql,
    rollBack ? 'ROLLBACK;' : 'COMMIT;',
  ].join('\n\n');

  await runPsql(seedDataSql);
  console.log(
    rollBack
      ? `${seedFileName} was validated and rolled back.`
      : `${seedFileName} was committed to both benchmark schemas.`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`Order-domain seed failed: ${error.message}`);
  process.exitCode = 1;
}
