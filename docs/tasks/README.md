# POC task backlog

Each task can be picked up by one person or one coding agent and finished independently. Every task lists what it depends on, the plan sections to read, exact deliverables and acceptance criteria.

**Before starting any task, read:**

1. [architecture-plan.md](../architecture-plan.md): the design and the reasons behind it.
2. [contracts.md](../contracts.md): the interfaces shared between components. Build against these; don't invent your own.
3. The task's own section in its category file.

## How to pick up and finish a task

1. Choose a task whose **Depends on** tasks are done, or that says it can start against stubs or mocks.
2. Mark it in the board below (owner + `in progress`) in a small PR, or assign yourself on the matching GitHub issue.
3. Work on a branch named `task/<ID>-<short-name>`, for example `task/E-01-field-registry`.
4. Meet every acceptance criterion, including tests. Run `npm run build && npm test && npm run typecheck` at the repo root.
5. Open a PR titled `<ID>: <title>`. List each acceptance criterion with how you verified it.
6. If you had to change a contract in `docs/contracts.md`, do that in a separate PR first, tagged `contract-change`.

## Team split

The work is split between three people. Each folder holds that person's task specs and a README with their order of work. **No task waits on another person's unfinished task,** except P-01 and P-02, which dvir is finishing first. Where dvir's view-service uses snir's engine, it builds against the API fixed in [contracts.md](../contracts.md) §6.

| Folder | Owner | Area | Tasks |
| --- | --- | --- | --- |
| [dvir/](dvir/README.md) | dvir | Foundation, infra, protocol, view service, end-to-end proof | F-*, I-*, P-01, P-02, S-01 – S-10, T-02 – T-06 |
| [snir/](snir/README.md) | snir | View engine, write path, simulator, test environment | E-01 – E-07, W-01 – W-03, T-01 |
| [boaz/](boaz/README.md) | boaz | Client SDK and Angular app | C-01 – C-07, A-01 – A-05 |

Specs by category:

| File | Category | Tasks |
| --- | --- | --- |
| [dvir/01-foundation.md](dvir/01-foundation.md) | Repo tooling, CI, conventions | F-01 – F-03 |
| [dvir/02-infra.md](dvir/02-infra.md) | Postgres, Redis, Debezium, OpenShift, monitoring | I-01 – I-05 |
| [dvir/03-protocol.md](dvir/03-protocol.md) | Protobuf schemas and the outbox event contract | P-01 – P-02 |
| [snir/04-view-engine.md](snir/04-view-engine.md) | Pure TS engine: registry, SQL compiler, dependencies, store, tick, hashing | E-01 – E-07 |
| [dvir/05-view-service.md](dvir/05-view-service.md) | NestJS workers: streams, Postgres, owner runtime, WebSockets, cluster | S-01 – S-10 |
| [boaz/06-client-sdk.md](boaz/06-client-sdk.md) | Browser SDK in a Web Worker and map adapters | C-01 – C-07 |
| [boaz/07-client-app.md](boaz/07-client-app.md) | Angular app | A-01 – A-05 |
| [snir/08-replicator.md](snir/08-replicator.md) | Write path: schema, write function, data simulator | W-01 – W-03 |
| [snir/09-testing-poc.md](snir/09-testing-poc.md), [dvir/09-testing-poc.md](dvir/09-testing-poc.md) | Integration, correctness, load and failure testing; POC report | T-01; T-02 – T-06 |

## Suggested order

Tasks in the same phase can run in parallel.

| Phase | Tasks |
| --- | --- |
| 1. Foundations | F-01, F-02, F-03, I-01, I-02, P-01, P-02, E-01, E-06 |
| 2. Building blocks | I-03, W-01, E-02, E-03, E-04, E-05, S-01, C-01, C-02, A-01 |
| 3. End-to-end path | W-02, W-03, S-02, S-03, S-04, S-05, C-03, C-04, C-05, A-02, A-03 |
| 4. Cluster and reliability | S-06, S-07, S-08, S-09, S-10, E-07, C-06, C-07, A-04, A-05, I-05 |
| 5. Proving it | T-01 – T-06, I-04 |

## Board

Size: S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks for one person.

| ID | Title | Depends on | Size | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| F-01 | Monorepo tooling, lint and CI | – | S | dvir (Claude) | in review |
| F-02 | Developer workflow scripts and docs | F-01 | S | dvir (Claude) | in review |
| F-03 | Shared config, logging and errors package | F-01 | S | dvir (Claude) | in review |
| I-01 | Postgres primary + replica with failover slots | – | M | dvir (Claude) | in review |
| I-02 | Redis + Sentinel + master-only proxy | – | M | dvir (Claude) | in review |
| I-03 | Debezium Server outbox pipeline | I-01, I-02, W-01 | M | dvir (Claude) | in review |
| I-04 | OpenShift deployment manifests | S-01, S-07 | M | dvir (Claude) | in review |
| I-05 | Prometheus and Grafana dashboards | S-09 | S | dvir (Claude) | in review |
| P-01 | Protobuf schemas and code generation | – | M | dvir (Claude) | in review |
| P-02 | Outbox event JSON schema and validator | – | S | dvir | in progress |
| E-01 | Field registry and filter validation | – | M | snir | todo |
| E-02 | Filter-to-SQL compiler | E-01 | L | snir | todo |
| E-03 | Change-to-view dependency index | E-01 | M | snir | todo |
| E-04 | Typed-array view store, sorted pages, group counts | – | L | snir | todo |
| E-05 | Tick batcher, sequence tracker, dirty IDs | E-03 | M | snir | todo |
| E-06 | Rendezvous hashing and membership model | – | S | snir | todo |
| E-07 | Incremental-vs-full property test harness | E-02, E-04 | M | snir | todo |
| S-01 | View-service skeleton (NestJS + uWebSockets.js) | F-01 | M | dvir | todo |
| S-02 | Change-stream consumer with gap detection | S-01, P-02, E-05 | M | dvir | todo |
| S-03 | Postgres access layer and build queue | S-01, E-02 | M | dvir | todo |
| S-04 | View owner runtime: tick, reconciliation, lifecycle | S-02, S-03, E-04 | L | dvir | todo |
| S-05 | Client WebSocket layer: auth, subscriptions, fan-out | S-01, P-01 | L | dvir | todo |
| S-06 | Worker membership in Redis | S-01, E-06 | M | dvir | todo |
| S-07 | Worker-to-worker subscriptions and handover | S-04, S-05, S-06 | L | dvir | todo |
| S-08 | Stream trimmer | S-01 | S | dvir | todo |
| S-09 | Metrics, logging and health | S-01 | S | dvir | todo |
| S-10 | Multiple services from one engine | S-04 | S | dvir | todo |
| C-01 | SDK core: transport, protocol, sequence, reconnect | P-01 | L | boaz (Claude) | in review |
| C-02 | Map data store and frame scheduling | C-01 | M | boaz (Claude) | in review |
| C-03 | Pages, detail and locate | C-01 | M | boaz (Claude) | in review |
| C-04 | Worker bridge and public API | C-01 | M | boaz (Claude) | in review |
| C-05 | MapAdapter interface and Cesium adapter | C-02 | L | boaz (Claude) | in review |
| C-06 | deck.gl / MapLibre adapter (stretch) | C-05 | M | boaz (Claude) | in review |
| C-07 | Mock protocol server and deterministic SDK tests | P-01 | M | boaz (Claude) | in review |
| A-01 | Angular app shell and login stub | F-01 | M | boaz (Claude) | in review |
| A-02 | Angular SDK service (signals) | C-04, A-01 | S | boaz (Claude) | in review |
| A-03 | Map component | C-05, A-02 | M | boaz (Claude) | in review |
| A-04 | Layers panel: filters, grouping, live pages | A-02, C-03 | L | boaz (Claude) | in review |
| A-05 | Detail drawer | A-02, C-03 | S | boaz | todo |
| W-01 | Final schema, roles and write function | I-01, P-02 | M | snir | todo |
| W-02 | Replicator write path (NestJS) | W-01 | M | snir | todo |
| W-03 | Data simulator and load profiles | W-02 | M | snir | todo |
| T-01 | Backend integration test environment | I-01, I-02, I-03 | M | snir | todo |
| T-02 | End-to-end correctness checks | T-01, S-04 | M | dvir | todo |
| T-03 | Failover drills | T-01, S-07 | M | dvir | todo |
| T-04 | Load test: 5,000 clients, 1,000 views | S-07, W-03 | L | dvir | todo |
| T-05 | Chaos and rolling-deploy tests | S-07, I-04 | M | dvir | todo |
| T-06 | POC results report | T-02 – T-05 | S | dvir | todo |
