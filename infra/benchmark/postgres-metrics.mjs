import { getPipelineDefinition } from './workload.mjs';

const databaseCounterNames = [
  'xactCommit',
  'xactRollback',
  'blocksRead',
  'blocksHit',
  'blockReadMilliseconds',
  'blockWriteMilliseconds',
  'tuplesReturned',
  'tuplesFetched',
  'tuplesInserted',
  'tuplesUpdated',
  'tuplesDeleted',
  'tempFiles',
  'tempBytes',
  'deadlocks',
  'conflicts',
  'activeTimeMilliseconds',
];
const walCounterNames = [
  'records',
  'fullPageImages',
  'bytes',
  'buffersFull',
  'writes',
  'syncs',
  'writeMilliseconds',
  'syncMilliseconds',
];
const tableCounterNames = [
  'sequentialScans',
  'indexScans',
  'tuplesInserted',
  'tuplesUpdated',
  'tuplesDeleted',
];
const statementCounterNames = [
  'calls',
  'totalExecutionMilliseconds',
  'rows',
  'sharedBlocksHit',
  'sharedBlocksRead',
  'sharedBlocksDirtied',
  'sharedBlocksWritten',
  'sharedBlockReadMilliseconds',
  'sharedBlockWriteMilliseconds',
  'walRecords',
  'walFullPageImages',
  'walBytes',
];

export async function readPostgresMetadata(pool) {
  const result = await pool.query(
    `SELECT current_database() AS database_name,
            current_user AS metrics_user,
            current_setting('server_version') AS server_version,
            current_setting('track_io_timing') AS track_io_timing,
            EXISTS (
              SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
            ) AS has_pg_stat_statements`,
  );
  return result.rows[0];
}

export async function capturePostgresSnapshot(pool, pipeline) {
  const definition = getPipelineDefinition(pipeline);
  const [database, wal, tables, statements, replicationSlot] = await Promise.all([
    readDatabaseMetrics(pool),
    readWalMetrics(pool),
    readTableMetrics(pool, definition.schema),
    readStatementMetrics(pool, definition),
    readReplicationSlot(pool, pipeline),
  ]);
  return { capturedAt: new Date().toISOString(), database, wal, tables, statements, replicationSlot };
}

export function calculatePostgresDelta(before, after) {
  return {
    database: subtractCounters(before.database, after.database, databaseCounterNames),
    wal: subtractCounters(before.wal, after.wal, walCounterNames),
    tables: {
      ...subtractCounters(before.tables, after.tables, tableCounterNames),
      deadTuplesAfter: after.tables.deadTuples,
    },
    statements: calculateStatementDeltas(before.statements, after.statements),
    replicationSlotAfter: after.replicationSlot,
  };
}

async function readDatabaseMetrics(pool) {
  const result = await pool.query(
    `SELECT xact_commit AS "xactCommit",
            xact_rollback AS "xactRollback",
            blks_read AS "blocksRead",
            blks_hit AS "blocksHit",
            blk_read_time AS "blockReadMilliseconds",
            blk_write_time AS "blockWriteMilliseconds",
            tup_returned AS "tuplesReturned",
            tup_fetched AS "tuplesFetched",
            tup_inserted AS "tuplesInserted",
            tup_updated AS "tuplesUpdated",
            tup_deleted AS "tuplesDeleted",
            temp_files AS "tempFiles",
            temp_bytes AS "tempBytes",
            deadlocks,
            conflicts,
            active_time AS "activeTimeMilliseconds"
     FROM pg_stat_database
     WHERE datname = current_database()`,
  );
  return normalizeNumbers(result.rows[0]);
}

async function readWalMetrics(pool) {
  const result = await pool.query(
    `SELECT wal_records AS records,
            wal_fpi AS "fullPageImages",
            wal_bytes AS bytes,
            wal_buffers_full AS "buffersFull",
            wal_write AS writes,
            wal_sync AS syncs,
            wal_write_time AS "writeMilliseconds",
            wal_sync_time AS "syncMilliseconds"
     FROM pg_stat_wal`,
  );
  return normalizeNumbers(result.rows[0]);
}

async function readTableMetrics(pool, schema) {
  const result = await pool.query(
    `SELECT coalesce(sum(seq_scan), 0) AS "sequentialScans",
            coalesce(sum(idx_scan), 0) AS "indexScans",
            coalesce(sum(n_tup_ins), 0) AS "tuplesInserted",
            coalesce(sum(n_tup_upd), 0) AS "tuplesUpdated",
            coalesce(sum(n_tup_del), 0) AS "tuplesDeleted",
            coalesce(sum(n_dead_tup), 0) AS "deadTuples"
     FROM pg_stat_user_tables
     WHERE schemaname = $1`,
    [schema],
  );
  return normalizeNumbers(result.rows[0]);
}

async function readStatementMetrics(pool, definition) {
  const extension = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS enabled",
  );
  if (!extension.rows[0]?.enabled) return [];
  const patterns = [`%${definition.schema}.%`];
  if (definition.name === 'publisher') {
    patterns.push('%claim_sync_events%', '%mark_sync_events_published%');
  }
  const result = await pool.query(
    `SELECT queryid::text AS "queryId",
            query,
            sum(calls) AS calls,
            sum(total_exec_time) AS "totalExecutionMilliseconds",
            sum(rows) AS rows,
            sum(shared_blks_hit) AS "sharedBlocksHit",
            sum(shared_blks_read) AS "sharedBlocksRead",
            sum(shared_blks_dirtied) AS "sharedBlocksDirtied",
            sum(shared_blks_written) AS "sharedBlocksWritten",
            sum(shared_blk_read_time) AS "sharedBlockReadMilliseconds",
            sum(shared_blk_write_time) AS "sharedBlockWriteMilliseconds",
            sum(wal_records) AS "walRecords",
            sum(wal_fpi) AS "walFullPageImages",
            sum(wal_bytes) AS "walBytes"
     FROM pg_stat_statements
     WHERE query ILIKE ANY($1::text[])
     GROUP BY queryid, query`,
    [patterns],
  );
  return result.rows.map((row) => ({
    queryId: row.queryId,
    query: row.query,
    ...normalizeNamedNumbers(row, statementCounterNames),
  }));
}

async function readReplicationSlot(pool, pipeline) {
  if (pipeline !== 'debezium') return null;
  const result = await pool.query(
    `SELECT slot_name AS "slotName",
            active,
            pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS "consumerLagBytes",
            pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS "retainedWalBytes"
     FROM pg_replication_slots
     WHERE slot_name = 'benchmark_debezium_outbox'`,
  );
  if (result.rows.length === 0) return null;
  return { ...result.rows[0], ...normalizeNumbers(result.rows[0]) };
}

function calculateStatementDeltas(beforeRows, afterRows) {
  const beforeById = new Map(beforeRows.map((row) => [row.queryId, row]));
  return afterRows
    .map((after) => buildStatementDelta(beforeById.get(after.queryId), after))
    .filter((statement) => statement.calls > 0)
    .sort((left, right) => right.totalExecutionMilliseconds - left.totalExecutionMilliseconds);
}

function buildStatementDelta(before, after) {
  const baseline = before ?? Object.fromEntries(statementCounterNames.map((name) => [name, 0]));
  return {
    queryId: after.queryId,
    query: compactQuery(after.query),
    ...subtractCounters(baseline, after, statementCounterNames),
  };
}

function subtractCounters(before, after, names) {
  return Object.fromEntries(names.map((name) => [name, subtractCounter(before[name], after[name])]));
}

function subtractCounter(before, after) {
  const difference = Number(after ?? 0) - Number(before ?? 0);
  return difference < 0 ? null : difference;
}

function normalizeNumbers(row) {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [name, isNumericValue(value) ? Number(value) : value]),
  );
}

function normalizeNamedNumbers(row, names) {
  return Object.fromEntries(names.map((name) => [name, Number(row[name] ?? 0)]));
}

function isNumericValue(value) {
  return typeof value === 'number' || typeof value === 'bigint'
    || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));
}

function compactQuery(query) {
  return String(query ?? '<query text unavailable>').replace(/\s+/g, ' ').trim();
}
