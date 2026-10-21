# Change relay benchmark

This benchmark compares the two relay architectures without changing commerce
data. Both pipelines use the same four entity types, identical seed batches,
the same update statements, and the same Redis Streams.

| Pipeline | Source schema | Sequence allocation | Redis Streams |
| --- | --- | --- | --- |
| Publisher | `benchmark_publisher` | After commit, in batches | `changes:<type>` |
| Debezium | `benchmark_debezium` | In the entity transaction | `changes:<type>` |

## Setup

```powershell
npm run infra:up
npm run postgres:setup
npm run postgres:seed
```

`postgres:setup` creates both isolated schemas and their pipeline-specific
triggers. `postgres:seed` inserts the same IDs and business values into both.
Neither command starts a relay.

An existing local database created by the older JSON benchmark prototype is
rejected instead of being modified or deleted automatically. Back up anything
needed, then recreate the local Docker volumes with `npm run infra:down`
followed by `npm run infra:up` before running the setup commands above.

## Quick workload run (console output only)

`benchmark:run` is intended for a quick single workload. It prints a table to
the terminal, but it does **not** collect PostgreSQL metrics and does **not**
create a report file. Use `benchmark:report` when a JSON or Markdown report is
required.

### Publisher

Start the publisher in one terminal:

```powershell
npm run publisher:start
```

Run the workload in another terminal:

```powershell
npm run benchmark:run -- --pipeline publisher --events 10000 --concurrency 32
```

### Debezium

Build the existing Debezium image once, then start the isolated benchmark
service. These commands do not build or run the custom publisher in Docker.

```powershell
npm run benchmark:debezium:build
npm run benchmark:debezium:start
npm run benchmark:run -- --pipeline debezium --events 10000 --concurrency 32
```

Stop it with:

```powershell
npm run benchmark:debezium:stop
```

The console table contains write throughput, end-to-end delivery throughput,
elapsed times, and remaining outbox rows only.

## Automated comparison report

The report runner is the recommended command for measured tests. It performs
warm-up, captures PostgreSQL counters before and after every measured run, and
writes both JSON and Markdown files. Exactly one `--pipeline` is required, and
only that relay should be running because both pipelines share Redis and use
the same Stream names.

Run Publisher by itself:

```powershell
npm run benchmark:report -- `
  --pipeline publisher `
  --events 50000 `
  --warmup-events 2000 `
  --runs 3 `
  --concurrency 32
```

Run Debezium by itself:

```powershell
npm run benchmark:report -- `
  --pipeline debezium `
  --events 50000 `
  --warmup-events 2000 `
  --runs 3 `
  --concurrency 32
```

Reports are written to `infra/benchmark/reports/` by default. The directory is
named `reports`, not `results`, and is ignored by Git. Each execution creates a
timestamped `.json` file and a timestamped `.md` file. Use
`--output-dir <path>` to store them elsewhere.

For example, the following command prints results to the terminal only and
will not create anything under `infra/benchmark/reports/`:

```powershell
npm run benchmark:run -- --pipeline publisher --events 50000 --concurrency 32
```

The runner does not reset PostgreSQL statistics, truncate tables, delete Redis
streams, or start and stop production services. It calculates deltas around
each run. Schema table counters and statements that reference the isolated
benchmark schemas are pipeline-specific. Database-wide and WAL counters can
include unrelated traffic that occurs during the same interval. After the
workload finishes, the default 1.2 second metrics settle interval lets
PostgreSQL flush cumulative statistics; it is excluded from workload latency.
Override it with `--metrics-settle-ms` only when necessary.

### Production

Create the isolated schemas in a controlled deployment and run the dedicated
Publisher and Debezium benchmark relays before generating load. Never point the
benchmark schemas at production entity tables.

Set `DATABASE_URL` to the benchmark writer connection and `REDIS_URL` to the
Redis endpoint. For complete PostgreSQL query metrics, set
`METRICS_DATABASE_URL` to a read-only monitoring user with `pg_read_all_stats`;
the database must preload and install `pg_stat_statements`. If omitted, metrics
use `DATABASE_URL` and may contain only the workload user's statements.

Production mode requires an explicit acknowledgement because it generates
writes:

```powershell
$env:DATABASE_URL = 'postgresql://benchmark_writer:***@db.example/atlas'
$env:METRICS_DATABASE_URL = 'postgresql://benchmark_monitor:***@db.example/atlas'
$env:REDIS_URL = 'rediss://redis.example:6380'

npm run benchmark:report -- `
  --environment production `
  --confirm-production-benchmark `
  --pipeline publisher `
  --events 20000 `
  --warmup-events 2000 `
  --runs 3 `
  --concurrency 32 `
  --timeout-ms 180000 `
  --output-dir C:\benchmark-results
```

Start with low event and concurrency values during a production maintenance
window, then increase them gradually while watching database saturation and
replication lag. `--concurrency` is capped at 256.
