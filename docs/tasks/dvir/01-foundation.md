# 01 · Foundation

Repo tooling every other task relies on. Current state: an npm-workspaces monorepo (`apps/*`, `packages/*`), an Angular 22 app in `apps/client`, NestJS 12 apps in `apps/view-service` and `apps/replicator-sim`, and three empty TypeScript packages. Everything builds and the generated tests pass with Node 24 and npm 11.

---

## F-01 · Monorepo tooling, lint and CI

- **Depends on:** nothing
- **Size:** S
- **Plan sections:** Overview (rule 4, "One codebase")

**Goal.** One consistent toolchain so any task can build, lint and test any package with the same commands, and CI enforces it.

**Deliverables**

1. **Package internals:** packages consume each other through workspace references (`"@atlas/view-engine": "*"`), and TypeScript project references or `paths` so editors resolve them without building first.
2. **Lint and format:** one root config that every workspace uses.
   - The NestJS apps were generated with oxlint and Prettier; adopt oxlint + Prettier repo-wide, or justify ESLint in the PR.
   - Lint scripts in every workspace.
3. **Root scripts work from a clean clone:** `npm ci`, `npm run build`, `npm test`, `npm run typecheck` and `npm run lint`.
4. **Pin Node and npm:**
   - Keep `.nvmrc` = 24 and `engines.node >=24.15.0`. Angular 22 requires Node ≥ 22.22.3 or 24.15.
   - Use npm 11 (`packageManager`). npm 11 blocks install scripts by default, and the needed ones are approved in the root `allowScripts`. Keep that list current.
5. **GitHub Actions workflow `.github/workflows/ci.yml`:**
   - Runs on pull requests and on `main`.
   - Node 24, `npm ci`, lint, typecheck, build, test.
   - Caches npm.
6. **`.github/pull_request_template.md`:** task ID, acceptance criteria checklist, how verified.

**Acceptance criteria**

- [ ] Fresh clone → `npm ci && npm run lint && npm run typecheck && npm run build && npm test` passes locally and in CI.
- [ ] Importing `@atlas/view-engine` from `apps/view-service` compiles and runs, shown by a trivial import in `main.ts` that is removed again or kept behind a smoke test.
- [ ] CI fails on a lint error, a type error and a failing test (try each once in a throwaway branch).

**Out of scope:** Nx migration. You may propose it in the PR, but don't do it in this task.

---

## F-02 · Developer workflow scripts and docs

- **Depends on:** F-01
- **Size:** S

**Goal.** A new developer, or an agent, can run the whole POC locally with a handful of commands.

**Deliverables**

1. **Root scripts:**
   - `dev:infra` (= `infra:up`);
   - `dev:replicator`, `dev:view-service` (accepts `WORKER_NAME`, `PORT`, `GRPC_PORT` env vars so 3 workers can run side by side), and `dev:client`;
   - `dev:cluster`, which starts 3 view-service workers with different names and ports using `concurrently` or similar.
2. **`.env.example` per app** with every variable the app reads. Each app validates its env at startup, using F-03.
3. **`docs/development.md`:**
   - prerequisites (Node 24, Docker);
   - startup order;
   - ports table;
   - how to reset data;
   - how to run one task's tests;
   - troubleshooting for Docker on macOS and Windows.

**Acceptance criteria**

- [ ] Following `docs/development.md` from scratch reaches "client shows the map with moving points" once the end-to-end tasks are done. Until then, it reaches "infra up, three workers running, client served".
- [ ] `npm run dev:cluster` starts 3 workers that don't collide on ports.

---

## F-03 · Shared config, logging and errors package

- **Depends on:** F-01
- **Size:** S

**Goal.** Every Node app reads config, logs and reports errors the same way.

**Deliverables**

1. **New package `packages/node-common`:**
   - `loadConfig(schema)`: typed env loading and validation with zod or valibot. Fail fast with a clear message listing every missing or invalid variable.
   - `createLogger(name)`: structured JSON logs (pino) with `service`, `worker`, `traceId` fields; pretty output when `NODE_ENV=development`.
   - Error types: `RetryableError`, `FatalError`, `InvalidInputError` with an error `code`.
2. Used by `view-service` and `replicator-sim`, replacing the generated Nest logger with a pino adapter.

**Acceptance criteria**

- [ ] Starting an app with a missing required variable exits non-zero and names the variable.
- [ ] Logs are one JSON object per line in production mode.
- [ ] Unit tests for config validation.
