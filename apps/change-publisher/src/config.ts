export interface PublisherConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly sourceSchema: 'benchmark_publisher';
  readonly owner: string;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly idleDelayMilliseconds: number;
}

export function readPublisherConfig(environment: NodeJS.ProcessEnv): PublisherConfig {
  return {
    databaseUrl:
      environment['DATABASE_URL'] ??
      'postgresql://atlas_publisher:atlas_publisher@localhost:5432/atlas',
    redisUrl: environment['REDIS_URL'] ?? 'redis://localhost:6380',
    sourceSchema: readSourceSchema(environment),
    owner: environment['PUBLISHER_ID'] ?? `${process.pid}-${crypto.randomUUID()}`,
    batchSize: readPositiveInteger(environment, 'PUBLISHER_BATCH_SIZE', 1_000),
    leaseSeconds: readPositiveInteger(environment, 'PUBLISHER_LEASE_SECONDS', 30),
    idleDelayMilliseconds: readPositiveInteger(environment, 'PUBLISHER_IDLE_DELAY_MS', 100),
  };
}

function readSourceSchema(environment: NodeJS.ProcessEnv): 'benchmark_publisher' {
  const sourceSchema = environment['PUBLISHER_SCHEMA'] ?? 'benchmark_publisher';
  if (sourceSchema !== 'benchmark_publisher') {
    throw new Error('PUBLISHER_SCHEMA must be benchmark_publisher');
  }
  return sourceSchema;
}

function readPositiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const rawValue = environment[name];
  if (rawValue === undefined) return defaultValue;

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
