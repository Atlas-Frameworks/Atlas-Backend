# Monitoring: Prometheus and Grafana (task I-05)

`npm run infra:up` starts monitoring together with the rest of the infrastructure.

| What | URL | Notes |
| --- | --- | --- |
| Grafana | http://localhost:3001 | Dashboard **Atlas realtime** (folder *Atlas*; also the home dashboard). Anonymous viewer access; admin login `admin` / `admin`. |
| Prometheus | http://localhost:9090 | Targets: `/targets`. Alerts: `/alerts`. Reload config: `curl -X POST localhost:9090/-/reload`. |
| Debezium JMX metrics | http://localhost:9404/metrics | Prometheus JMX exporter agent inside the Debezium container. |

There is no Alertmanager in the POC. Firing alerts show on Prometheus `/alerts` and as red annotations on the dashboard.

## Files

| File | Purpose |
| --- | --- |
| `prometheus/prometheus.yml` | Scrape targets |
| `prometheus/rules/atlas-recording.yml` | Recording rules (quantiles, tick ratio, replica lag) shared by the dashboard and alerts |
| `prometheus/rules/atlas-alerts.yml` | Alerts from the plan's "Observability and capacity" table. Each has a `plan_row` annotation. |
| `prometheus/tests/atlas-alerts.test.yml` | promtool unit tests for the key alerts |
| `postgres-exporter/queries.yml` | Custom queries: slot lag and retained WAL, standby replay lag, replica conflicts |
| `grafana/provisioning/` | Datasource (uid `prometheus`) and dashboard provider |
| `grafana/dashboards/atlas-realtime.json` | The dashboard |

## Scrape targets

| Job | Target | Source of metrics |
| --- | --- | --- |
| `view-service` | `host.docker.internal:3000`, `:3010`, `:3020` (label `worker` = `view-service-0..2`) | Workers on the host (`npm run dev:cluster`), `/metrics`. **Pending S-09.** |
| `replicator-sim` | `host.docker.internal:3100` | `/metrics`. **Pending S-09 / W-03.** |
| `debezium` | `debezium:9404` | Prometheus JMX exporter. Debezium Server 3.7 has no Quarkus `/q/metrics` (returns 404). |
| `redis` | `redis-primary:6379`, `redis-replica:6379` through `redis-exporter:9121/scrape?target=` | Each node directly, so a failover just changes `redis_instance_info{role}`. Also stream lengths (`changes:*`) and the count of worker membership keys. |
| `postgres` | `postgres-exporter-primary`, `postgres-exporter-replica` | postgres_exporter plus `queries.yml`. Each query checks `pg_is_in_recovery()`, so both exporters use the same file and stay correct after a failover. |

On Linux Docker Engine, `host.docker.internal` comes from the `extra_hosts: host-gateway` entry on the Prometheus service.

### Debezium metrics

The image's `run.sh` sources `/debezium/lib_metrics/enable_exporter.sh`. When **`JMX_EXPORTER_PORT`** is set, it adds `-javaagent:lib_metrics/jmx_prometheus_javaagent-1.0.1.jar=0.0.0.0:<port>:config/metrics.yml` to `JAVA_OPTS`. `JMX_EXPORTER_CONFIG` can point at another rules file. The default rules turn Debezium's MBeans into `debezium_metrics_<Attribute>{plugin, name, context}`, for example `debezium_metrics_MilliSecondsBehindSource{context="streaming"}` and `debezium_metrics_Connected`. JVM metrics (`jvm_*`) are included.

The compose file sets `JMX_EXPORTER_PORT=9404` on the `debezium` service. A running Debezium container only picks it up when recreated (`docker compose -f infra/docker-compose.yml up -d debezium`).

## Dashboard panels

"Pending S-09" panels show *No data* until the workers export the metrics in [contracts §8](../../docs/contracts.md). The infrastructure panels have data as soon as the containers run.

| Panel | What it shows | Data source | Status |
| --- | --- | --- | --- |
| Scrape targets up | Targets up and total, per job | `up` | live |
| Commit-to-send delay p50 / p99 | Commit time to delta sent, over all workers. Red line at 3 s. | `atlas_commit_to_send_seconds` | pending S-09 |
| Tick duration vs interval | Tick p99 per worker, and a dashed line at 50% of the interval | `atlas_tick_duration_seconds` | pending S-09 |
| Views and entities per worker | Views owned (left axis), entities held (right) | `atlas_views_owned`, `atlas_entities_held` | pending S-09 |
| Build queue length | Builds waiting, per worker | `atlas_build_queue_length` | pending S-09 |
| Event-loop delay p99 | Per worker. Red line at 100 ms. | `atlas_event_loop_delay_seconds` | pending S-09 |
| Ownership moves per minute | Views moving between workers | `atlas_ownership_moves_total` | pending S-09 |
| Worker memory (RSS) | Per worker. Red line at 70% of 4 GiB. | `process_resident_memory_bytes` (prom-client defaults) | pending S-09 |
| Stream lag | Now minus last processed entry time, per worker and type. Red line at 5 s. | `atlas_stream_lag_seconds{type}` | pending S-09 |
| Sequence gaps | Gaps per minute, per type | `atlas_sequence_gaps_total{type}` | pending S-09 |
| Reconcile and sampler mismatches | Mismatches in 5 min, per worker | `atlas_reconcile_mismatches_total`, `atlas_sampler_mismatches_total` | pending S-09 |
| Redis stream length | Entries per `changes:<type>` stream, per node | redis_exporter | live once Debezium writes streams |
| Read replica lag | `pg_stat_replication.replay_lag` from the primary, and the replica's own replay delay. Red line at 2 s. | postgres_exporter (custom) | live |
| Replica waits | p50 / p99 time ticks wait for the replica. Red line at 2 s (fallback to the primary). | `atlas_replica_wait_seconds` | pending S-09 |
| Slot retained WAL | Per slot: unconfirmed WAL (`pg_current_wal_lsn() - confirmed_flush_lsn`) and WAL kept on disk. Red line at 1 GiB. | postgres_exporter (custom) | live |
| Debezium behind source | `MilliSecondsBehindSource` and time since the last event. Red line at 5 s. | Debezium JMX | live once Debezium is recreated with the exporter |
| Replica query cancellations | Recovery-conflict cancellations per minute on the replica | postgres_exporter (custom) | live |
| Debezium events | Events per second and queue capacity left | Debezium JMX | as above |
| WebSocket connections | Clients per worker, stacked | `atlas_ws_connections` | pending S-09 |
| WebSocket buffered bytes | Bytes in uWS send buffers per worker | `atlas_ws_buffered_bytes` | pending S-09 |
| Send-cap drops | Deltas dropped at the send cap, per second | `atlas_backpressure_drops_total` | pending S-09 |
| Redis memory | Used memory against `maxmemory` per node (`noeviction`) | redis_exporter | live |
| Redis traffic | Bytes in and out per second per node | redis_exporter | live |

The `Worker` variable at the top filters the worker panels.

## Alerts

| Plan row | Alert(s) | Threshold |
| --- | --- | --- |
| Commit-to-send delay | `AtlasCommitToSendP99High` | p99 > 3 s for 2 min |
| Reconciliation drift | `AtlasReconcileDrift` | any increase |
| Replication slot lag | `AtlasDebeziumSlotLagBytes`, `AtlasDebeziumSlotLagTime` | > 1 GiB; > 5 s behind source |
| (extra) slot safety | `AtlasSlotWalAtRisk`, `AtlasDebeziumDisconnected` | < 1 GiB before `max_slot_wal_keep_size`, or `wal_status` unreserved/lost; connector disconnected |
| Stream lag per worker | `AtlasStreamLagHigh` | > 5 s for 1 min |
| Tick duration vs interval | `AtlasTickOverHalfInterval` | p99 > 50% of interval for 2 min |
| Read replica lag | `AtlasReplicaLagHigh` | > 2 s for 1 min |
| Builds queued | `AtlasBuildQueueStuck` | not empty for 60 s |
| Workers in list vs ready pods | `AtlasWorkerListMismatch` | mismatch for 30 s |
| Ownership moves | `AtlasOwnershipMovesSustained` | moving for 15 min (info; silence during deploys) |
| Connections, send-cap drops | `AtlasConnectionsJump`, `AtlasBackpressureDropsJump` | 1.5× / 3× the previous hour |
| Memory per worker | `AtlasWorkerMemoryHigh` | RSS > 70% of 4 GiB for 5 min |
| Sequence gaps | `AtlasSequenceGap` | any (expected around a Redis failover) |
| Ticks deferred by replica lag | `AtlasReplicaWaitsLong` | > 3 ticks per minute waiting over 1 s |
| Online sampler mismatches | `AtlasSamplerMismatch` | any |
| Event-loop delay, WS buffers | `AtlasEventLoopDelayHigh`, `AtlasWsBuffersNearCap` | p99 > 100 ms; average > 512 KiB buffered per client |
| Replica query cancellations | `AtlasReplicaQueryCancellations` | any increase |
| (extra) Redis memory | `AtlasRedisMemoryHigh` | > 80% of `maxmemory` |
| (extra) scrape health | `AtlasInfraTargetDown` | Debezium, Redis or Postgres target down for 1 min. Workers are left out until S-09. |

### Not covered yet

These plan rows have no metric in contracts §8, so there is no alert yet. Proposed metrics (need a `contract-change` PR):

| Plan row | Proposed metric |
| --- | --- |
| Re-check latency and rate; slowest views (p99 over 50 ms) | `atlas_recheck_duration_seconds` histogram, `atlas_view_build_duration_seconds` histogram |
| Pages queued | `atlas_page_queue_length` (or a `kind` label on `atlas_build_queue_length`) |
| Worker-to-worker stream errors, client resyncs | `atlas_peer_stream_errors_total`, `atlas_client_resyncs_total` |
| Full reloads triggered | `atlas_full_reloads_total{type}` |
| Ticks moved to the primary | `atlas_replica_fallbacks_total` (exact, instead of the histogram estimate) |
| Tick interval | `atlas_tick_interval_seconds` gauge (from `TICK_MS`) |

## Assumptions (pending S-09)

Confirm or fix these when S-09 lands:

1. Workers serve `/metrics` on their HTTP port (3000 / 3010 / 3020), replicator-sim on 3100. The `worker` label comes from the Prometheus target, not from the worker.
2. `atlas_tick_duration_seconds`, `atlas_commit_to_send_seconds`, `atlas_event_loop_delay_seconds` and `atlas_replica_wait_seconds` are histograms (`_bucket` series). `atlas_replica_wait_seconds` has a `le="1"` bucket.
3. Tick interval: `atlas_tick_interval_seconds` if a worker exports it, otherwise 1 s (the `TICK_MS` default). See `worker:atlas_tick_interval_seconds`.
4. `atlas_ws_buffered_bytes` is the worker's total. "Near the cap" = more than half of `maxBackpressure` (1 MiB) per client on average.
5. Memory limit is the plan's 4 GiB per worker. In OpenShift use the container limit (`container_spec_memory_limit_bytes`).
6. "Ready pods" locally = `view-service` targets that are up. Membership keys are counted with the pattern `*:workers:view-service-*` (contracts §2); the epoch key doesn't match. In OpenShift compare with `kube_pod_status_ready`.
7. The exporters connect to Postgres as the `postgres` superuser. Fine for local dev; production uses a role with `pg_monitor`.

## Validating changes

```bash
P=prom/prometheus:v3.15.0
docker run --rm --entrypoint promtool -v "$PWD/infra/monitoring/prometheus:/etc/prometheus:ro" $P check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint promtool -w /etc/prometheus/tests -v "$PWD/infra/monitoring/prometheus:/etc/prometheus:ro" $P test rules atlas-alerts.test.yml
curl -s 'localhost:3001/api/search?query=Atlas'    # the dashboard is provisioned
```

`--extend.query-path` is deprecated in postgres_exporter but still supported in v0.20.1. If a later version removes it, move `queries.yml` to a collector or to sql_exporter.
