# 05 · View service (`apps/view-service`, NestJS)

The workers. Every pod serves the WebSocket clients connected to it and owns a share of the views. NestJS provides modules, DI, config and the HTTP endpoints (health, metrics). The hot paths (WebSockets, ticks) use uWebSockets.js and plain TypeScript, not Nest request handling.

Plan sections: "View worker internals", "Cleanup", "Client protocol", "Pagination", "Multi-pod deployment without sticky sessions", "Recovery", "Technology choices" (Node build rules). Contracts: §2, §3, §4, §6, §8.

Suggested module layout under `src/`:

```
config/      env schema (F-03)
streams/     S-02  Redis stream consumer, sequence checks
db/          S-03  pg pools, query runner, build queue
owner/       S-04  owned views, tick loop, reconciliation, sampler, lifecycle
gateway/     S-05  uWebSockets.js server, client sessions, subscriptions
cluster/     S-06  membership;  S-07 gRPC owner/subscriber, handover, shutdown
trimmer/     S-08
metrics/     S-09
```

---

## S-01 · View-service skeleton (NestJS + uWebSockets.js)

- **Depends on:** F-01 (F-03 when available)
- **Size:** M

**Goal.** A runnable worker with all the plumbing, so later tasks only add behavior.

**Deliverables**

1. **Nest app with modules** matching the layout above; empty providers are fine.
2. **Typed config:**
   - `SERVICE_NAME`, `WORKER_NAME`, `HTTP_PORT`, `WS_PORT`, `GRPC_PORT`;
   - `PG_REPLICA_URL`, `PG_PRIMARY_URL`, `REDIS_URL`;
   - `ENTITY_TYPES` (which types this service owns);
   - `TICK_MS` (default 1000).
3. **uWebSockets.js:**
   - installed from a pinned GitHub release tag;
   - mirror note in the README;
   - started on `WS_PORT` in an `OnApplicationBootstrap` hook;
   - a binary-message echo route to prove it works.
4. **Endpoints:** `GET /health/live`, `GET /health/ready` (readiness reported by later tasks via a `ReadinessService`), `GET /metrics` placeholder.
5. **Graceful shutdown hook** (`enableShutdownHooks`) with a `ShutdownCoordinator` service. Later tasks register ordered steps; S-07 implements the handover.
6. **Startup check** that uWebSockets.js loads its native binary, with a clear error on unsupported glibc. Plus a `Dockerfile` based on Red Hat UBI 9 Node 24 that runs it.
7. **Heap flags** documented and set in the `start:prod` script: `--max-old-space-size=2560 --max-semi-space-size=32`.

**Acceptance criteria**

- [ ] `npm run dev:view-service` starts; `/health/live` returns 200; a WebSocket client gets binary echo.
- [ ] The Docker image builds and starts on UBI 9.
- [ ] SIGTERM runs registered shutdown steps in order, then exits 0.

---

## S-02 · Change-stream consumer with gap detection

- **Depends on:** S-01, P-02, E-05
- **Size:** M

**Goal.** Read every change stream this service needs, in order, and never miss a lost event silently.

**Deliverables**

1. **Reader:**
   - streams = this service's entity types plus every related type its registry joins to (countries, connections, airports…);
   - a dedicated Redis connection running `XREAD BLOCK 1000 COUNT 1000 STREAMS ...` with per-stream last IDs; no consumer groups;
   - parsed with `parseStreamEntry` (P-02).
2. **Start position:** the current end of each stream (`$`), recorded at startup before any view build (see S-04 build steps).
3. **Every event goes through `SequenceTracker`:**
   - on `gap`: emit `reloadType(type)`; S-04 then rebuilds every owned view that depends on that type;
   - on `duplicate`: drop.
4. **Reset and trim detection:**
   - on reconnect, compare the last ID with the stream's first entry (`XINFO STREAM`);
   - if the last ID is older than the first entry, or the stream was recreated: `reloadType(type)`.
5. **Replica freshness helper:** `waitForReplica(lsn)`. At tick start, S-04 reads `pg_current_wal_lsn()` from the primary; this helper polls `pg_last_wal_replay_lsn()` on the replica every 50 ms until it has caught up, or 2 s pass (then it returns `usePrimary`).
6. **Metrics:** `atlas_stream_lag_seconds`, `atlas_sequence_gaps_total`, `atlas_replica_wait_seconds`.

**Acceptance criteria**

- [ ] Integration test with real Redis: inject a gap (skip a `typeSeq`) → `reloadType` fires once.
- [ ] `XTRIM` past the reader's position while it is disconnected → reload on reconnect.
- [ ] 20,000 events/s across 4 streams parsed and delivered with event-loop delay p99 < 50 ms on one core. Record the result.

---

## S-03 · Postgres access layer and build queue

- **Depends on:** S-01, E-02
- **Size:** M

**Goal.** Run the engine's SQL safely and efficiently, and never flood Postgres.

**Deliverables**

1. **Pools:**
   - `pg` pools for the replica (about 20 connections) and the primary (about 5);
   - `statement_timeout = 2s` for re-checks and `30s` for full runs;
   - `application_name = <service>/<worker>`.
2. **`runRecheck(stmt, {usePrimary})`:**
   - executes a `compileRecheckBatch` statement as a named prepared statement;
   - maps the boolean columns back to views using `stmt.columns`.
3. **`runFull(stmt)`:** an unnamed statement or `SET LOCAL plan_cache_mode = force_custom_plan`, so the plan fits the filter values.
4. **`fetchRows(type, ids, kind)`** for pages and details.
5. **`BuildQueue`:**
   - at most 8 concurrent full builds per worker;
   - FIFO with priority for views that have waiting subscribers;
   - simultaneous requests for the same `viewKey` share one build.
6. **Retries:** on connection errors, with backoff. A `statement_timeout` on a re-check marks the view for a full run, logs, and increments a metric.

**Acceptance criteria**

- [ ] 20 simultaneous build requests for the same view → 1 query.
- [ ] 50 requests for different views → never more than 8 running at once.
- [ ] Integration test against Testcontainers Postgres with seed data.

---

## S-04 · View owner runtime: tick, reconciliation, lifecycle

- **Depends on:** S-02, S-03, E-04 (E-03, E-05)
- **Size:** L

**Goal.** The heart of the worker. Every view this worker owns is kept exactly in sync with Postgres, every tick, cheaply.

**Deliverables**

1. **`OwnedView`:** view def, `ViewStore`, layouts, subscribers (local clients and remote workers, both through one interface), and per-subscription `seq` counters.
2. **Build:**
   1. record stream positions;
   2. queue a full query (S-03);
   3. `applyFull`;
   4. replay events received since the recorded position;
   5. mark ready.
3. **Tick loop** every `TICK_MS`, never overlapping. If a tick overruns, the next one merges the backlog.
   1. `drain()` from `TickBatcher`.
   2. Read the primary's current change-log position and `waitForReplica`.
   3. Run link queries for related-entity changes; run full runs for connection changes through the build queue.
   4. One `runRecheck` per entity type covering all candidate views.
   5. `applyRecheck` per view; version guard, with stale IDs retried next tick.
   6. Build deltas per subscription: map deltas from event `map` fields; page windows via `window()` plus `fetchRows` for new or changed visible IDs only; detail updates.
   7. Hand frames to the delivery layer: local topic publish (S-05) and remote streams (S-07).
   8. Yield with `setImmediate` between views, so ticks never block sockets for long.
4. **Reconciliation:**
   - each view gets a full query every 10 minutes, with start times spread across views;
   - differences are logged and counted (`atlas_reconcile_mismatches_total`), then corrected through the normal delta path.
5. **Sampler:** every minute, 3 random views are fully re-queried and compared (`atlas_sampler_mismatches_total`).
6. **Lifecycle:**
   - reference count per view, page and detail; 60 s grace after the last subscriber, then dispose;
   - memory cap: evict idle views first, then refuse builds with `RETRY`.
7. **Relative-time filters** are rejected for now, returning an `INVALID_FILTER` message per the plan.

**Acceptance criteria**

- [ ] With the simulator (W-03) at the base profile and 200 views on one worker, the end-to-end check (T-02) shows 0 mismatches over 30 minutes.
- [ ] Tick duration p99 < 50% of `TICK_MS` on one CPU for 200 views. Record the numbers.
- [ ] A view with no subscribers is gone 60 s later, and its memory is released (heap snapshot or metric).

---

## S-05 · Client WebSocket layer: auth, subscriptions, fan-out

- **Depends on:** S-01, P-01
- **Size:** L

**Goal.** Serve browser clients efficiently: one encoded frame per view per tick, no matter how many clients watch it.

**Deliverables**

1. **uWebSockets.js app:**
   - `idleTimeout: 16` (automatic pings);
   - `maxBackpressure: 1 MB`;
   - `compression: DISABLED` for normal frames; snapshots may use the shared compressor.
2. **Auth:** first message must be `Auth` within 5 s.
   - POC: a signed JWT from a dev key holding `userId`, `allowedCountries`, `allowedConnections`; the production OIDC check comes later.
   - Reject a protocol version other than the current or previous one.
3. **Session state per socket:**
   - `viewRef` → `viewKey`;
   - subscriptions (map, page, detail) with their topic names;
   - last `seq` sent per subscription.
4. **`OpenView` handling:**
   - validate the filter (E-01) and scope against the user's allowed countries and connections;
   - compute `viewKey`;
   - locally owned → attach directly; otherwise → the remote subscription manager (S-07). Behind an interface so S-05 works before S-07 exists, by treating every view as local.
5. **Fan-out:**
   - each map, page or detail subscription maps to a uWS topic (`v:<viewKey>:map`, `v:<viewKey>:page:<group>:<page>:<size>`, `d:<type>:<id>`);
   - deltas are published once per topic with `app.publish(topic, bytes, true)`;
   - sends from non-uWS callbacks are wrapped in `cork()`.
6. **Snapshots and resync:**
   - new subscription or `Resync` → per-socket snapshot with a fresh `seq` baseline;
   - a socket over `maxBackpressure` misses publishes, and its client detects the gap by `seq` and asks for `Resync`.
7. **Access stream:** read `<svc>:access`; on revoke, close the user's affected subscriptions with an `AUTH` error.
8. **Limits:** max 50 views per connection, max 5 `OpenView` per second per user.
9. **Planned shutdown:** send `Reconnect{afterMs: random 0–15000}` and close sockets in batches. Registered with the ShutdownCoordinator.

**Acceptance criteria**

- [ ] 1,000 simulated clients on one worker watching 50 views: CPU stays below 50% of a core at the base load profile. Record the result.
- [ ] Throttled client → its buffered bytes stay ≤ 1 MB, it receives `Resync`-driven snapshots, and the worker's memory stays flat.
- [ ] Opening a view outside the user's countries → `AUTH` error. A detail request for an out-of-scope entity is refused.

---

## S-06 · Worker membership in Redis

- **Depends on:** S-01, E-06
- **Size:** M

**Goal.** Every worker knows, within seconds and consistently, which workers exist and which view each owns.

**Deliverables**

1. **Registration** after startup steps are complete:
   - `SET <svc>:workers:<WORKER_NAME> {...} PX 10000`, renewed every 3 s;
   - on join, `INCR <svc>:workers:epoch` and `PUBLISH <svc>:workers:changes <epoch>`.
2. **Watcher:**
   - subscribe to the change channel and re-read the list (`SCAN` the prefix) on every notice and every 3 s;
   - feed `Membership.update` (E-06) and emit `ownershipChanged(epoch, eligibleWorkers)`.
3. **Shutdown step:** delete own key, `INCR` epoch, `PUBLISH`.
4. **Redis connection:** in production, ioredis with Sentinel (`sentinels`, `name: 'atlas'`); locally `REDIS_URL` → the proxy.
5. **Interface `MembershipSource`,** so the OpenShift endpoint watcher or DNS can replace Redis later without touching other code.

**Acceptance criteria**

- [ ] 3 workers: kill one → others see it gone within 10 s; restart it → eligible again after 10 s of presence.
- [ ] `SIGSTOP` one worker for 15 s, then `SIGCONT` → it rejoins and becomes eligible only after the damping period.
- [ ] Redis failover → membership re-converges within 10 s.

---

## S-07 · Worker-to-worker subscriptions and handover

- **Depends on:** S-04, S-05, S-06
- **Size:** L

**Goal.** A client can open any view on any worker; the worker that owns it computes it once and streams it to every worker that needs it. Ownership changes and deploys cause snapshot reloads, never wrong data.

**Deliverables**

1. **gRPC server and client** for `ViewOwner.Subscribe` (P-01), one bidirectional stream per subscriber→owner pair.
   - Keepalive: client ping 10 s, timeout 5 s; server permits pings every 5 s.
   - Mutual TLS behind a config flag.
2. **`RemoteSubscriptionManager`,** the subscriber side:
   - ref-counts local client subscriptions per (owner, subKey) and sends `Sub` and `Unsub`;
   - **listen first, then snapshot:** buffers deltas until the snapshot arrives, then drops deltas with `seq` ≤ the snapshot's;
   - forwards payload bytes to the local uWS topic without re-encoding.
3. **Owner side:**
   - accepts a `Sub` only if `ownerOf(viewKey) == self` at its current epoch, otherwise replies `NotOwner{epoch}`;
   - a bounded queue per subscriber stream (e.g. 2 MB); overflow → drop queued deltas and send one snapshot when the stream drains.
4. **Ownership change** on an `ownershipChanged` event, a broken stream or `NotOwner`:
   1. subscribe at the new owner;
   2. receive its snapshot and send local clients a snapshot;
   3. unsubscribe from the old owner (make before break).

   Simultaneous moves are capped by the build queue on the new owner.
5. **Planned shutdown sequence** (ShutdownCoordinator, in order):
   1. readiness → false;
   2. leave membership (S-06);
   3. wait until the other workers have re-subscribed elsewhere (owner sees its subscriber count reach 0) or 20 s pass;
   4. send `Reconnect` to local clients (S-05);
   5. exit.
6. **Epoch on every message;** messages from an older epoch are ignored.

**Acceptance criteria**

- [ ] 3 workers, clients spread randomly: every view exists on exactly one worker in steady state (debug endpoint `/debug/views` lists owned views).
- [ ] Kill the owner of a watched view → its clients on other workers keep their sockets and receive a snapshot within 15 s.
- [ ] Rolling restart of all 3 workers under load → no client errors other than planned reconnects and snapshot reloads; T-02 checks show 0 mismatches afterwards.

---

## S-08 · Stream trimmer

- **Depends on:** S-01
- **Size:** S

**Goal.** Streams keep about 10 minutes of history without every worker trimming.

**Deliverables**

1. Every 60 s, each worker tries `SET trim-lock:<type> <worker> NX PX 90000` for each stream it reads. The holder runs `XTRIM changes:<type> MINID ~ <now-10min>-0` and renews its lock.
2. Retention configurable: `STREAM_RETENTION_MS`, default 600 000.
3. Metric: stream length and memory (`XINFO STREAM`, `MEMORY USAGE`).

**Acceptance criteria**

- [ ] With 3 workers, only one trims each stream (check the logs).
- [ ] Stream memory plateaus under steady load.

---

## S-09 · Metrics, logging and health

- **Depends on:** S-01
- **Size:** S

**Goal.** Everything in contracts §8 and the plan's observability table is measured.

**Deliverables**

1. **`prom-client` registry** at `/metrics` with every metric in contracts §8, plus the default Node metrics.
2. **Event-loop delay** via `monitorEventLoopDelay`, exported as a histogram.
3. **`commit_to_send`:** event `committedAt` → frame publish time, observed per delta.
4. **Structured logs** (F-03) with `viewKey` and `subId` where relevant.
5. **Readiness:** true only when registered in membership, streams are caught up (lag < 2 s), and the uWS server is listening.

**Acceptance criteria**

- [ ] `curl /metrics` shows every metric name from contracts §8.
- [ ] Readiness flips to false during shutdown and while catching up after start.

---

## S-10 · Multiple services from one engine

- **Depends on:** S-04
- **Size:** S

**Goal.** Prove the plan's "one engine, many services" model: the same code runs as two services with different entity types.

**Deliverables**

1. Config-driven registry selection: `ENTITY_TYPES=airplanes` for service `tracks`, `ENTITY_TYPES=airports,countries` for service `reference`.
2. Redis key prefixes per `SERVICE_NAME`, separate worker lists, the same shared streams.
3. `npm run dev:cluster` (F-02) extended to run 2 services × 3 workers.
4. Client SDK config listing service URLs per entity type (coordinate with C-01).

**Acceptance criteria**

- [ ] Both services run side by side locally with separate membership. A client watches airplanes (tracks) and airports (reference) at once.
