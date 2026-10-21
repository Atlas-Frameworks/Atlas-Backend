# Local infrastructure

Starter `docker-compose.yml` for the POC. It has **not** been started yet in CI. Tasks I-01 to I-03 bring each part up, verify it, and fix what's wrong. See [docs/tasks/dvir/02-infra.md](../docs/tasks/dvir/02-infra.md).

| Service | Port (host) | Purpose | Task |
| --- | --- | --- | --- |
| `postgres-primary` | 5432 | Postgres 17, commerce entities + transactional outbox | I-01, W-01 |
| `postgres-replica` | 5433 | Streaming read replica that view workers query; syncs Debezium's failover slot | I-01 |
| `redis-primary` / `redis-replica` | 6379 | Redis Streams (`changes:<type>`), worker lists | I-02 |
| `sentinel-1..3` | – | Redis failover | I-02 |
| `redis-proxy` | 6380, stats 8404 | Stable master-only Redis endpoint | I-02 |
The locally run change publisher uses the Postgres and Redis endpoints exposed
by Compose. It runs one independent loop per registered entity type, allocates
`typeSeq` after commit, and writes the event to `changes:<entityType>` before
deleting its durable outbox row. A crash after Redis accepts an event but before
deletion can create a duplicate; consumers handle that safely through `version`
and `typeSeq`.

```bash
npm run infra:up     # start the containers and database services
npm run postgres:setup # create durable outboxes and synchronization functions
npm run postgres:seed  # create commerce tables and insert initial data
npm run publisher:start # allocate typeSeq and publish outbox events to Redis
npm run replicator:simulate # continuously update random commerce rows
npm run replicator:watch  # print new Redis events
npm run infra:logs   # follow logs
npm run infra:down   # stop and delete all data
```

The three database stages are deliberately separate:

1. `infra:up` starts Docker and initializes only the database and service roles.
2. `postgres:setup` creates the synchronized-entity registry, durable outbox
   claim functions, and generic synchronization functions.
3. `postgres:seed` creates and registers the commerce tables, then inserts the
   initial data.

The PostgreSQL setup scripts live under `infra/postgres/scripts`; neither
command starts Docker. The update simulator and event listener remain under
`apps/replicator-sim/scripts`.

Every order selects one random item and customer; every distributor selects
between 1 and 20 distinct random orders. Every inserted row explicitly starts
at version `1`, and the database triggers publish all 175 inserts through the
transactional outbox. Running `postgres:seed` again preserves the schema and
creates another independent batch. Use `--rollback` to create/register the
commerce tables while validating the generated rows without committing them.

Run `replicator:simulate` after seeding to update each entity type independently:

- item prices every 2 seconds;
- customer addresses every 3 seconds;
- order item or customer references every 4 seconds;
- distributor order lists every 5 seconds.

Every cycle updates a random number of rows. Override the schedule and batch
limits with `ITEM_INTERVAL_MS`, `CUSTOMER_INTERVAL_MS`, `ORDER_INTERVAL_MS`,
`DISTRIBUTOR_INTERVAL_MS`, and the corresponding `*_MAX_UPDATES` variables.
Use `npm run replicator:simulate -- --once` to run one cycle for every entity type.
Add `--rollback` to that command to test the updates without saving them.
The normal version and synchronization triggers remain responsible for version
increments and outbox events.

Run `replicator:watch` in a second terminal to monitor the synchronization pipeline.
It checks Debezium's health endpoint and prints new events from all four Redis
streams. Add `--history` to start at the beginning of each stream, or `--once`
to perform one read and exit:

```bash
npm run replicator:watch
npm run replicator:watch -- --history --once
```

The listener uses `SYNC_ENTITY_TYPES` (default
`customers,items,orders,distributors`), `REDIS_READ_COUNT` (default `100`),
and `REDIS_BLOCK_MS` (default `5000`).

Connection strings for local development:

| What | Value |
| --- | --- |
| Writer (replicator service) | `postgres://atlas_writer:atlas_writer@localhost:5432/atlas` |
| Reader, replica (view workers) | `postgres://atlas_reader:atlas_reader@localhost:5433/atlas` |
| Reader, primary (fallback) | `postgres://atlas_reader:atlas_reader@localhost:5432/atlas` |
| Redis (view workers, local dev) | `redis://localhost:6380`, the master-only proxy, so apps running on your machine follow failovers without resolving container hostnames |

The schema files applied by `postgres:seed` create the commerce domain:
`customers`, `items`, `orders`, and `distributors`. Each order references an item
and customer; distributor order IDs are stored as a UUID array.

Every entity has a `version` and `updated_at`. Generic database triggers
increment the version and write a raw event to that entity's durable outbox for
every insert, update, or delete. Upserts carry a generic business-field diff;
deletes carry the deleted ID. The publisher allocates the entity's sequence and
writes those events into the shared streams
`changes:customers`, `changes:items`, `changes:orders`, and
`changes:distributors`.

Register a new application table in its migration with
`SELECT register_synced_table('public.table_name');`. It must have an `id uuid`
column. Registration adds `version` and `updated_at`, creates the entity-specific
outbox and generic triggers, and registers the entity's independent sequence.

Redis Streams do not require a separate Redis mode or pre-created stream. A
stream is created by its first write, for example:

```bash
redis-cli -p 6380 XRANGE changes:orders - +
```

Production differences (out of POC scope, tracked in I-04): Patroni manages Postgres failover, OpenShift runs everything, and `synchronized_standby_slots` is set through a Patroni callback.
