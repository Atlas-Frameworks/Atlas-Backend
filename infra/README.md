# Local infrastructure

Starter `docker-compose.yml` for the POC. It has **not** been started yet in CI. Tasks I-01 to I-03 bring each part up, verify it, and fix what's wrong. See [docs/tasks/dvir/02-infra.md](../docs/tasks/dvir/02-infra.md).

| Service | Port (host) | Purpose | Task |
| --- | --- | --- | --- |
| `postgres-primary` | 5432 | Postgres 17, `wal_level=logical`, entities + outbox | I-01, W-01 |
| `postgres-replica` | 5433 | Streaming read replica that view workers query; syncs Debezium's failover slot | I-01 |
| `redis-primary` / `redis-replica` | – (not published) | Redis Streams (`changes:<type>`), worker lists. Use the proxy | I-02 |
| `sentinel-1..3` | – | Redis failover | I-02 |
| `redis-proxy` | 6380, stats 8404 | Master-only endpoint for Debezium and local apps (see [redis/README.md](redis/README.md)) | I-02 |
| `debezium` | 8080 (health at `/q/health`), JMX metrics 9404 | Outbox → Redis Streams | I-03 |
| `prometheus` | 9090 | Scrapes workers, replicator, Debezium, Redis, Postgres; alert rules (see [monitoring/README.md](monitoring/README.md)) | I-05 |
| `grafana` | 3001 | Dashboard "Atlas realtime", anonymous viewer access | I-05 |
| `redis-exporter` | – | Redis metrics, both nodes | I-05 |
| `postgres-exporter-primary` / `-replica` | – | Postgres metrics, slot and replica lag | I-05 |

```bash
npm run infra:up     # start everything
npm run infra:logs   # follow logs
npm run infra:down   # stop and delete all data
```

Connection strings for local development:

| What | Value |
| --- | --- |
| Writer (replicator service) | `postgres://atlas_writer:atlas_writer@localhost:5432/atlas` |
| Reader, replica (view workers) | `postgres://atlas_reader:atlas_reader@localhost:5433/atlas` |
| Reader, primary (fallback) | `postgres://atlas_reader:atlas_reader@localhost:5432/atlas` |
| Redis (view workers, local dev) | `redis://localhost:6380`, the master-only proxy, so apps running on your machine follow failovers without resolving container hostnames |

Production differences (out of POC scope, tracked in I-04): Patroni manages Postgres failover, OpenShift runs everything, and `synchronized_standby_slots` is set through a Patroni callback.
