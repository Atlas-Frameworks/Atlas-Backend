# Local development

How to run the whole POC on one machine. For the design, see [architecture-plan.md](architecture-plan.md); for the infrastructure details, [infra/README.md](../infra/README.md).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24 (≥ 24.15) | `nvm use` reads `.nvmrc`. Angular 22 needs ≥ 24.15. `npm ci` refuses older versions (`engine-strict`). |
| npm | 11 | Pinned in `package.json` `packageManager`. Upgrade with `npm install -g npm@11`. |
| Docker | Docker Desktop 4.x, or Docker Engine + Compose v2 | Give it at least 6 GB of memory: Postgres ×2, Redis ×2, 3 Sentinels, HAProxy, Debezium (a JVM), Prometheus, Grafana and 3 exporters. |

## First run

```bash
nvm use                 # Node 24
npm ci                  # install all workspaces
npm run build           # build packages and apps once
npm run dev:infra       # Postgres primary + replica, Redis + Sentinel + proxy, Debezium (detached)
npm run dev:cluster     # 3 view-service workers + compiler watcher (keep this terminal open)
npm run dev:replicator  # replicator-sim (second terminal)
npm run dev:client      # Angular app on http://localhost:4200 (third terminal)
```

Check that it worked:

```bash
docker compose -f infra/docker-compose.yml ps   # every service "running" / "healthy"
curl localhost:3000 && curl localhost:3010 && curl localhost:3020   # the 3 workers
open http://localhost:4200                       # the client
```

Until the end-to-end tasks land (S-04, C-05, A-03, W-03), the expected end state is: infra up, three workers answering, client served, Grafana on http://localhost:3001 with infrastructure panels filled (worker panels fill once S-09 lands). Afterwards it is: the client shows the map with moving points.

## Startup order

Follow the plan's cold-start order ("Recovery after crashes and restarts"):

1. **Postgres** (primary, then the replica, which clones the primary on first start).
2. **Redis** (primary, replica, Sentinels, then the master-only proxy).
3. **Debezium Server** (needs Postgres healthy and the proxy up).

   `npm run dev:infra` starts 1 to 3 in this order through compose `depends_on` and healthchecks. Debezium waits for the replica too. The first run pulls about 2 GB of images and builds the local Debezium image (`infra/debezium/Dockerfile`); after that a cold start takes about 20 s.
4. **view-service workers** (`dev:cluster`, or `dev:view-service` for one).
5. **replicator-sim** (`dev:replicator`).
6. **Client** (`dev:client`).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev:infra` | `infra:up`: starts every container in the background. |
| `npm run dev:cluster` | Builds once, then runs one compiler watcher and 3 workers (`view-service-0..2`) on the ports below. Edits recompile and restart all workers. |
| `npm run dev:view-service` | Builds once and runs **one** worker. Reads `WORKER_NAME`, `PORT`, `GRPC_PORT` from the environment, then from `apps/view-service/.env`. Run several side by side with different values (see below). Doesn't recompile; run `dev:watch` alongside it. |
| `npm run dev:replicator` | Builds once and runs replicator-sim. Doesn't recompile; run `dev:watch` alongside it. |
| `npm run dev:watch` | One `tsc -b --watch` for all packages and Node apps. Running workers restart when it writes `dist/`. |
| `npm run dev:client` | `ng serve` with live reload. |
| `npm run infra:logs` | Follows all container logs. |
| `npm run infra:down` | Stops containers **and deletes all data volumes**. |

Several workers by hand (one terminal each, plus `npm run dev:watch`):

```bash
npm run dev:view-service
WORKER_NAME=view-service-1 PORT=3010 GRPC_PORT=50052 npm run dev:view-service
WORKER_NAME=view-service-2 PORT=3020 GRPC_PORT=50053 npm run dev:view-service
```

On Windows PowerShell set variables first: `$env:WORKER_NAME='view-service-1'; $env:PORT='3010'; $env:GRPC_PORT='50052'; npm run dev:view-service`.

Why apps run from `dist/`: three `nest start --watch` processes would all compile into the same `dist/` folder. Instead, one compiler writes `dist/` and each worker runs `node --watch dist/main.js`.

## Configuration

Each Node app validates its environment at startup (`src/config.ts`, using `@atlas/node-common`). A missing or invalid variable stops the app with exit code 1 and a list of every problem.

- `apps/<app>/.env.example` lists every variable the app reads, with its default.
- The first `dev:*` run copies it to `apps/<app>/.env` (git-ignored). Edit `.env` for local overrides.
- Variables already set in the shell win over `.env`.
- The Angular client reads no environment variables.

## Ports

| Port | Service | Notes |
| --- | --- | --- |
| 4200 | Angular client (`ng serve`) | |
| 3000 / 3010 / 3020 | view-service workers 0 / 1 / 2: HTTP + WebSocket | `dev:view-service` defaults to 3000 |
| 50051 / 50052 / 50053 | view-service workers 0 / 1 / 2: gRPC | Worker-to-worker, S-07 |
| 3100 | replicator-sim | |
| 5432 | Postgres primary | Writer: `postgres://atlas_writer:atlas_writer@localhost:5432/atlas` |
| 5433 | Postgres read replica | Reader: `postgres://atlas_reader:atlas_reader@localhost:5433/atlas` |
| 6380 | Redis master-only proxy (HAProxy) | `redis://localhost:6380`, always the current master |
| 8404 | HAProxy stats | http://localhost:8404/stats |
| 8080 | Debezium Server | Health: http://localhost:8080/q/health |
| 9404 | Debezium Prometheus metrics (JMX exporter) | http://localhost:9404/metrics |
| 3001 | Grafana | http://localhost:3001, dashboard "Atlas realtime" (see [infra/monitoring/README.md](../infra/monitoring/README.md)) |
| 9090 | Prometheus | http://localhost:9090, alerts at `/alerts` |

## Resetting data

```bash
npm run infra:down    # stops containers and deletes the volumes (Postgres data, Debezium offsets)
npm run infra:up      # recreates everything: schema from infra/postgres/init, replica re-clone, slots
```

Redis keeps no volume, so restarting its containers empties the streams and the worker list. Workers rebuild from Postgres (plan rule 1). To restart one service without losing data: `docker compose -f infra/docker-compose.yml restart debezium`.

Delete `dist/` folders (`rm -rf apps/*/dist packages/*/dist`) if a build ever looks stale.

## Running tests

```bash
npm test                                   # everything
npm test -w @atlas/view-engine             # one workspace
npm test -w @atlas/view-engine -- registry # one workspace, files matching "registry"
npx vitest                                 # inside a workspace folder: watch mode
npm run test:e2e -w @atlas/view-service    # Nest e2e specs (test/*.e2e-spec.ts)
```

- Each task's unit tests sit next to its code (`*.spec.ts`), so a task's tests are its workspace plus a file filter, e.g. E-01 → `npm test -w @atlas/view-engine -- registry`.
- Integration tests (Testcontainers, T-01) live under `test/integration/` and need Docker running.
- Workspace packages resolve to their TypeScript sources in tests and typechecking, so you don't need to build first.

Before opening a PR: `npm run lint && npm run typecheck && npm run build && npm test`. `npm run format` fixes formatting.

## Troubleshooting

### Any OS

| Symptom | Fix |
| --- | --- |
| `npm ci`: `EBADENGINE` / "Unsupported engine" | Wrong Node or npm. `nvm use`, then `npm install -g npm@11`. |
| `npm ci` warns about install scripts not covered by `allowScripts` | A new dependency needs a build step. Review it, then `npm install-scripts approve <pkg>` (or `deny`), and commit `package.json`. |
| A worker exits at once with `Invalid configuration` | The listed variables are missing or invalid. Check `apps/<app>/.env` against `.env.example`. |
| `EADDRINUSE` | Another process holds the port: `lsof -iTCP:<port> -sTCP:LISTEN` (macOS/Linux) or `netstat -ano \| findstr :<port>` (Windows). |
| Port 5432 already in use | A local Postgres is running. Stop it (`brew services stop postgresql`), or change the host port in `infra/docker-compose.yml`. |
| Workers can't reach Redis or Postgres | Apps on your machine use `localhost` ports, not container names. Redis goes through the proxy on 6380. |
| Debezium restarts in a loop | `docker compose -f infra/docker-compose.yml logs debezium`. A watchdog restarts it whenever `/q/health/live` is DOWN (see infra/debezium/README.md); look for the first `ERROR` line. |
| Debezium image is stale after editing `infra/debezium/Dockerfile` | `docker compose -f infra/docker-compose.yml build debezium && npm run infra:up` |
| Stale build output | `rm -rf apps/*/dist packages/*/dist && npm run build`. |

### macOS

- **Memory:** Docker Desktop → Settings → Resources: at least 6 GB. If the Debezium or Postgres containers exit with code 137, they ran out of memory.
- **Apple Silicon:** all images are multi-arch (arm64). If you pinned an amd64-only image, enable "Use Rosetta for x86/amd64 emulation".
- **File sharing:** the compose file bind-mounts files from `infra/`. Keep the repo under your home folder, or add its location in Settings → Resources → File sharing.

### Windows

- **Use WSL 2.** Install Docker Desktop with the WSL 2 backend, then clone and run the repo **inside the WSL filesystem** (`~/src/...`), not under `/mnt/c`. Bind mounts and file watching are slow and unreliable across that boundary.
- **Line endings:** `.gitattributes` forces LF for `*.sh`, `*.conf`, `*.cfg` and `*.properties`. If you cloned before it existed, or have `core.autocrlf=true`, a container fails with `bad interpreter` or `$'\r': command not found`. Fix: `git rm --cached -r . && git reset --hard`.
- **Environment variables:** npm scripts run in `cmd.exe` on Windows, so the repo's scripts never use `VAR=value cmd` syntax. Set variables in PowerShell as shown above.
- **Ports reserved by Hyper-V:** if a port fails with "access forbidden", check `netsh interface ipv4 show excludedportrange protocol=tcp` and pick another port.
