import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const runOnce = process.argv.includes('--once');
const rollBack = process.argv.includes('--rollback');
const targetSchema = readTargetSchema();
let shuttingDown = false;

if (rollBack && !runOnce) {
  throw new Error('--rollback can only be used together with --once');
}

function readTargetSchema() {
  const schemaArgumentIndex = process.argv.indexOf('--schema');
  const schemaArgument = schemaArgumentIndex === -1
    ? undefined
    : process.argv[schemaArgumentIndex + 1];
  const schema = schemaArgument ?? process.env.REPLICATOR_SCHEMA;
  if (schema === 'benchmark_publisher' || schema === 'benchmark_debezium') return schema;
  throw new Error(
    'Choose --schema benchmark_publisher or --schema benchmark_debezium',
  );
}

function readPositiveInteger(name, defaultValue) {
  const rawValue = process.env[name];
  const value = rawValue === undefined ? defaultValue : Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${rawValue}`);
  }

  return value;
}

const jobs = [
  {
    name: 'items',
    intervalMs: readPositiveInteger('ITEM_INTERVAL_MS', 2_000),
    maxUpdates: readPositiveInteger('ITEM_MAX_UPDATES', 8),
    sql: (maxUpdates) => `
      WITH selected AS MATERIALIZED (
        SELECT id FROM ${targetSchema}.items ORDER BY random()
        LIMIT (1 + floor(random() * ${maxUpdates}))::integer
      ), updated AS (
        UPDATE ${targetSchema}.items AS item
        SET price = round((5 + random() * 495)::numeric, 2)
        FROM selected
        WHERE item.id = selected.id
        RETURNING item.id
      )
      SELECT count(*) FROM updated;
    `,
  },
  {
    name: 'customers',
    intervalMs: readPositiveInteger('CUSTOMER_INTERVAL_MS', 3_000),
    maxUpdates: readPositiveInteger('CUSTOMER_MAX_UPDATES', 6),
    sql: (maxUpdates) => `
      WITH selected AS MATERIALIZED (
        SELECT id FROM ${targetSchema}.customers ORDER BY random()
        LIMIT (1 + floor(random() * ${maxUpdates}))::integer
      ), updated AS (
        UPDATE ${targetSchema}.customers AS customer
        SET address = format(
          '%s %s Street',
          1 + floor(random() * 999)::integer,
          (ARRAY['Atlas', 'Market', 'Oak', 'River', 'Sunset'])[1 + floor(random() * 5)::integer]
        )
        FROM selected
        WHERE customer.id = selected.id
        RETURNING customer.id
      )
      SELECT count(*) FROM updated;
    `,
  },
  {
    name: 'orders',
    intervalMs: readPositiveInteger('ORDER_INTERVAL_MS', 4_000),
    maxUpdates: readPositiveInteger('ORDER_MAX_UPDATES', 5),
    sql: (maxUpdates) => `
      WITH selected AS MATERIALIZED (
        SELECT id, item_id, customer_id, random() < 0.5 AS change_item
        FROM ${targetSchema}.orders
        ORDER BY random()
        LIMIT (1 + floor(random() * ${maxUpdates}))::integer
      ), replacements AS MATERIALIZED (
        SELECT
          selected.id,
          CASE WHEN selected.change_item THEN (
            SELECT id FROM ${targetSchema}.items
            WHERE id <> selected.item_id
            ORDER BY random() LIMIT 1
          ) ELSE selected.item_id END AS item_id,
          CASE WHEN selected.change_item THEN selected.customer_id ELSE (
            SELECT id FROM ${targetSchema}.customers
            WHERE id <> selected.customer_id
            ORDER BY random() LIMIT 1
          ) END AS customer_id
        FROM selected
      ), updated AS (
        UPDATE ${targetSchema}.orders AS customer_order
        SET item_id = replacements.item_id,
            customer_id = replacements.customer_id
        FROM replacements
        WHERE customer_order.id = replacements.id
          AND replacements.item_id IS NOT NULL
          AND replacements.customer_id IS NOT NULL
        RETURNING customer_order.id
      )
      SELECT count(*) FROM updated;
    `,
  },
  {
    name: 'distributors',
    intervalMs: readPositiveInteger('DISTRIBUTOR_INTERVAL_MS', 5_000),
    maxUpdates: readPositiveInteger('DISTRIBUTOR_MAX_UPDATES', 3),
    sql: (maxUpdates) => `
      WITH selected AS MATERIALIZED (
        SELECT id FROM ${targetSchema}.distributors ORDER BY random()
        LIMIT (1 + floor(random() * ${maxUpdates}))::integer
      ), updated AS (
        UPDATE ${targetSchema}.distributors AS distributor
        SET order_ids = ARRAY(
          SELECT customer_order.id
          FROM ${targetSchema}.orders AS customer_order
          WHERE customer_order.id IS DISTINCT FROM distributor.id
          ORDER BY random()
          LIMIT (1 + floor(random() * 20))::integer
        )
        FROM selected
        WHERE distributor.id = selected.id
        RETURNING distributor.id
      )
      SELECT count(*) FROM updated;
    `,
  },
];

function executeSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose', '-f', 'infra/docker-compose.yml', 'exec', '-T',
        'postgres-primary', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'atlas_writer', '-d', 'atlas', '-c', sql,
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(
          `psql exited with code ${exitCode}: ${stderr.trim() || 'unknown error'}`,
        ),
      );
    });
  });
}

async function runJob(job) {
  try {
    const sql = job.sql(job.maxUpdates);
    const updatedCount = await executeSql(
      rollBack ? `BEGIN; ${sql} ROLLBACK;` : sql,
    );
    console.log(
      `${new Date().toISOString()} ${job.name}: updated ${updatedCount} row(s)`,
    );
    return true;
  } catch (error) {
    console.error(`${new Date().toISOString()} ${job.name}: ${error.message}`);
    return false;
  }
}

function scheduleJob(job) {
  const runAndReschedule = async () => {
    await runJob(job);

    if (!shuttingDown) {
      setTimeout(runAndReschedule, job.intervalMs);
    }
  };

  setTimeout(runAndReschedule, job.intervalMs);
}

function stop() {
  shuttingDown = true;
  console.log('Stopping data update simulator...');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (runOnce) {
  console.log(`Replicator target schema: ${targetSchema}`);
  const results = await Promise.all(jobs.map(runJob));
  if (results.includes(false)) {
    process.exitCode = 1;
  }
} else {
  console.log(`Data update simulator started for ${targetSchema}. Press Ctrl+C to stop.`);
  for (const job of jobs) {
    console.log(
      `${job.name}: every ${job.intervalMs} ms, updating 1-${job.maxUpdates} row(s)`,
    );
    scheduleJob(job);
  }
}
