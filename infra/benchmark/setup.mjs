import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  projectRoot,
  runPsql,
  waitForPostgres,
} from '../postgres/scripts/docker-postgres.mjs';

async function main() {
  await waitForPostgres();
  const sqlFiles = [
    '02-schema.sql',
    '03-outbox.sql',
    '04-commerce-sync.sql',
    '05-register-commerce.sql',
    '06-debezium-sync.sql',
  ].map((fileName) => path.join(projectRoot, 'infra/postgres/init', fileName));
  const sqlParts = await Promise.all(
    sqlFiles.map((filePath) => readFile(filePath, 'utf8')),
  );
  await runPsql(['BEGIN;', ...sqlParts, 'COMMIT;'].join('\n\n'));
  console.log('Publisher and Debezium benchmark schemas are ready.');
}

try {
  await main();
} catch (error) {
  console.error(`Benchmark setup failed: ${error.message}`);
  process.exitCode = 1;
}
