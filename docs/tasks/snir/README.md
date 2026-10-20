# snir · View engine and write path

You own the pure TypeScript engine (`packages/view-engine`), the write path and simulator (`apps/replicator-sim`, schema and roles in `infra/postgres`), and the backend test environment (`packages/test-env`).

**None of your tasks depends on another person's open task.** Everything you need is already done (F-*, I-*) or committed (P-02 on `task/P-02-outbox-schema`).

## Your tasks, in order

| # | ID | Title | Size | Depends on | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | E-06 | Rendezvous hashing and membership model | S | – | [04-view-engine.md](04-view-engine.md) |
| 2 | E-01 | Field registry and filter validation | M | – | [04-view-engine.md](04-view-engine.md) |
| 3 | E-04 | Typed-array view store, sorted pages, group counts | L | – | [04-view-engine.md](04-view-engine.md) |
| 4 | E-02 | Filter-to-SQL compiler | L | E-01 | [04-view-engine.md](04-view-engine.md) |
| 5 | E-03 | Change-to-view dependency index | M | E-01 | [04-view-engine.md](04-view-engine.md) |
| 6 | E-05 | Tick batcher, sequence tracker, dirty IDs | M | E-03 | [04-view-engine.md](04-view-engine.md) |
| 7 | E-07 | Incremental-vs-full property test harness | M | E-02, E-04 | [04-view-engine.md](04-view-engine.md) |
| 8 | W-01 | Final schema, roles and write function | M | I-01 ✓, P-02 ✓ | [08-replicator.md](08-replicator.md) |
| 9 | W-02 | Replicator write path (NestJS) | M | W-01 | [08-replicator.md](08-replicator.md) |
| 10 | T-01 | Backend integration test environment | M | I-01 ✓, I-02 ✓, I-03 ✓ | [09-testing-poc.md](09-testing-poc.md) |
| 11 | W-03 | Data simulator and load profiles | M | W-02 | [08-replicator.md](08-replicator.md) |

About 50 working days for one person (S ≈ 1.5, M ≈ 4, L ≈ 7.5).

## Why this order

dvir's view-service builds on your engine through the API fixed in [contracts.md §6](../../contracts.md). The order puts each piece he needs first: E-06 for membership (S-06), E-02 for the Postgres layer (S-03), E-04 and E-05 for the owner runtime (S-04), T-01 for his integration tests, and W-03 for the load test. Merge each one as soon as it's done rather than batching them.

## Rules for this area

- `packages/view-engine` has no I/O: no `pg`, no Redis, no sockets, no timers. Clocks come in as functions.
- Export exactly the names in contracts §6. If one must change, open a `contract-change` PR first and tell dvir.
- Never build SQL by concatenating values. Identifiers come only from the field registry.
