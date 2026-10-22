import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Redis from 'ioredis';
import pg from 'pg';

import {
  calculatePostgresDelta,
  capturePostgresSnapshot,
  readPostgresMetadata,
} from './postgres-metrics.mjs';
import { getPipelineDefinition, runWorkload } from './workload.mjs';

const options = readOptions(process.argv.slice(2), process.env);
validateProductionConfirmation(options);

const workloadPool = new pg.Pool({
  connectionString: options.databaseUrl,
  max: options.concurrency,
});
const metricsPool = new pg.Pool({
  connectionString: options.metricsDatabaseUrl,
  max: 2,
});
const redis = new Redis(options.redisUrl);

try {
  const context = await verifyEnvironment();
  const report = await executeBenchmark(context);
  const files = await writeReports(report, options.outputDirectory);
  console.log(`JSON report: ${files.jsonPath}`);
  console.log(`Markdown report: ${files.markdownPath}`);
} finally {
  await Promise.allSettled([workloadPool.end(), metricsPool.end()]);
  redis.disconnect();
}

async function verifyEnvironment() {
  const [workloadMetadata, metricsMetadata] = await Promise.all([
    readPostgresMetadata(workloadPool),
    readPostgresMetadata(metricsPool),
    redis.ping(),
  ]);
  if (workloadMetadata.database_name !== metricsMetadata.database_name) {
    throw new Error('DATABASE_URL and METRICS_DATABASE_URL must target the same database');
  }
  await Promise.all(options.pipelines.map(verifyPipelineSchema));
  return { workloadMetadata, metricsMetadata };
}

async function verifyPipelineSchema(pipeline) {
  const definition = getPipelineDefinition(pipeline);
  const result = await workloadPool.query('SELECT to_regnamespace($1) IS NOT NULL AS exists', [
    definition.schema,
  ]);
  if (!result.rows[0]?.exists) {
    throw new Error(`Missing isolated benchmark schema: ${definition.schema}`);
  }
}

async function executeBenchmark(context) {
  console.log(`Target: ${describeTarget(options.databaseUrl)}`);
  console.log(`Pipelines: ${options.pipelines.join(', ')}`);
  await runWarmups();
  const runs = await runMeasuredRounds();
  return buildReport(context, runs);
}

async function runWarmups() {
  if (options.warmupEvents === 0) return;
  for (const pipeline of options.pipelines) {
    console.log(`Warm-up: ${pipeline} (${options.warmupEvents} events)`);
    await runWorkload({
      pool: workloadPool,
      redis,
      pipeline,
      eventCount: options.warmupEvents,
      concurrency: options.concurrency,
      timeoutMilliseconds: options.timeoutMilliseconds,
    });
  }
}

async function runMeasuredRounds() {
  const runs = Object.fromEntries(options.pipelines.map((pipeline) => [pipeline, []]));
  for (let round = 1; round <= options.runs; round += 1) {
    for (const pipeline of orderPipelines(round)) {
      const result = await runMeasuredWorkload(pipeline, round);
      runs[pipeline].push(result);
      console.table({ [`${pipeline} run ${round}`]: result.workload });
    }
  }
  return runs;
}

function orderPipelines(round) {
  if (round % 2 === 1) return options.pipelines;
  return [...options.pipelines].reverse();
}

async function runMeasuredWorkload(pipeline, round) {
  console.log(`Measured run ${round}/${options.runs}: ${pipeline}`);
  const before = await capturePostgresSnapshot(metricsPool, pipeline);
  const workload = await runWorkload({
    pool: workloadPool,
    redis,
    pipeline,
    eventCount: options.events,
    concurrency: options.concurrency,
    timeoutMilliseconds: options.timeoutMilliseconds,
  });
  await flushWorkloadStatistics();
  await delay(options.metricsSettleMilliseconds);
  const after = await capturePostgresSnapshot(metricsPool, pipeline);
  return { round, workload, postgres: calculatePostgresDelta(before, after) };
}

async function flushWorkloadStatistics() {
  const clients = await Promise.all(
    Array.from({ length: options.concurrency }, () => workloadPool.connect()),
  );
  try {
    await Promise.all(clients.map((client) => client.query('SELECT pg_stat_force_next_flush()')));
  } finally {
    clients.forEach((client) => client.release());
  }
}

function buildReport(context, runs) {
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    target: describeTarget(options.databaseUrl),
    environment: options.environment,
    configuration: {
      pipelines: options.pipelines,
      eventsPerRun: options.events,
      warmupEvents: options.warmupEvents,
      runs: options.runs,
      concurrency: options.concurrency,
      timeoutMilliseconds: options.timeoutMilliseconds,
      metricsSettleMilliseconds: options.metricsSettleMilliseconds,
    },
    postgres: {
      database: context.metricsMetadata.database_name,
      serverVersion: context.metricsMetadata.server_version,
      trackIoTiming: context.metricsMetadata.track_io_timing,
      pgStatStatements: context.metricsMetadata.has_pg_stat_statements,
      metricsUser: context.metricsMetadata.metrics_user,
    },
    caveats: buildCaveats(context.metricsMetadata),
    pipelines: Object.fromEntries(
      options.pipelines.map((pipeline) => [pipeline, summarizePipeline(runs[pipeline])]),
    ),
    runs,
  };
}

function summarizePipeline(runs) {
  const workloads = runs.map((run) => run.workload);
  const postgres = runs.map((run) => run.postgres);
  return {
    totalEvents: sum(workloads.map((result) => result.events)),
    medianWriteMilliseconds: median(workloads.map((result) => result.writeMilliseconds)),
    medianEndToEndMilliseconds: median(workloads.map((result) => result.endToEndMilliseconds)),
    aggregateWritesPerSecond: calculateAggregateRate(workloads, 'writeMilliseconds'),
    aggregateEventsPerSecond: calculateAggregateRate(workloads, 'endToEndMilliseconds'),
    maximumOutboxBacklog: Math.max(...workloads.map((result) => result.outboxBacklog)),
    postgres: summarizePostgres(postgres),
  };
}

function summarizePostgres(results) {
  return {
    database: sumObjects(results.map((result) => result.database)),
    wal: sumObjects(results.map((result) => result.wal)),
    tables: {
      ...sumObjects(results.map((result) => result.tables), ['deadTuplesAfter']),
      deadTuplesAfter: results.at(-1)?.tables.deadTuplesAfter ?? null,
    },
    statements: summarizeStatements(results.flatMap((result) => result.statements)),
    replicationSlotAfter: results.at(-1)?.replicationSlotAfter ?? null,
  };
}

function summarizeStatements(statements) {
  const byId = new Map();
  for (const statement of statements) {
    const current = byId.get(statement.queryId) ?? { queryId: statement.queryId, query: statement.query };
    byId.set(statement.queryId, { ...current, ...sumStatement(current, statement) });
  }
  return [...byId.values()]
    .sort((left, right) => right.totalExecutionMilliseconds - left.totalExecutionMilliseconds)
    .slice(0, 20);
}

function sumStatement(current, statement) {
  const result = {};
  for (const [name, value] of Object.entries(statement)) {
    if (name === 'queryId' || name === 'query') continue;
    result[name] = Number(current[name] ?? 0) + Number(value ?? 0);
  }
  return result;
}

async function writeReports(report, outputDirectory) {
  const absoluteDirectory = path.resolve(outputDirectory);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');
  const basePath = path.join(absoluteDirectory, `change-relay-${timestamp}`);
  await mkdir(absoluteDirectory, { recursive: true });
  await Promise.all([
    writeFile(`${basePath}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(`${basePath}.md`, renderMarkdown(report), 'utf8'),
  ]);
  return { jsonPath: `${basePath}.json`, markdownPath: `${basePath}.md` };
}

function renderMarkdown(report) {
  const lines = [
    '# Change relay benchmark report',
    '',
    `Generated: ${report.generatedAt}`,
    `Target: \`${report.target}\``,
    `Environment: \`${report.environment}\``,
    `PostgreSQL: \`${report.postgres.serverVersion}\``,
    '',
    '## Configuration',
    '',
    `- Runs: ${report.configuration.runs}`,
    `- Events per measured run: ${formatNumber(report.configuration.eventsPerRun)}`,
    `- Warm-up events: ${formatNumber(report.configuration.warmupEvents)}`,
    `- Concurrency: ${report.configuration.concurrency}`,
    `- PostgreSQL metrics settle time: ${report.configuration.metricsSettleMilliseconds} ms`,
    '',
    '## Results',
    '',
    '| Pipeline | Total events | Writes/sec | End-to-end events/sec | Median write | Median end-to-end | Max backlog |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.pipelines).map(([name, result]) =>
      `| ${name} | ${formatNumber(result.totalEvents)} | ${formatNumber(result.aggregateWritesPerSecond)} | ${formatNumber(result.aggregateEventsPerSecond)} | ${result.medianWriteMilliseconds} ms | ${result.medianEndToEndMilliseconds} ms | ${result.maximumOutboxBacklog} |`),
    '',
    '## PostgreSQL deltas',
    '',
    '| Pipeline | DB active time | Read I/O | Write I/O | WAL | WAL records | Commits | Cache hit | Inserts | Updates | Deletes | Deadlocks |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.pipelines).map(([name, result]) => renderPostgresRow(name, result.postgres)),
    '',
    'Database and WAL counters include concurrent traffic on the same PostgreSQL database or cluster.',
    'Schema table counters and statements referencing the benchmark schemas are the isolated measurements.',
    '',
    '## Top statements',
    '',
    ...renderTopStatements(report.pipelines),
    '## Caveats',
    '',
    ...report.caveats.map((caveat) => `- ${caveat}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function renderPostgresRow(name, postgres) {
  const database = postgres.database;
  const tables = postgres.tables;
  const blockTotal = database.blocksHit + database.blocksRead;
  const cacheHit = blockTotal === 0 ? 'n/a' : `${(100 * database.blocksHit / blockTotal).toFixed(2)}%`;
  return `| ${name} | ${formatDuration(database.activeTimeMilliseconds)} | ${formatDuration(database.blockReadMilliseconds)} | ${formatDuration(database.blockWriteMilliseconds)} | ${formatBytes(postgres.wal.bytes)} | ${formatNumber(postgres.wal.records)} | ${formatNumber(database.xactCommit)} | ${cacheHit} | ${formatNumber(tables.tuplesInserted)} | ${formatNumber(tables.tuplesUpdated)} | ${formatNumber(tables.tuplesDeleted)} | ${database.deadlocks} |`;
}

function renderTopStatements(pipelines) {
  return Object.entries(pipelines).flatMap(([name, result]) => {
    const rows = result.postgres.statements.slice(0, 5).map((statement) => {
      const mean = statement.calls === 0 ? 0 : statement.totalExecutionMilliseconds / statement.calls;
      const readIo = formatDuration(statement.sharedBlockReadMilliseconds);
      const writeIo = formatDuration(statement.sharedBlockWriteMilliseconds);
      return `| ${formatNumber(statement.calls)} | ${statement.totalExecutionMilliseconds.toFixed(1)} ms | ${mean.toFixed(3)} ms | ${readIo} | ${writeIo} | \`${escapeTable(statement.query.slice(0, 140))}\` |`;
    });
    return [
      `### ${name}`,
      '',
      '| Calls | Total execution | Mean execution | Read I/O | Write I/O | Query |',
      '| ---: | ---: | ---: | ---: | ---: | --- |',
      ...(rows.length === 0 ? ['| 0 | 0 ms | 0 ms | 0 ms | 0 ms | Query metrics unavailable |'] : rows),
      '',
    ];
  });
}

function buildCaveats(metadata) {
  const caveats = [
    'The benchmark writes only to benchmark_publisher and benchmark_debezium.',
    'Redis benchmark streams are appended to and are not deleted by this script.',
    'Global database and WAL deltas can include unrelated production traffic.',
    'Only the selected relay should be running and connected to its benchmark schema.',
  ];
  if (metadata.track_io_timing !== 'on') {
    caveats.push('track_io_timing is off, so PostgreSQL read/write timing is unavailable.');
  }
  if (!metadata.has_pg_stat_statements) {
    caveats.push('pg_stat_statements is unavailable, so per-query metrics are omitted.');
  }
  return caveats;
}

function readOptions(arguments_, environment) {
  const environmentName = readArgument(arguments_, '--environment')
    ?? (environment.NODE_ENV === 'production' ? 'production' : 'local');
  return {
    environment: environmentName,
    productionConfirmed: arguments_.includes('--confirm-production-benchmark'),
    pipelines: [readPipeline(arguments_)],
    events: readPositiveInteger(arguments_, '--events', 20_000),
    warmupEvents: readNonNegativeInteger(arguments_, '--warmup-events', 2_000),
    runs: readPositiveInteger(arguments_, '--runs', 3),
    concurrency: readPositiveInteger(arguments_, '--concurrency', 32, 256),
    timeoutMilliseconds: readPositiveInteger(arguments_, '--timeout-ms', 120_000),
    metricsSettleMilliseconds: readNonNegativeInteger(arguments_, '--metrics-settle-ms', 1_200),
    outputDirectory: readArgument(arguments_, '--output-dir') ?? 'infra/benchmark/reports',
    databaseUrl:
      environment.DATABASE_URL
      ?? 'postgresql://atlas_writer:atlas_writer@localhost:5432/atlas',
    metricsDatabaseUrl:
      environment.METRICS_DATABASE_URL
      ?? environment.DATABASE_URL
      ?? 'postgresql://atlas_writer:atlas_writer@localhost:5432/atlas',
    redisUrl: environment.REDIS_URL ?? 'redis://localhost:6380',
  };
}

function validateProductionConfirmation(configuration) {
  if (configuration.environment !== 'production') return;
  if (configuration.productionConfirmed) return;
  throw new Error(
    'Production runs require --confirm-production-benchmark because this command generates writes',
  );
}

function readPipeline(arguments_) {
  const pipeline = readArgument(arguments_, '--pipeline')
    ?? readArgument(arguments_, '--pipelines');
  if (pipeline === 'publisher' || pipeline === 'debezium') return pipeline;
  throw new Error('Choose exactly one --pipeline: publisher or debezium');
}

function readPositiveInteger(arguments_, name, defaultValue, maximum = Number.MAX_SAFE_INTEGER) {
  const value = readNonNegativeInteger(arguments_, name, defaultValue);
  if (value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function readNonNegativeInteger(arguments_, name, defaultValue) {
  const rawValue = readArgument(arguments_, name);
  if (rawValue === undefined) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function readArgument(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function calculateAggregateRate(workloads, durationName) {
  const totalEvents = sum(workloads.map((result) => result.events));
  const totalMilliseconds = sum(workloads.map((result) => result[durationName]));
  return Math.round(totalEvents * 1_000 / totalMilliseconds);
}

function sumObjects(objects, excludedNames = []) {
  const names = new Set(objects.flatMap((object) => Object.keys(object)));
  return Object.fromEntries(
    [...names]
      .filter((name) => !excludedNames.includes(name))
      .map((name) => [name, sumNullable(objects.map((object) => object[name]))]),
  );
}

function sumNullable(values) {
  if (values.some((value) => value === null)) return null;
  return sum(values.map((value) => Number(value ?? 0)));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function describeTarget(connectionString) {
  const target = new URL(connectionString);
  const port = target.port === '' ? '5432' : target.port;
  return `${target.hostname}:${port}${target.pathname}`;
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function formatDuration(milliseconds) {
  return `${(Number(milliseconds ?? 0) / 1_000).toFixed(1)} s`;
}

function escapeTable(value) {
  return value.replaceAll('|', '\\|').replaceAll('`', '\\`');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
