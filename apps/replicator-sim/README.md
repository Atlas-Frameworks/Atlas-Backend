# @atlas/replicator-sim

Local command-line tools for changing commerce rows and observing the
Postgres → selected relay → Redis synchronization flow. Database setup and initial
data belong to `infra/postgres`, not this workspace.

## Commands

```bash
npm run replicator:simulate:publisher
npm run replicator:simulate:debezium
npm run replicator:watch
```

The equivalent workspace commands are:

```bash
npm run simulate -w @atlas/replicator-sim
npm run watch -w @atlas/replicator-sim
```

### `simulate`

`scripts/data-update-simulator.mjs` continuously updates random item prices,
customer addresses, order references, and distributor order lists. Use `--once`
for one cycle and combine it with `--rollback` for a non-persistent check.

The generic command requires an explicit target schema:

```bash
npm run replicator:simulate -- --schema benchmark_publisher
npm run replicator:simulate -- --schema benchmark_debezium
```

Alternatively, set `REPLICATOR_SCHEMA` to one of those exact values. Other
schema names are rejected before any SQL runs. The selected schema is printed
when the simulator starts.

Intervals and maximum batch sizes are configurable with
`ITEM_INTERVAL_MS`, `CUSTOMER_INTERVAL_MS`, `ORDER_INTERVAL_MS`,
`DISTRIBUTOR_INTERVAL_MS`, and their corresponding `*_MAX_UPDATES` variables.

### `watch`

`scripts/sync-event-listener.mjs` reports Debezium health and prints Redis Stream
events. It starts from new events by default. `--history` includes existing
entries and `--once` performs a single read.

`SYNC_ENTITY_TYPES` is a comma-separated list of entity types; it defaults to
`customers,items,orders,distributors`. Additional settings are
`REDIS_READ_COUNT`, `REDIS_BLOCK_MS`, `DEBEZIUM_HEALTH_INTERVAL_MS`, and
`DEBEZIUM_HEALTH_URL`.

## Synchronization ownership

The simulator only writes application rows in the explicitly selected schema,
and the listener only reads the shared Redis Streams. In
`benchmark_publisher`, the trigger stores a durable raw event and the Publisher
allocates `typeSeq` after commit. In `benchmark_debezium`, the trigger allocates
`typeSeq` in the entity transaction and Debezium relays the transient outbox
record from WAL. Both pipelines write to `changes:<entityType>`. The simulator
injects a globally increasing source `sequence` from one PostgreSQL sequence
shared by all entity tables in the selected schema. Gaps within one entity type
are expected because updates to other types consume values too.

Register a new table in its migration with:

```sql
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.my_new_table');
```

The table must have `id uuid` and non-null `sequence bigint` columns. See
[the PostgreSQL workflow](../../infra/README.md) and
[the event contract](../../docs/contracts.md).
