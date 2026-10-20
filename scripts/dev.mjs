#!/usr/bin/env node
// Local development launcher (task F-02). Cross-platform: no shell-specific env syntax.
//
//   node scripts/dev.mjs watch          one compiler watcher for all packages and Node apps
//   node scripts/dev.mjs view-service   one worker; WORKER_NAME, PORT, GRPC_PORT from env or .env
//   node scripts/dev.mjs replicator     replicator-sim
//   node scripts/dev.mjs cluster        compiler watcher + 3 view-service workers on distinct ports
//
// Apps run from dist/ with `node --watch`, so they restart whenever the watcher recompiles.
// Only one compiler writes dist/, which is why several workers can run side by side.
// Each app reads apps/<app>/.env (copied from .env.example on first run); variables already set
// in the environment win over the file.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import concurrently from 'concurrently';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const buildProjects = [
  'apps/view-service/tsconfig.build.json',
  'apps/replicator-sim/tsconfig.build.json',
];

/** The 3 local workers. Ports avoid Grafana (3001) and the replicator (3100). */
const CLUSTER = [
  { WORKER_NAME: 'view-service-0', PORT: '3000', GRPC_PORT: '50051' },
  { WORKER_NAME: 'view-service-1', PORT: '3010', GRPC_PORT: '50052' },
  { WORKER_NAME: 'view-service-2', PORT: '3020', GRPC_PORT: '50053' },
];

function ensureEnvFile(app) {
  const dir = join(root, 'apps', app);
  const envFile = join(dir, '.env');
  if (!existsSync(envFile)) {
    copyFileSync(join(dir, '.env.example'), envFile);
    console.log(`[dev] created ${relative(root, envFile)} from .env.example`);
  }
}

function buildOnce() {
  console.log('[dev] building packages and apps (incremental)...');
  const result = spawnSync(process.execPath, [tsc, '-b', ...buildProjects], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const watcher = {
  name: 'tsc',
  command: `node "${tsc}" -b ${buildProjects.join(' ')} --watch --preserveWatchOutput`,
  cwd: root,
  prefixColor: 'gray',
};

function app(app, name, env = {}) {
  ensureEnvFile(app);
  return {
    name,
    command: 'node --watch --enable-source-maps --env-file-if-exists=.env dist/main.js',
    cwd: join(root, 'apps', app),
    env,
  };
}

async function run(commands) {
  const { result } = concurrently(commands, {
    prefix: 'name',
    killOthersOn: ['failure'],
    prefixColors: ['gray', 'cyan', 'magenta', 'yellow', 'green'],
  });
  try {
    await result;
  } catch {
    process.exitCode = 1;
  }
}

const target = process.argv[2];
switch (target) {
  case 'watch':
    await run([watcher]);
    break;
  case 'view-service':
    buildOnce();
    await run([app('view-service', process.env.WORKER_NAME ?? 'view-service')]);
    break;
  case 'replicator':
    buildOnce();
    await run([app('replicator-sim', 'replicator')]);
    break;
  case 'cluster':
    buildOnce();
    await run([watcher, ...CLUSTER.map((env) => app('view-service', env.WORKER_NAME, env))]);
    break;
  default:
    console.error('usage: node scripts/dev.mjs <watch|view-service|replicator|cluster>');
    process.exit(2);
}
