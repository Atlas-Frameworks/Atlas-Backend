import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const runOnce = process.argv.includes('--once');
const rollBack = process.argv.includes('--rollback');
const targetSchema = readTargetSchema();
let shuttingDown = false;

if (rollBack && !runOnce) throw new Error('--rollback can only be used together with --once');

const entityTables = ['w_campaigns', 'w_missions', 'w_plans', 'a_plans', 'a_missions', 'a_objectives'];
const jobs = [
  ...entityTables.map((table, index) => createEntityJob(table, 2_000 + index * 500)),
  {
    name: 'orders', intervalMs: readPositiveInteger('ORDER_INTERVAL_MS', 4_000), maxUpdates: readPositiveInteger('ORDER_MAX_UPDATES', 5),
    sql: (maxUpdates) => `
      WITH selected AS (SELECT id FROM ${targetSchema}.orders ORDER BY random() LIMIT (1 + floor(random() * ${maxUpdates}))::integer),
      updated AS (
        UPDATE ${targetSchema}.orders AS entity
        SET status = (ARRAY['NEW','PROCESSING','DONE','CANCELLED'])[1 + floor(random() * 4)::integer],
            priority = 1 + floor(random() * 5)::integer,
            amount = round((10 + random() * 2000)::numeric, 2),
            sequence = nextval('${targetSchema}.replicator_sequence')
        FROM selected WHERE entity.id = selected.id RETURNING entity.id
      ) SELECT count(*) FROM updated;`,
  },
];

function createEntityJob(table, defaultInterval) {
  const environmentPrefix = table.toUpperCase();
  return {
    name: table,
    intervalMs: readPositiveInteger(`${environmentPrefix}_INTERVAL_MS`, defaultInterval),
    maxUpdates: readPositiveInteger(`${environmentPrefix}_MAX_UPDATES`, 3),
    sql: (maxUpdates) => `
      WITH selected AS (SELECT id FROM ${targetSchema}.${table} ORDER BY random() LIMIT (1 + floor(random() * ${maxUpdates}))::integer),
      updated AS (
        UPDATE ${targetSchema}.${table} AS entity
        SET status = (ARRAY['ACTIVE','PLANNED','PAUSED'])[1 + floor(random() * 3)::integer],
            number = entity.number + 1,
            sequence = nextval('${targetSchema}.replicator_sequence')
        FROM selected WHERE entity.id = selected.id RETURNING entity.id
      ) SELECT count(*) FROM updated;`,
  };
}

function readTargetSchema() {
  const argumentIndex = process.argv.indexOf('--schema');
  const schema = argumentIndex === -1 ? process.env.REPLICATOR_SCHEMA : process.argv[argumentIndex + 1];
  if (schema === 'benchmark_publisher' || schema === 'benchmark_debezium') return schema;
  throw new Error('Choose --schema benchmark_publisher or --schema benchmark_debezium');
}

function readPositiveInteger(name, defaultValue) {
  const rawValue = process.env[name];
  const value = rawValue === undefined ? defaultValue : Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer; received ${rawValue}`);
  return value;
}

function executeSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', 'infra/docker-compose.yml', 'exec', '-T', 'postgres-primary', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'atlas_writer', '-d', 'atlas', '-c', sql], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => exitCode === 0 ? resolve(stdout.trim()) : reject(new Error(`psql exited with code ${exitCode}: ${stderr.trim() || 'unknown error'}`)));
  });
}

async function runJob(job) {
  try {
    const sql = job.sql(job.maxUpdates);
    const count = await executeSql(rollBack ? `BEGIN; ${sql} ROLLBACK;` : sql);
    console.log(`${new Date().toISOString()} ${job.name}: updated ${count} row(s)`);
    return true;
  } catch (error) {
    console.error(`${new Date().toISOString()} ${job.name}: ${error.message}`);
    return false;
  }
}

function scheduleJob(job) {
  const runAndReschedule = async () => { await runJob(job); if (!shuttingDown) setTimeout(runAndReschedule, job.intervalMs); };
  setTimeout(runAndReschedule, job.intervalMs);
}

function stop() { shuttingDown = true; console.log('Stopping data update simulator...'); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);

if (runOnce) {
  console.log(`Replicator target schema: ${targetSchema}`);
  const results = await Promise.all(jobs.map(runJob));
  if (results.includes(false)) process.exitCode = 1;
} else {
  console.log(`Data update simulator started for ${targetSchema}. Press Ctrl+C to stop.`);
  jobs.forEach(scheduleJob);
}
