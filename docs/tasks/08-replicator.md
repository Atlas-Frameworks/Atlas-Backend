# 08 · Postgres write path and synchronization tools

Postgres setup and initial commerce data live under `infra/postgres`.
`replicator-sim` contains only the continuous update simulator and the
Debezium-to-Redis event listener. Postgres triggers own event and version
bookkeeping; the scripts do not construct outbox events themselves.

Plan section: "Write path: replicator to Redis Stream". Contract:
[contracts.md](../contracts.md) §1.

---

## W-01 · Commerce schema and generic synchronization

- **Depends on:** I-01, P-02
- **Size:** M
- **Files:** `infra/postgres/init/*.sql`

**Goal.** Every committed insert, update, or delete on a registered commerce
table produces exactly one event with an entity version and a gapless sequence
for that entity type.

**Deliverables**

1. Tables for `customers`, `items`, `orders`, and `distributors`, with UUID IDs
   and their declared relationships.
2. Writer, reader, and Debezium roles with least-privilege grants.
3. Generic `register_synced_table(regclass)` registration for tables with an
   `id uuid` column.
4. A `BEFORE` trigger that initializes or increments `version` and updates
   `updated_at`.
5. An `AFTER` trigger that allocates `typeSeq`, writes the outbox record, and
   removes it in the same transaction after the WAL-visible change is created.
6. Upsert events containing `changes.old` and `changes.new`; delete events carry
   only the deleted entity ID and synchronization metadata.

**Acceptance criteria**

- [ ] `atlas_reader` cannot write application or synchronization tables.
- [ ] Inserts, updates, and deletes reach `changes:<entityType>` through
  Debezium with the expected version and `typeSeq`.
- [ ] Concurrent writes produce a gapless sequence per entity type.

---

## W-02 · Postgres synchronization setup and commerce seed

- **Depends on:** W-01
- **Size:** S
- **Folder:** `infra/postgres/`

**Goal.** Create a useful initial data set through the same database triggers as
normal writes.

**Deliverables**

1. `postgres:setup` waits for an already-started Postgres container and creates
   the technical Debezium tables, publication, and generic synchronization
   functions without creating application tables.
2. `postgres:seed` creates the commerce tables, registers their triggers, and
   inserts 30 customers, 100 items, 40 orders, and 5 distributors.
3. Neither command starts Docker; infrastructure startup remains `infra:up`.
4. Every order references one generated customer and item. Every distributor
   receives between 1 and 20 distinct generated order IDs.
5. Every inserted row explicitly starts at version `1`.
6. Both schemas are idempotent. `postgres:seed -- --rollback` keeps the tables
   and triggers but validates the generated data without committing rows.

**Acceptance criteria**

- [ ] `npm run postgres:setup` creates the synchronization infrastructure and a
  usable Debezium replication slot without creating commerce tables.
- [ ] `npm run postgres:seed` creates the commerce domain and inserts one
  complete independent batch.
- [ ] `npm run postgres:seed -- --rollback` creates any missing domain objects
  but does not change application row counts.

---

## W-03 · Update simulator and synchronization listener

- **Depends on:** W-02, I-03
- **Size:** S
- **Folder:** `apps/replicator-sim/scripts/`

**Goal.** Exercise and inspect the complete Postgres → Debezium → Redis flow
during local development.

**Deliverables**

1. `data-update-simulator.mjs` independently updates random item prices,
   customer addresses, order item/customer references, and distributor order
   lists at configurable intervals and batch sizes.
2. `--once` runs one update cycle for every type; `--once --rollback` performs a
   non-persistent smoke test.
3. `sync-event-listener.mjs` checks Debezium health and prints decoded events
   from the configured `changes:<entityType>` Redis Streams.
4. The listener defaults to the four commerce entity types, supports additional
   types through `SYNC_ENTITY_TYPES`, starts at new events by default, and
   supports `--history` and `--once`.

**Acceptance criteria**

- [ ] `npm run replicator:simulate -- --once --rollback` successfully exercises
  all four update statements without persisting changes.
- [ ] `npm run replicator:watch -- --history --once` prints available Redis
  events and exits successfully.
