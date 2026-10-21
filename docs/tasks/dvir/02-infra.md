# 02 · Infrastructure

Starter files already exist in `infra/` but have never been run. Each task brings its part up, proves it works, and fixes what's wrong. Read the plan sections "Write path", "The shared Redis" and "Recovery after crashes and restarts" first.

---

## I-01 · Postgres primary + replica with failover slots

- **Depends on:** nothing
- **Size:** M
- **Files:** `infra/docker-compose.yml` (postgres services), `infra/postgres/**`

**Goal.** A Postgres 17 primary with logical decoding enabled and a streaming read replica that keeps a synchronized copy of Debezium's replication slot.

**Deliverables**

1. `postgres-primary` and `postgres-replica` start from `npm run infra:up` with no manual steps. The replica clones the primary on first start (`infra/postgres/replica/entrypoint.sh`).
2. **Primary settings:**
   - `wal_level=logical`, `max_slot_wal_keep_size=4GB`, `hot_standby_feedback=on`;
   - `synchronized_standby_slots` set to the replica's physical slot name, after creating a physical replication slot for the replica;
   - the replica uses that slot in `primary_slot_name`.
3. **Replica settings:** `sync_replication_slots=on`, `hot_standby_feedback=on`, and the database name in `primary_conninfo`.
4. **`infra/postgres/README.md`:**
   - how to check replication lag (`pg_stat_replication`, `pg_last_wal_replay_lsn()`);
   - how to see whether Debezium's slot is synced on the replica (`pg_replication_slots.synced`);
   - how to promote the replica by hand for drills (`pg_ctl promote` or `SELECT pg_promote()`).

**Acceptance criteria**

- [ ] `psql` to port 5433 can read tables created on the primary within 1 s.
- [ ] After Debezium (I-03) creates its slot with `failover=true`, `SELECT slot_name, synced FROM pg_replication_slots` on the replica shows it with `synced = t`.
- [ ] Wiping volumes and restarting recreates everything automatically.

**Notes.** Production uses Patroni. Document in the README what Patroni must be configured with (the same settings, plus a callback that sets `synchronized_standby_slots`), but don't run Patroni in the POC.

---

## I-02 · Redis + Sentinel + master-only proxy

- **Depends on:** nothing
- **Size:** M
- **Files:** `infra/redis/*`, `infra/haproxy/haproxy.cfg`, compose services `redis-*`, `sentinel-*`, `redis-proxy`

**Goal.** Redis with automatic failover, plus a stable "always the master" address for clients that can't use Sentinel (Debezium) and for local development.

**Deliverables**

1. Primary, replica and 3 Sentinels running from compose. The config enforces AOF `everysec`, `min-replicas-to-write 1` and `maxmemory-policy noeviction`.
2. `redis-proxy` (HAProxy) routes port 6380 only to the node that reports `role:master`, and kills existing sessions to a node that stops being master.
3. Script `infra/redis/failover-drill.sh`:
   1. writes a counter stream through the proxy every 50 ms;
   2. triggers `SENTINEL FAILOVER atlas`;
   3. reports how long writes failed and whether any acknowledged entry is missing afterwards.
4. `infra/redis/README.md` covering the commands above, how to read the HAProxy stats page (`:8404/stats`), and the known limits:
   - Redis can still lose acknowledged writes on failover;
   - Debezium's `wait.enabled` waits for exactly 1 replica, so keep exactly 1 replica or test with more.

**Acceptance criteria**

- [ ] `redis-cli -p 6380 INFO replication` always shows `role:master`, before and after a failover.
- [ ] The failover drill completes, and writes resume through the proxy within 10 s.
- [ ] Results of three drill runs are recorded in the README.

---

## I-03 · Debezium Server outbox pipeline

- **Depends on:** I-01, I-02, W-01 (schema and publication; the starter SQL is enough to begin)
- **Size:** M
- **Files:** `infra/debezium/application.properties`, compose service `debezium`

**Goal.** Every row inserted into `outbox` appears, exactly as its JSON payload, in Redis stream `changes:<aggregatetype>` within 1 s. The pipeline survives restarts without losing events.

**Deliverables**

1. **Check every property** in `application.properties` against the Debezium 3.7 docs and fix wrong names, especially the JDBC offset store and outbox router options.
2. **Use the right image:** confirm the image tag. If the Redis sink or JDBC offset store isn't in the default image, build `infra/debezium/Dockerfile`.
3. **Prove the stream entry format:** stream name `changes:airplanes`, entry field holding the payload JSON. Document the exact entry shape in `docs/contracts.md` §2 (separate `contract-change` PR if it differs).
4. **Prove the outbox stays empty:** inserting and deleting a row in one transaction emits exactly one stream entry.
5. **Heartbeat:** prove that with no writes for 2 minutes, the replication slot's `confirmed_flush_lsn` still advances.
6. **`infra/debezium/README.md`:**
   - health URL;
   - how to read lag (slot retained WAL: `pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)`);
   - what happens when `max_slot_wal_keep_size` is exceeded (the slot is invalidated, a full-reload incident) and how to recover (drop the slot, restart Debezium, workers reload).

**Acceptance criteria**

- [ ] A test script inserts 10,000 outbox rows across 4 types. All 10,000 arrive in the right streams, in commit order per type.
- [ ] Kill Debezium mid-run (`docker kill`), restart it: nothing is missing, duplicates are allowed.
- [ ] Redis failover mid-run (via I-02's drill): Debezium continues through the proxy. Any loss is reported by the drill, which feeds T-03.

---

## I-04 · OpenShift deployment manifests

- **Depends on:** S-01, S-07 (shutdown and handover behaviour must exist to be configured)
- **Size:** M
- **Files:** `deploy/` (Helm chart or Kustomize; pick one and justify)

**Goal.** Everything the team maintains, deployable to OpenShift with the settings the plan requires.

**Deliverables**

1. **view-service as a StatefulSet** (stable pod names, which the hashing needs):
   - `podManagementPolicy: Parallel`;
   - rolling updates one pod at a time;
   - readiness probe = worker registered and caught up;
   - liveness probe;
   - preStop sleep 5 s, `terminationGracePeriodSeconds: 60`;
   - env `WORKER_NAME` from `metadata.name`;
   - `NODE_OPTIONS="--max-old-space-size=2560 --max-semi-space-size=32"`;
   - resources: 1 CPU, 4 GiB.
2. **A headless Service for pod-to-pod gRPC,** and a normal Service plus Route for WebSockets with:
   - `haproxy.router.openshift.io/disable_cookies: "true"`;
   - `haproxy.router.openshift.io/balance: leastconn`;
   - `haproxy.router.openshift.io/timeout: 60s`;
   - TLS edge termination.

   Check each annotation name against the OpenShift version you deploy to.
3. **HorizontalPodAutoscaler:** min 3, max 5, on memory and a custom metric if available.
4. **Debezium:** a Deployment with 1 replica, `strategy: Recreate`, config as a ConfigMap, and the database address = the Patroni primary Service.
5. **replicator-sim:** a Deployment.
6. **Config for two view services** (S-10) from the same chart with different values.

**Acceptance criteria**

- [ ] `helm template` (or `kustomize build`) renders without errors, and `kubeconform` validates the output in CI.
- [ ] Deployed to a test namespace: 3 workers become ready, and a rolling restart completes with no client errors beyond reconnects.

---

## I-05 · Prometheus and Grafana dashboards

- **Depends on:** S-09
- **Size:** S

**Goal.** See whether the system meets its targets at a glance.

**Deliverables**

1. **Compose services** `prometheus` and `grafana` with provisioning files in `infra/monitoring/`.
2. **Scrape targets:** workers, replicator, Debezium (Quarkus metrics), Redis (redis_exporter), Postgres (postgres_exporter).
3. **Dashboard "Atlas realtime":**
   - commit-to-send p50/p99;
   - tick duration vs interval;
   - views and entities per worker;
   - stream lag;
   - sequence gaps;
   - reconcile and sampler mismatches;
   - replica lag and replay waits;
   - slot retained WAL;
   - WebSocket connections and buffered bytes;
   - event-loop delay;
   - Redis memory and outbound traffic.
4. **Alert rules** matching the plan's "Observability and capacity" table.

**Acceptance criteria**

- [ ] `npm run infra:up` includes monitoring; Grafana at `localhost:3001` shows the dashboard with live data while the simulator runs.
