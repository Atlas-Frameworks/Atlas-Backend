import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  projectRoot,
  runPsql,
  waitForPostgres,
} from '../postgres/scripts/docker-postgres.mjs';

async function main() {
  await waitForPostgres();
  const setupSql = await readFile(
    path.join(projectRoot, 'infra/benchmark/01-setup.sql'),
    'utf8',
  );
  await runPsql(['BEGIN;', setupSql, 'COMMIT;'].join('\n\n'));
  console.log('Publisher and Debezium benchmark schemas are ready.');
}

try {
  await main();
} catch (error) {
  console.error(`Benchmark setup failed: ${error.message}`);
  process.exitCode = 1;
}
