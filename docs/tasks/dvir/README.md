# dvir · Platform, view service and proving the POC

You own the repo foundation and infrastructure (done), the shared protocol package (`packages/protocol`), the view-service workers (`apps/view-service`), and the end-to-end tests and report that prove the POC.

You are the integrator: your view-service tasks consume snir's engine and your tests run the whole system. snir's and boaz's tasks never wait for yours, except the two protocol tasks below, which are already in progress.

## Your tasks, in order

**Done (in review):** F-01, F-02, F-03 ([01-foundation.md](01-foundation.md)); I-01 – I-05 ([02-infra.md](02-infra.md)).

**Finish first, others start from these:**

| # | ID | Title | Size | Unblocks | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | P-02 | Outbox event JSON schema and validator | S | snir W-01 (committed on `task/P-02-outbox-schema`) | [03-protocol.md](03-protocol.md) |
| 2 | P-01 | Protobuf schemas and code generation | M | boaz C-01, C-07 | [03-protocol.md](03-protocol.md) |

**Then:**

| # | ID | Title | Size | Depends on | Spec |
| --- | --- | --- | --- | --- | --- |
| 3 | S-01 | View-service skeleton (NestJS + uWebSockets.js) | M | F-01 ✓ | [05-view-service.md](05-view-service.md) |
| 4 | S-09 | Metrics, logging and health | S | S-01 | [05-view-service.md](05-view-service.md) |
| 5 | S-08 | Stream trimmer | S | S-01 | [05-view-service.md](05-view-service.md) |
| 6 | S-05 | Client WebSocket layer: auth, subscriptions, fan-out | L | S-01, P-01 | [05-view-service.md](05-view-service.md) |
| 7 | S-06 | Worker membership in Redis | M | S-01, E-06 (snir) | [05-view-service.md](05-view-service.md) |
| 8 | S-03 | Postgres access layer and build queue | M | S-01, E-02 (snir) | [05-view-service.md](05-view-service.md) |
| 9 | S-02 | Change-stream consumer with gap detection | M | S-01, P-02, E-05 (snir) | [05-view-service.md](05-view-service.md) |
| 10 | S-04 | View owner runtime: tick, reconciliation, lifecycle | L | S-02, S-03, E-04 (snir) | [05-view-service.md](05-view-service.md) |
| 11 | S-10 | Multiple services from one engine | S | S-04 | [05-view-service.md](05-view-service.md) |
| 12 | S-07 | Worker-to-worker subscriptions and handover | L | S-04, S-05, S-06 | [05-view-service.md](05-view-service.md) |
| 13 | T-02 | End-to-end correctness checks | M | T-01 (snir), S-04 | [09-testing-poc.md](09-testing-poc.md) |
| 14 | T-03 | Failover drills | M | T-01 (snir), S-07 | [09-testing-poc.md](09-testing-poc.md) |
| 15 | T-04 | Load test: 5,000 clients, 1,000 views | L | S-07, W-03 (snir) | [09-testing-poc.md](09-testing-poc.md) |
| 16 | T-05 | Chaos and rolling-deploy tests | M | S-07, I-04 ✓ | [09-testing-poc.md](09-testing-poc.md) |
| 17 | T-06 | POC results report | S | T-02 – T-05 | [09-testing-poc.md](09-testing-poc.md) |

About 66 working days of open work for one person (S ≈ 1.5, M ≈ 4, L ≈ 7.5), the largest share, since it includes integrating everything.

## Working against snir's engine before it lands

The engine API is fixed in [contracts.md §6](../../contracts.md). snir delivers the pieces in the order you need them (E-06, E-02, E-04, E-05, then T-01 and W-03). If one isn't merged when you reach a task, code against the contract signature with a local stub and note it in the PR, per AGENTS.md. S-01, S-09, S-08 and S-05 need nothing from snir, so they fill the time until E-06 lands.
