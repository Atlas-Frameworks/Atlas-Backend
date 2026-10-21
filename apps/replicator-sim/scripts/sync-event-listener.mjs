import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const defaultStreams = 'customers,items,orders,distributors';
const entityTypes = (process.env.SYNC_ENTITY_TYPES ?? defaultStreams)
  .split(',')
  .map((entityType) => entityType.trim())
  .filter(Boolean);

if (entityTypes.length === 0) {
  throw new Error('SYNC_ENTITY_TYPES must contain at least one entity type');
}

const streams = entityTypes.map((entityType) => `changes:${entityType}`);

const runOnce = process.argv.includes('--once');
const includeHistory = process.argv.includes('--history');
const readCount = readPositiveInteger('REDIS_READ_COUNT', 100);
const blockMilliseconds = readPositiveInteger('REDIS_BLOCK_MS', 5_000);

let stopping = false;
let activeChild;

function readPositiveInteger(name, defaultValue) {
  const rawValue = process.env[name];
  const value = rawValue === undefined ? defaultValue : Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${rawValue}`);
  }

  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runRedisCommand(commandArguments) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        '-f',
        'infra/docker-compose.yml',
        'exec',
        '-T',
        'redis-primary',
        'redis-cli',
        '--json',
        '-h',
        'redis-proxy',
        '-p',
        '6380',
        ...commandArguments,
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    activeChild = child;
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
      if (activeChild === child) {
        activeChild = undefined;
      }

      if (stopping) {
        resolve(null);
        return;
      }

      if (exitCode !== 0) {
        reject(
          new Error(
            `redis-cli exited with code ${exitCode}: ${stderr.trim() || 'unknown error'}`,
          ),
        );
        return;
      }

      const output = stdout.trim();
      resolve(output === '' || output === 'null' ? null : JSON.parse(output));
    });
  });
}

async function findCurrentStreamId(stream) {
  const entries = await runRedisCommand([
    'XREVRANGE',
    stream,
    '+',
    '-',
    'COUNT',
    '1',
  ]);

  return entries?.[0]?.[0] ?? '0-0';
}

async function createStartingCursors() {
  if (includeHistory) {
    return Object.fromEntries(streams.map((stream) => [stream, '0-0']));
  }

  const ids = await Promise.all(streams.map(findCurrentStreamId));
  return Object.fromEntries(streams.map((stream, index) => [stream, ids[index]]));
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function printEntry(stream, entryId, fields) {
  const valueIndex = fields.indexOf('value');
  const event = valueIndex === -1 ? null : parseJson(fields[valueIndex + 1]);

  console.log('\n------------------------------------------------------------');
  console.log(`[Redis] ${stream} | entry ${entryId}`);

  if (event !== null && typeof event === 'object') {
    console.log(
      `event: ${event.op ?? '?'} ${event.type ?? '?'} | version=${event.version ?? '?'} | typeSeq=${event.typeSeq ?? '?'}`,
    );
    console.log(JSON.stringify(event, null, 2));
  } else {
    console.log(`fields: ${JSON.stringify(fields)}`);
  }
}

function processBatch(batch, cursors) {
  if (batch === null) {
    return 0;
  }

  let eventCount = 0;
  for (const [stream, entries] of Object.entries(batch)) {
    for (const [entryId, fields] of entries) {
      cursors[stream] = entryId;
      printEntry(stream, entryId, fields);
      eventCount += 1;
    }
  }

  return eventCount;
}

async function readEvents(cursors) {
  return runRedisCommand([
    'XREAD',
    'BLOCK',
    String(runOnce ? 1 : blockMilliseconds),
    'COUNT',
    String(readCount),
    'STREAMS',
    ...streams,
    ...streams.map((stream) => cursors[stream]),
  ]);
}

function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  activeChild?.kill();
  console.log('\nStopping synchronization event listener...');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function main() {
  const cursors = await createStartingCursors();

  console.log(
    `Listening to ${streams.join(', ')} (${includeHistory ? 'history included' : 'new events only'})`,
  );

  if (runOnce) {
    const eventCount = processBatch(await readEvents(cursors), cursors);
    console.log(`\nRead ${eventCount} Redis event(s).`);
    return;
  }

  while (!stopping) {
    try {
      processBatch(await readEvents(cursors), cursors);
    } catch (error) {
      console.error(`[Redis] ${error.message}`);
      await delay(2_000);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`Listener failed: ${error.message}`);
  process.exitCode = 1;
}
