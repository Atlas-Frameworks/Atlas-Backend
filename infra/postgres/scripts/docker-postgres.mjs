import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, '..', '..', '..');

const composePrefix = ['compose', '-f', 'infra/docker-compose.yml'];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function runDocker(arguments_, { input, quiet = false, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const captureOutput = capture && !quiet;
    const child = spawn('docker', arguments_, {
      cwd: projectRoot,
      stdio: [
        input === undefined ? 'ignore' : 'pipe',
        quiet ? 'ignore' : captureOutput ? 'pipe' : 'inherit',
        quiet ? 'ignore' : 'inherit',
      ],
    });

    let stdout = '';
    if (captureOutput) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout: stdout.trim() });
    });

    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

export async function waitForPostgres() {
  const readinessArguments = [
    ...composePrefix,
    'exec',
    '-T',
    'postgres-primary',
    'pg_isready',
    '-U',
    'postgres',
    '-d',
    'atlas',
  ];

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = await runDocker(readinessArguments, { quiet: true });
    if (result.exitCode === 0) {
      return;
    }
    await delay(1_000);
  }

  throw new Error(
    'Postgres is not ready. Start Docker separately with `npm run infra:up`.',
  );
}

export async function runPsql(sql, user = 'postgres') {
  const result = await runDocker(
    [
      ...composePrefix,
      'exec',
      '-T',
      'postgres-primary',
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      user,
      '-d',
      'atlas',
    ],
    { input: sql },
  );

  if (result.exitCode !== 0) {
    throw new Error(`psql exited with code ${result.exitCode}`);
  }
}

export async function waitForDebeziumSlot(maxAttempts = 60) {
  const slotCheckArguments = [
    ...composePrefix,
    'exec',
    '-T',
    'postgres-primary',
    'psql',
    '-X',
    '-qAt',
    '-U',
    'postgres',
    '-d',
    'atlas',
    '-c',
    "SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'atlas_outbox');",
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runDocker(slotCheckArguments, { capture: true });
    if (result.exitCode === 0 && result.stdout === 't') {
      return;
    }
    await delay(1_000);
  }

  throw new Error(
    'Debezium replication slot is missing. Run `npm run postgres:setup` first.',
  );
}
