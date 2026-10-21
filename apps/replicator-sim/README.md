# @atlas/replicator-sim

Local command-line tools for changing commerce rows and observing the
Postgres → Debezium → Redis synchronization flow. Database setup and initial
data belong to `infra/postgres`, not this workspace.

## Commands

```bash
npm run replicator:simulate
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

The simulator only writes application rows and the listener only reads health
and Redis. The generic Postgres triggers increment `version` and `typeSeq`,
create the transactional outbox record, and delete it after it has been written
to the WAL. Debezium routes the event to `changes:<entityType>`.

Register a new table in its migration with:

```sql
SELECT register_synced_table('public.my_new_table');
```

The table must have an `id uuid` column. See
[the PostgreSQL workflow](../../infra/README.md) and
[the event contract](../../docs/contracts.md).
