import { readFile } from 'node:fs/promises';

export interface PublisherConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly sourceSchema: 'benchmark_publisher';
  readonly owner: string;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly idleDelayMilliseconds: number;
}

interface PublisherConfigValues {
  readonly databaseUrl: unknown;
  readonly redisUrl: unknown;
  readonly sourceSchema: unknown;
  readonly owner?: unknown;
  readonly batchSize: unknown;
  readonly leaseSeconds: unknown;
  readonly idleDelayMilliseconds: unknown;
}

interface CreatePublisherConfigOptions {
  readonly defaultValues: unknown;
  readonly environmentValues?: unknown;
  readonly generateOwner?: () => string;
}

const configDirectory = new URL('../config/', import.meta.url);
const environmentNamePattern = /^[a-zA-Z0-9_-]+$/;

export async function loadPublisherConfig(
  environmentName?: string,
): Promise<PublisherConfig> {
  validateEnvironmentName(environmentName);
  const defaultValues = await readConfigFile(new URL('default.json', configDirectory));
  const environmentValues = environmentName === undefined
    ? undefined
    : await readConfigFile(new URL(`${environmentName}.json`, configDirectory));
  return createPublisherConfig({ defaultValues, environmentValues });
}

export function createPublisherConfig(
  options: CreatePublisherConfigOptions,
): PublisherConfig {
  const defaultValues = readConfigValues(options.defaultValues, 'default config');
  const environmentValues = readPartialConfigValues(options.environmentValues);
  const values = { ...defaultValues, ...environmentValues };
  return {
    databaseUrl: readNonEmptyString(values.databaseUrl, 'databaseUrl'),
    redisUrl: readNonEmptyString(values.redisUrl, 'redisUrl'),
    sourceSchema: readSourceSchema(values.sourceSchema),
    owner: readOwner(values.owner, options.generateOwner),
    batchSize: readPositiveInteger(values.batchSize, 'batchSize'),
    leaseSeconds: readPositiveInteger(values.leaseSeconds, 'leaseSeconds'),
    idleDelayMilliseconds: readPositiveInteger(
      values.idleDelayMilliseconds,
      'idleDelayMilliseconds',
    ),
  };
}

async function readConfigFile(fileUrl: URL): Promise<unknown> {
  try {
    return JSON.parse(await readFile(fileUrl, 'utf8')) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load Publisher config ${fileUrl.pathname}: ${message}`);
  }
}

function readConfigValues(value: unknown, label: string): PublisherConfigValues {
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object`);
  return {
    databaseUrl: value['databaseUrl'],
    redisUrl: value['redisUrl'],
    sourceSchema: value['sourceSchema'],
    owner: value['owner'],
    batchSize: value['batchSize'],
    leaseSeconds: value['leaseSeconds'],
    idleDelayMilliseconds: value['idleDelayMilliseconds'],
  };
}

function readPartialConfigValues(value: unknown): Partial<PublisherConfigValues> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('environment config must contain a JSON object');
  return value;
}

function readSourceSchema(value: unknown): 'benchmark_publisher' {
  if (value !== 'benchmark_publisher') {
    throw new Error('sourceSchema must be benchmark_publisher');
  }
  return value;
}

function readOwner(value: unknown, generateOwner = createOwner): string {
  if (value === undefined) return generateOwner();
  return readNonEmptyString(value, 'owner');
}

function createOwner(): string {
  return `${process.pid}-${crypto.randomUUID()}`;
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function readPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateEnvironmentName(environmentName: string | undefined): void {
  if (environmentName === undefined) return;
  if (!environmentNamePattern.test(environmentName)) {
    throw new Error('PUBLISHER_ENV may contain only letters, numbers, underscores, and hyphens');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
