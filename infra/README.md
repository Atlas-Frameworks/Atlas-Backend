# Local infrastructure

Starter `docker-compose.yml` for the POC. It has **not** been started yet in CI. Tasks I-01 to I-03 bring each part up, verify it, and fix what's wrong. See [docs/tasks/dvir/02-infra.md](../docs/tasks/dvir/02-infra.md).

| Service | Port (host) | Purpose | Task |
| --- | --- | --- | --- |
| `postgres-primary` | 5432 | Postgres 17, W/A order entities + transactional outbox | I-01, W-01 |
| `postgres-replica` | 5433 | Streaming read replica that view workers query; syncs Debezium's failover slot | I-01 |
| `redis-primary` / `redis-replica` | 6379 | Redis Streams (`changes:<type>`), worker lists | I-02 |
| `sentinel-1..3` | – | Redis failover | I-02 |
| `redis-proxy` | 6380, stats 8404 | Stable master-only Redis endpoint | I-02 |
The locally run change publisher uses the Postgres and Redis endpoints exposed
by Compose. It runs one independent loop per registered entity type, allocates
`typeSeq` after commit, and writes the event to `changes:<entityType>` before
deleting its durable outbox row. A crash after Redis accepts an event but before
deletion can create a duplicate; consumers handle that safely through `sequence`
and `typeSeq`.

```bash
npm run infra:up     # start the containers and database services
npm run postgres:setup # create durable outboxes and synchronization functions
npm run postgres:seed  # insert identical data into both benchmark schemas
npm run postgres:seed:order-groups-load # add the repeatable 60k-order fixture
npm run publisher:start # allocate typeSeq and publish outbox events to Redis
npm run replicator:simulate:publisher # update the Publisher environment
npm run replicator:simulate:debezium # update the Debezium environment
npm run replicator:watch  # print new Redis events
npm run infra:logs   # follow logs
npm run infra:down   # stop and delete all data
```

The three database stages are deliberately separate:

1. `infra:up` starts Docker and initializes only the database and service roles.
2. `postgres:setup` creates `benchmark_publisher` and `benchmark_debezium`,
   their W/A order tables, and each pipeline's synchronization flow. Synchronization
   functions and state stay inside their owning schema; `public` contains none
   of the Publisher or Debezium business functions.
3. `postgres:seed` inserts one batch with identical IDs and business values
   into both schemas.

The PostgreSQL setup scripts live under `infra/postgres/scripts`; neither
command starts Docker. The update simulator and event listener remain under
`apps/replicator-sim/scripts`.

When upgrading an existing local POC, setup removes the obsolete customers,
items, delivery companies, and distributors once, then creates the W/A model.
Subsequent setup runs preserve W/A data. `postgres:seed` is deterministic and
does not duplicate rows. Use `--rollback` to validate it without committing.

For order-group load testing, run `npm run postgres:seed:order-groups-load`.
It adds 30,000 W orders under campaign
`10000000-0000-4000-8000-000000000001` and 30,000 A orders under plan
`20000000-0000-4000-8000-000000000001`. Bulk loading disables synchronization
triggers so performance fixtures do not generate 120,000 outbox events.

Choose the environment explicitly when starting the simulator:

```bash
npm run replicator:simulate -- --schema benchmark_publisher
npm run replicator:simulate -- --schema benchmark_debezium
```

The convenience commands `replicator:simulate:publisher` and
`replicator:simulate:debezium` set the same schema choice. The simulator rejects
any other schema and prints the selected target before updating rows.

Each W/A entity type is updated independently. Hierarchy entities change
`status` and `number`; orders change `status`, `priority`, and `amount`.

Every cycle updates a random number of rows. Override the schedule and batch
limits with `<ENTITY_TYPE>_INTERVAL_MS` and `<ENTITY_TYPE>_MAX_UPDATES`.
Add `--once` to run one cycle for every entity type and `--rollback` to test
the updates without saving them.
The simulator injects the source `sequence`; synchronization triggers validate
that updates increase it and create outbox events.

Run `replicator:watch` in a second terminal to monitor the synchronization pipeline.
It prints new events from all seven Redis
streams. Add `--history` to start at the beginning of each stream, or `--once`
to perform one read and exit:

```bash
npm run replicator:watch
npm run replicator:watch -- --history --once
```

The listener uses `SYNC_ENTITY_TYPES` (default
`w_campaigns,w_missions,w_plans,a_plans,a_missions,a_objectives,orders`), `REDIS_READ_COUNT`
(default `100`),
and `REDIS_BLOCK_MS` (default `5000`).

Connection strings for local development:

| What | Value |
| --- | --- |
| Writer (replicator service) | `postgres://atlas_writer:atlas_writer@localhost:5432/atlas` |
| Reader, replica (view workers) | `postgres://atlas_reader:atlas_reader@localhost:5433/atlas` |
| Reader, primary (fallback) | `postgres://atlas_reader:atlas_reader@localhost:5432/atlas` |
| Redis (view workers, local dev) | `redis://localhost:6380`, the master-only proxy, so apps running on your machine follow failovers without resolving container hostnames |

The schema files create W campaigns, missions and plans; A plans, missions and
objectives; and a shared orders table under both benchmark schemas. W mission
to plan is normalized through `w_mission_plans`. Each order points directly to
either a W plan or A objective, according to its `source`. No entity tables are
created under `public`.

Every entity has a source `sequence` and `updated_at`. The replicator supplies
one globally increasing source sequence across all entity types. Generic database triggers
validate the sequence and write a raw event to that entity's durable outbox for
every insert, update, or delete. Upserts carry a generic business-field diff;
deletes carry the deleted ID without a source sequence. The publisher allocates the entity's `typeSeq` and
writes those events into the shared streams
`changes:w_campaigns`, `changes:w_missions`, `changes:w_plans`,
`changes:a_plans`, `changes:a_missions`, `changes:a_objectives`, and
`changes:orders`.

Register a new Publisher application table in its migration with
`SELECT benchmark_publisher.register_synced_table('benchmark_publisher.table_name');`.
It must have
`id uuid` and non-null `sequence bigint` columns. Registration adds `updated_at`,
creates the entity-specific outbox and single-row state table, and attaches the
generic triggers. The outbox stores the source identifier in `entity_id`.

Redis Streams do not require a separate Redis mode or pre-created stream. A
stream is created by its first write, for example:

```bash
redis-cli -p 6380 XRANGE changes:orders - +
```

Production differences (out of POC scope, tracked in I-04): Patroni manages Postgres failover, OpenShift runs everything, and `synchronized_standby_slots` is set through a Patroni callback.
