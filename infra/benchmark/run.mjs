import Redis from 'ioredis';
import pg from 'pg';

import { runWorkload } from './workload.mjs';

const pipeline = readArgument('--pipeline');
const eventCount = readPositiveIntegerArgument('--events', 10_000);
const concurrency = readPositiveIntegerArgument('--concurrency', 32);
const timeoutMilliseconds = readPositiveIntegerArgument('--timeout-ms', 120_000);

if (pipeline !== 'publisher' && pipeline !== 'debezium') {
  throw new Error('--pipeline must be publisher or debezium');
}

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL
    ?? 'postgresql://atlas_writer:atlas_writer@localhost:5432/atlas',
  max: concurrency,
});
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');

try {
  const result = await runWorkload({
    pool,
    redis,
    pipeline,
    eventCount,
    concurrency,
    timeoutMilliseconds,
  });
  console.table({ pipeline: result });
} finally {
  await pool.end();
  redis.disconnect();
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readPositiveIntegerArgument(name, defaultValue) {
  const rawValue = readArgument(name);
  if (rawValue === undefined) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
