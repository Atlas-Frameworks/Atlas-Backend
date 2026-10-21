import { performance } from 'node:perf_hooks';

export const entityTypes = ['customers', 'items', 'orders', 'distributors'];

export const pipelineDefinitions = {
  publisher: {
    name: 'publisher',
    schema: 'benchmark_publisher',
    streamPrefix: 'changes:benchmark_publisher_',
  },
  debezium: {
    name: 'debezium',
    schema: 'benchmark_debezium',
    streamPrefix: 'changes:benchmark_debezium_',
  },
};

export async function runWorkload({
  pool,
  redis,
  pipeline,
  eventCount,
  concurrency,
  timeoutMilliseconds,
}) {
  const definition = getPipelineDefinition(pipeline);
  const idsByEntity = await loadEntityIds(pool, definition.schema);
  const startingLengths = await readStreamLengths(redis, definition.streamPrefix);
  const expectedByEntity = countExpectedEvents(eventCount);
  const runId = crypto.randomUUID();
  const writeStartedAt = performance.now();
  await runConcurrentUpdates({
    pool,
    schema: definition.schema,
    idsByEntity,
    runId,
    eventCount,
    concurrency,
  });
  const writeFinishedAt = performance.now();
  await waitForDelivery({
    redis,
    streamPrefix: definition.streamPrefix,
    startingLengths,
    expectedByEntity,
    timeoutMilliseconds,
  });
  const deliveryFinishedAt = performance.now();
  const outboxBacklog = await readOutboxBacklog(pool, definition.schema);
  return buildWorkloadResult({
    eventCount,
    concurrency,
    writeStartedAt,
    writeFinishedAt,
    deliveryFinishedAt,
    outboxBacklog,
  });
}

export function getPipelineDefinition(pipeline) {
  const definition = pipelineDefinitions[pipeline];
  if (definition === undefined) {
    throw new Error(`Unknown pipeline: ${pipeline}`);
  }
  return definition;
}

async function loadEntityIds(pool, schema) {
  const entries = await Promise.all(
    entityTypes.map(async (entityType) => {
      const result = await pool.query(`SELECT id FROM ${schema}.${entityType} ORDER BY id`);
      if (result.rows.length === 0) {
        throw new Error(`${schema}.${entityType} has no seed rows`);
      }
      return [entityType, result.rows.map((row) => row.id)];
    }),
  );
  return Object.fromEntries(entries);
}

function countExpectedEvents(eventCount) {
  const counts = Object.fromEntries(entityTypes.map((entityType) => [entityType, 0]));
  for (let index = 0; index < eventCount; index += 1) {
    counts[entityTypes[index % entityTypes.length]] += 1;
  }
  return counts;
}

async function runConcurrentUpdates(options) {
  let nextIndex = 0;
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (nextIndex < options.eventCount) {
      const eventIndex = nextIndex;
      nextIndex += 1;
      if (eventIndex >= options.eventCount) return;
      await updateEntity(options, eventIndex);
    }
  });
  await Promise.all(workers);
}

async function updateEntity(options, eventIndex) {
  const entityType = entityTypes[eventIndex % entityTypes.length];
  const ids = options.idsByEntity[entityType];
  const entityEventIndex = Math.floor(eventIndex / entityTypes.length);
  const id = ids[entityEventIndex % ids.length];
  await options.pool.query(
    `UPDATE ${options.schema}.${entityType}
     SET data = jsonb_build_object('runId', $1::text, 'eventIndex', $2::integer)
     WHERE id = $3::uuid`,
    [options.runId, eventIndex, id],
  );
}

async function readStreamLengths(redis, streamPrefix) {
  const lengths = await Promise.all(
    entityTypes.map((entityType) => redis.xlen(`${streamPrefix}${entityType}`)),
  );
  return Object.fromEntries(
    entityTypes.map((entityType, index) => [entityType, lengths[index]]),
  );
}

async function waitForDelivery(options) {
  const deadline = Date.now() + options.timeoutMilliseconds;
  while (Date.now() < deadline) {
    const lengths = await readStreamLengths(options.redis, options.streamPrefix);
    if (hasDeliveredAllEvents(lengths, options)) return;
    await delay(25);
  }
  throw new Error(`Timed out after ${options.timeoutMilliseconds}ms waiting for Redis delivery`);
}

function hasDeliveredAllEvents(currentLengths, options) {
  return entityTypes.every((entityType) =>
    currentLengths[entityType] - options.startingLengths[entityType]
      >= options.expectedByEntity[entityType]);
}

async function readOutboxBacklog(pool, schema) {
  const result = await pool.query(
    `SELECT sum(pending_count)::bigint AS pending_count
     FROM (
       SELECT count(*) AS pending_count FROM ${schema}.customers_outbox
       UNION ALL SELECT count(*) FROM ${schema}.items_outbox
       UNION ALL SELECT count(*) FROM ${schema}.orders_outbox
       UNION ALL SELECT count(*) FROM ${schema}.distributors_outbox
     ) AS pending`,
  );
  return Number(result.rows[0]?.pending_count ?? 0);
}

function buildWorkloadResult(options) {
  const writeMilliseconds = options.writeFinishedAt - options.writeStartedAt;
  const endToEndMilliseconds = options.deliveryFinishedAt - options.writeStartedAt;
  return {
    events: options.eventCount,
    concurrency: options.concurrency,
    writeMilliseconds: Math.round(writeMilliseconds),
    writesPerSecond: Math.round(options.eventCount * 1_000 / writeMilliseconds),
    endToEndMilliseconds: Math.round(endToEndMilliseconds),
    eventsPerSecond: Math.round(options.eventCount * 1_000 / endToEndMilliseconds),
    outboxBacklog: options.outboxBacklog,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
