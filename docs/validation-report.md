# Close the failure-path gaps before building

**Verdict: the plan is sound in shape but not yet airtight.** In normal operation it is best-practice, scales well past 3–5k users, and fits a Node/TypeScript team. Every serious problem sits in a failure path: a Redis failover, a Postgres failover, a lagging read replica, or a change that arrives while a query is already running. These are the moments when a realtime system silently shows wrong data. Its core choices match systems that already run in production. Hashing each view to one owner pod, which the other pods subscribe to, is how Slack's channel servers work. Re-checking changed rows against the database, instead of recomputing views in memory from the change stream, is the direction Figma moved LiveGraph after trying the alternative. No off-the-shelf engine supports these filters, so the custom loop is justified. Six fixes are mandatory before a proof of concept (POC) counts as done. The Debezium Redis sink cannot follow a Sentinel failover. Redis can lose recently acknowledged events. Patroni slot failover can lose events with nothing raising an error. The replica source-sequence guard does not cover related entities. Changes that arrive mid-query can be missed. Cross-entity invalidation (when a change to one entity should update views of another) needs one source of truth and continuous checking. Most of the remaining changes are configuration: membership epochs, graceful handoff, memory caps and a single stream trimmer. Node is adequate. Java is only worth it if the POC shows a tick using more than about half the core.

## Six fixes make the pipeline loss-proof; the rest is tuning

The table ranks every required change. P0 changes prevent silent data loss or wrong views. P1 changes prevent outages or overload under churn and deploys. P2 changes are hardening and efficiency. The evidence for each row is in the per-area sections below.

| # | Pri | Problem | Concrete fix / config |
|---|---|---|---|
| 1 | P0 | The Debezium Server Redis sink connects to a single `host:port` (or Redis Cluster). It has **no Sentinel support**. After a failover it keeps writing to the old master and gets `READONLY` errors, which can stop the engine. | Put a stable "current master" endpoint in front of Redis. Options are HAProxy with a `role:master` health check, or a Sentinel `client-reconfig-script` that relabels the master pod behind an OpenShift Service. Run a failover test that confirms Debezium reconnects. |
| 2 | P0 | Redis replication is asynchronous, so **acknowledged writes can vanish on failover**. Debezium has already committed those offsets and will not resend. `wait.enabled` defaults to off, and when WAIT falls short with `wait.retry.enabled=false` the sink only logs a warning. | Set `wait.enabled=true` and `wait.retry.enabled=true`, `min-replicas-to-write 1`, and AOF `appendfsync everysec` on every node. Run exactly one replica, or test first: the sink's `!=` replica check misfires when there are 2 or more. Accept that loss is reduced, not removed, and rely on gap detection (row 3). |
| 3 | P0 | A per-entity source sequence **cannot detect a lost event** because gaps are normal when only part of the source is replicated. Consumers whose last-read stream ID is past the new master's tail after a failover will skip entries. | The relay writes a separate **per-entity-type `typeSeq`** into each outbox payload. Consumers check `typeSeq == last+1`, allowing a short reorder window. Reload the affected view or type from Postgres when there is a gap, when the last-read ID has been trimmed (it is older than the stream's first entry), or on a Sentinel `+switch-master` event. |
| 4 | P0 | **Postgres failover can silently lose outbox events.** Patroni copies logical slots on a timer ("not a hard guarantee"), and a recreated slot starts at the current position. Outbox rows are deleted right after insert, so no snapshot can recover the lost events. | Use PG17+ native failover slots with Debezium `slot.failover=true`. On standbys set `sync_replication_slots=on` and `hot_standby_feedback=on`, and put `dbname` in `primary_conninfo`. Manage `synchronized_standby_slots` with a Patroni callback. Before any planned failover, check that the standby slot shows `synced=t, temporary=f`. Set `offset.mismatch.strategy=trust_offset` so a mismatch fails loudly, connect to the Patroni leader Service, and size `max_slot_wal_keep_size` to cover 1–2 h of WAL, with alerts. |
| 5 | P0 | The replica source-sequence guard protects only the root row. A re-check can see the new airplane next to a **stale airport row**. A re-check or full run already in flight can also **miss a change that lands during it**. | Read the replica's replay position (`pg_last_wal_replay_lsn()`) once per tick and defer the batch until the replica has passed the highest commit LSN in it. Requeue an ID rather than drop it, and fall back to the primary after N retries. If a change for ID X arrives while a query covering X is running, mark X dirty and re-check it next tick. Buffer all changes that arrive during a full run and apply them after it finishes. |
| 6 | P0 | **Cross-entity invalidation is the riskiest custom logic** in the plan. Deletes, FK moves, multi-hop links and array/JSONB links are each easy to miss. | Generate the SQL compiler and the reverse-dependency map from **one field registry**. Use both the old and new values of a changed row (pre- and post-image). Add a CI property test: incremental result == full re-run result. Run an online sampler in production, and have reconciliation *report* the differences it fixes. Better still, have the replicator emit the affected root IDs into the outbox at write time (see the live query section). |
| 7 | P1 | Pods read the heartbeat list at different moments and can disagree on owners. Deployment pod names change on every rollout, which **reshuffles every view**. | Store members in one Redis hash with an `INCR epoch:{svc}` on every join or leave, and publish a Pub/Sub change event. Send the epoch on every gRPC subscribe. A pod that is asked for a view it does not own replies "not owner, epoch=N" instead of dropping the request. Use a StatefulSet so pod names are stable. `DEL` a pod's key on shutdown, and react to a broken gRPC stream at once rather than waiting for the TTL. |
| 8 | P1 | Rolling deploys restart owners and socket holders together. This is the **thundering herd** (a burst of simultaneous rebuilds and reconnects) that hurt Figma's original LiveGraph. | Hand views over make-before-break (see the view ownership section). Use `maxSurge: 1`, `maxUnavailable: 0`, `minReadySeconds: ~10`, `terminationGracePeriodSeconds: 60`, a semaphore of 10–20 concurrent view builds per pod, and jittered client reconnects. |
| 9 | P1 | A 4 MB per-client send cap × ~1,500 sockets per pod = **6 GB of possible buffered data in a 4 GB pod**. Node's default heap in a 4 GB container is only ~2 GB. | Set uWS `maxBackpressure` to about 1 MB and resnapshot clients that exceed it. Set `--max-old-space-size=2560 --max-semi-space-size=32` (or 64). Hold indexes in typed arrays. |
| 10 | P1 | ~1,000 views × one query per view per tick puts **O(changed IDs × views) load on the replica**. | Canonicalize and hash filter trees so identical filters share one view. Evaluate many views' filters in **one statement per entity type per tick**. Set `statement_timeout` on the view-service role, and write filter expressions so a bad value cannot raise an error. |
| 11 | P1 | Every pod running `XTRIM`, plus one Redis shared by several services, means extra contention, and a memory spike **pauses Debezium for all services**. | Run one leader-elected trimmer: `XTRIM changes:X MINID ~ <now-600000>`. Size Redis memory for 10 minutes of events (about 1.3–1.6 GB per 6k/s stream, estimate) plus 2× fork headroom. Set `maxmemory-policy noeviction` and namespace keys per service. |
| 12 | P2 | Debezium defaults replay up to ~60 s of events after a crash, and an idle slot retains WAL. | Use a Deployment with `replicas: 1` and `strategy: Recreate`, a JDBC offset store in Postgres with `offset.flush.interval.ms=1000–5000`, and a heartbeat via `pg_logical_emit_message`. On Debezium 3.4+ set `lsn.flush.mode=connector_and_driver`. Outbox router settings are listed below. |
| 13 | P2 | OpenShift router defaults: a sticky cookie and `random` balancing. | Add the route annotations `disable_cookies: "true"`, `balance: leastconn` and `timeout-tunnel: 5m`. Use uWS `idleTimeout: 16` with automatic pings. |
| 14 | P2 | Client-side specifics: CSP-safe Protobuf, per-entity object churn, and framework re-render load. | Use protobuf-es or static protobufjs, with packed `bytes` position arrays, a dedicated Worker, Cesium BufferPointCollection behind the adapter, deck.gl attribute buffers, and a low-rate UI snapshot channel. |

## Change capture: the outbox is right, the Redis hop is the weak link

The Postgres → Debezium → outbox half is textbook. Inserting the outbox row and deleting it in the same transaction is exactly what Debezium's own outbox post recommends. The table "will always be empty", yet both events still reach the change log, and the Outbox Event Router drops the DELETEs automatically ([Debezium blog](https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/); [Outbox Event Router docs](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)). Finalize it with this configuration:

- `tombstones.on.delete=false`.
- `table.op.invalid.behavior=error`, so an accidental UPDATE on the outbox fails loudly.
- `route.topic.replacement=changes:${routedByValue}`.
- A publication that contains only the outbox table: `publication.autocreate.mode=filtered` plus `table.include.list`.
- `snapshot.mode=no_data`.
- The event `id` added as a header via `table.fields.additional.placement`.
- `message.format=extended`, which gives stable `key`/`value` fields. Header names come out uppercased.

Ordering is preserved per entity because one slot is read in sequence and `aggregateid` becomes the key. Debezium is **at-least-once**: after a crash it can replay up to a full offset-flush interval of events, 60 s by default ([Debezium Engine docs](https://debezium.io/documentation/reference/stable/development/engine.html)). Version-based deduplication in the consumers handles that.

The Redis hop is where data goes missing. Reading the sink's source code shows that standalone mode creates one Jedis client from one address, and there is **no Sentinel pool at all** ([RedisConnection.java](https://github.com/debezium/debezium/blob/main/debezium-storage/debezium-storage-redis/src/main/java/io/debezium/storage/redis/RedisConnection.java)). WAIT is hard-coded to one replica. With retry disabled, a short WAIT is logged as a warning and treated as success ([WaitReplicasRedisClient.java](https://github.com/debezium/debezium/blob/main/debezium-storage/debezium-storage-redis/src/main/java/io/debezium/storage/redis/WaitReplicasRedisClient.java)). Even a correct WAIT "does not make Redis a strongly consistent store", and promotion during failover is "best-effort" ([Redis WAIT docs](https://redis.io/docs/latest/commands/wait/)). The pipeline therefore has to *detect* loss rather than *prevent* it, which is why rows 2 and 3 in the table go together.

Postgres failover is the second loss path. A dbi-services test of Patroni failover without a synced slot ended with "Five committed rows, gone, and nothing anywhere raised an error". The same test with PG17 failover slots produced only duplicates ([dbi-services](https://www.dbi-services.com/blog/surviving-a-patroni-failover-with-logical-replication/)). Patroni 4.1 does not manage `synchronized_standby_slots`, so you have to script it. A 2026 production write-up puts the rule plainly: "Replay is recoverable with idempotent consumers; an LSN gap is not" ([ShiftMag](https://shiftmag.dev/how-to-survive-database-failover-debezium-and-postgresql-in-production-11676/)). Here, LSN (log sequence number) means a position in Postgres's write-ahead log (WAL), and the replication slot is the bookmark Postgres keeps for Debezium. If WAL grows past `max_slot_wal_keep_size`, Postgres invalidates the slot ([Morling](https://morling.dev/blog/mastering-postgres-replication-slots)). In an outbox design, that means a full reload of the views from Postgres, so build and test that path. Debezium Server has no active-standby mode, and the Debezium Operator is still `v1alpha1` ([Operator docs](https://debezium.io/documentation/reference/stable/operations/debezium-operator.html)). Run one pod with the `Recreate` strategy and rely on fast restart.

Redis Streams remains a reasonable choice at about 6k events/s per type with a 10-minute window, provided gap detection triggers a resync. Consider moving to NATS JetStream if any of these happen:

- Gap-triggered resyncs become frequent.
- Retention has to outgrow RAM.
- Fan-out read bandwidth (event rate × pods × services) approaches a single primary's NIC.

JetStream has a Debezium Server sink, replicates via Raft (a quorum protocol, so an acknowledged write survives losing one node), and retains by time without a separate trimmer ([NATS by Example](https://examples.nats.io/examples/integrations/debezium/cli)). This is a judgment call, not a benchmarked result.

## View ownership: right pattern, missing epoch and handoff

Hashing views to owner pods, with the WebSocket-holding pods subscribing to owners, matches Slack. There, gateway servers subscribe to channel servers chosen by consistent hashing, and a replacement server is ready in "under 20 seconds" ([Slack Engineering](https://slack.engineering/real-time-messaging/)). Rendezvous hashing is the right algorithm for 3–5 nodes and about 1,000 views. It needs no virtual nodes, and only the keys of the pod that changes move. Bounded-load hashing caps each node at c times the average load. That only matters if a few views are far heavier than the rest, and it makes ownership depend on live load data that all pods would need to agree on ([Vimeo](https://medium.com/vimeo-engineering-blog/improving-load-balancing-with-a-new-consistent-hashing-algorithm-9f1bd75709ed)). Measure per-view cost first, and pin outliers manually. Accepting brief duplicate owners is fine because views are read-only. Kleppmann calls this an "efficiency lock", which only needs fencing tokens once the holder writes something ([Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)). Google's Slicer ran *all* production users in a mode that could briefly assign a key twice, with 0.004% misrouting ([Colyer on Slicer](https://blog.acolyer.org/2016/12/02/slicer-auto-sharding-for-datacenter-applications/)).

The gap is coordination during change. Orleans tags every directory operation with a membership *view number* and forces a retry on mismatch ([Orleans docs](https://learn.microsoft.com/en-us/dotnet/orleans/implementation/grain-directory)). Your equivalent is the Redis epoch from row 7, plus "soft fencing": every owner message carries `{ownerPod, epoch, viewVersion}`, and subscribers ignore older epochs. Redis heartbeats are acceptable for this kind of efficiency-only purpose. Redis's own docs warn that keys can be lost or reappear across a failover ([Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)). Expect a burst of handoffs that self-heals within one 3 s renewal. Add flap damping: a rejoining pod becomes an owner only after one full TTL of continuous presence. This guards against a Node GC pause dropping the key.

Handoff must be make-before-break. Shard Manager moves shards *before* planned container stops, because drop-then-add causes unavailability ([Meta Engineering](https://engineering.fb.com/2020/08/24/production-engineering/scaling-services-with-shard-manager/)). Figma's original LiveGraph wiped its caches on every deploy and suffered a thundering herd ([Figma 100x](https://www.figma.com/blog/livegraph-real-time-data-at-scale/)). The shutdown sequence:

1. `preStop` sleep of 5–10 s so the router stops sending new connections.
2. On SIGTERM: fail readiness, `DEL` the heartbeat, `INCR` the epoch and publish the change.
3. Subscribers subscribe at the new owner, wait for its snapshot, then drop the old one. The old owner serves until it has no subscribers or ~15 s have passed.
4. Send clients a reconnect hint with 0–5 s random jitter, then close their sockets.
5. Exit.

No maintained Node library does this; ringpop-node was archived in 2020 ([GitHub](https://github.com/uber-node/ringpop-node)). Keep it as roughly 200–300 lines in three tested modules: membership, owner (the rendezvous calculation) and handoff. Add a chaos test that kills a pod, freezes one with `SIGSTOP`, and fails over Redis.

For pod-to-pod gRPC, gRPC's keepalive defaults are too slow to notice a dead peer quickly. The server pings every 2 h by default and rejects client pings more frequent than every 5 minutes ([gRPC keepalive](https://grpc.io/docs/guides/keepalive/)). Since you own both ends, set:

- Client: `grpc.keepalive_time_ms=10000` and `keepalive_timeout_ms=5000`.
- Server: `grpc.http2.min_ping_interval_without_data_ms=5000`.

These option names come from inference and should be verified against grpc-js. Give each subscriber a bounded queue at the owner. When the queue overflows, drop the queued deltas and send one fresh snapshot. Redis Pub/Sub instead of gRPC is a defensible simpler alternative, as Centrifugo does ([Centrifugo engines](https://centrifugal.dev/docs/server/engines)). It loses per-subscriber backpressure and adds more hot-path traffic to the shared Redis, so keep gRPC.

## Live query maintenance: re-check by ID is proven; cross-entity links are not

Re-querying changed IDs is the strongest part of the plan. Figma moved LiveGraph *away* from in-memory updates driven by the change stream, back to invalidate-and-re-query. The reasons: "most query results never change after initial load", re-querying "always yields the newest result" so event ordering stops mattering, and the team "didn't want to maintain a system that replicates database behavior" ([Figma](https://www.figma.com/blog/livegraph-real-time-data-at-scale/); [HN](https://news.ycombinator.com/item?id=41325612)). Hasura re-polls *whole* results every 1 s ([Hasura docs](https://hasura.io/docs/2.0/subscriptions/postgres/livequery/execution/)). Scoping the re-check to changed IDs is strictly cheaper for 30k-row views. `WHERE id = ANY($1::bigint[])` is the right primitive, and PG17 fetches multiple array values in one B-tree pass ([Crunchy Data](https://www.crunchydata.com/blog/real-world-performance-gains-with-postgres-17-btree-bulk-scans)). Cost comes from filter expressions and joins, not from finding rows. That is why batching many views into one statement (row 10), as Hasura's multiplexing does, is the main lever. Use custom plans (`plan_cache_mode=force_custom_plan`, or unnamed statements) for full runs and reconciliation, because generic plans can be badly wrong on skewed JSONB data. PgBouncer ≥1.21 supports protocol-level prepared statements in transaction mode via `max_prepared_statements` ([Crunchy Data](https://www.crunchydata.com/blog/prepared-statements-in-transaction-mode-for-pgbouncer)).

Cross-entity changes, such as an airport edit affecting airplane views, are where every surveyed system restricts features or over-invalidates on purpose. LiveGraph allows only 11 "hard" query shapes out of ~700, and evicts them wholesale. Asana found that join invalidation "can turn writes into read load" ([Asana](https://asana.com/inside-asana/scaling-invalidation-pipeline-part-1)). Hasura calls event-to-query mapping "intractable for complex conditions or cross-table permissions" ([Hasura architecture](https://github.com/hasura/graphql-engine/blob/master/architecture/live-queries.md)). The plan's registry plus full re-run on connection edits follows the right instinct, but it is the most likely source of silent mistakes. These cases must be covered:

- Related-entity deletes.
- Link changes, where both the old and the new parent's dependents are affected.
- Multi-hop links (airplane → airport → country).
- JSONB/array links.

The strongest simplification is to **move reverse mapping to the write side**. The replicator is the only writer, so when it changes an airport it can run one indexed lookup and put the affected airplane IDs into the outbox. Cross-entity invalidation then becomes ordinary root-ID invalidation. Figma's verification stack (chaos tests, an online sampler comparing cache against the primary, a convergence checker) is the model for rows 5 and 6. Reconciliation every 10 minutes is good. A non-zero diff rate means a bug, so log it rather than quietly correcting it.

Replica reads carry two separate risks. The first is staleness, which the LSN check in row 5 solves. The second is query cancellation when WAL replay conflicts with a running query. That mostly hits long full runs, which `max_standby_streaming_delay` cancels after 30 s by default. `hot_standby_feedback` reduces cancellations but bloats the primary ([thebuild.com](https://thebuild.com/blog/all-your-gucs-in-a-row-hot_standby/)). Run reconciliation on the primary or a dedicated replica if `pg_stat_database_conflicts` shows cancellations.

Live server-side pages follow trading-grid practice: a server-side sorted key array per view, with only the visible window and total count sent to the client ([Vuu](https://vuu.finos.org/docs/providers_tables_viewports/viewports); [Deephaven Barrage](https://deephaven.io/barrage/docs/concepts/)). Make the sort key total, `(sortValue, id)`, so tied rows do not flicker between positions. Each tick, send the window's ordered ID list plus full data only for rows that are new or changed. That is idempotent and avoids shift-operation algebra. A sorted array with binary search is enough at 30k rows.

Client-supplied filter trees must compile from a closed grammar:

- Field IDs come from the registry, never raw column names.
- Operators come from a per-type whitelist.
- Values are bind parameters with explicit casts.
- The login scope is AND-ed server-side, outside the client's tree.
- Depth, node count and IN-list size are capped.

Electric and Zero enforce the same principles ([Electric](https://electric.ax/docs/guides/shapes); [Zero](https://zero.rocicorp.dev/llms.txt)). No off-the-shelf engine fits the requirements. Electric has no JSONB operators, Zero cannot filter array elements and wants sticky sessions, and pg_ivm has no ORDER BY/LIMIT. Streaming databases would need ~1,000 materialized views created at runtime ([pg_ivm](https://github.com/sraoss/pg_ivm); [Zero deployment](https://zero.rocicorp.dev/docs/deployment)). The custom loop is justified.

## Node server and client: correct stack, three sizing traps

uWebSockets.js is the right server library. It uses about 5 KB per idle connection, against ~52 KB for Socket.IO ([Evil Martians](https://evilmartians.com/chronicles/choose-your-fighter-benchmarking-5-websocket-servers-for-nodejs)). It has native topic pub/sub that frames a message once for all subscribers, and real backpressure controls. Use `app.publish(topic, buf, true)` per view page per tick. Wrap sends from timer, Redis and gRPC callbacks in `ws.cork()`, which the uWS guide calls "by far the single most important performance trick" ([uWS guide](https://github.com/uNetworking/uWebSockets/blob/master/misc/READMORE.md)). Publish silently skips sockets that are over `maxBackpressure`, so frames need sequence numbers and the client must detect gaps. Operationally:

- uWS is **not on npm**. Pin a Git tag and vendor it into your internal registry.
- v20.67.0 supports Node 22/24/26 and dropped 20 ([releases](https://github.com/uNetworking/uWebSockets.js/releases)).
- Run a startup smoke test on your UBI base image to catch glibc problems.
- The README's "all rights reserved" line sits alongside Apache-2.0, which may warrant legal review.

The three sizing traps:

1. **Send caps vs pod memory** (row 9).
2. **Heap default.** Node 20+ gives a 4 GB container only ~2 GB of heap unless you set `--max-old-space-size` ([Red Hat Developer](https://developers.redhat.com/articles/2025/10/10/nodejs-20-memory-management-containers)).
3. **Object-heavy indexes.** A V8 Map with 2^20 slots costs ~29 MB before its values, and it rehashes inside `set()` ([V8 Map internals](https://dev.to/puzpuzpuz/v8-deep-dives-understanding-map-internals-fc6)). Use struct-of-arrays instead: typed arrays per field indexed by a dense slot number, which keeps the data outside the garbage-collected heap.

On 1 CPU, worker threads do not add parallelism. Split long ticks with `setImmediate` (an `await` on a resolved promise does not let I/O run), and alert when event-loop delay p99 exceeds ~50–100 ms. Keep compression off on the LAN. Centrifugo measured permessage-deflate roughly doubling CPU unless each broadcast is compressed only once ([Centrifugo](https://centrifugal.dev/blog/2024/08/19/optimizing-websocket-compression)). The OpenShift router's tunnel timeout defaults to 1 h and its client/server timeouts to 30 s ([OCP IngressController](https://docs.redhat.com/en/documentation/OpenShift_container_platform/4.18/html/operator_apis/ingresscontroller-operator-openshift-io-v1)). Edge routes default to `random` balancing with a sticky cookie ([Red Hat Developer](https://developers.redhat.com/articles/2025/07/02/how-haproxy-router-settings-affect-middleware-applications)). Router reloads can drop tunnels, so jittered reconnect and resume-by-snapshot are required, not optional.

The client plan is sound:

- **Worker.** A dedicated Worker with transferable ArrayBuffers costs the same regardless of size. Structured-clone payloads should stay under ~10 KiB per frame ([Surma](https://surma.dev/things/is-postmessage-slow/)). Rotate two or three buffers per layer between threads.
- **No SharedArrayBuffer.** It requires COOP/COEP headers that can block cross-origin map tiles, and Safari lacks `credentialless` ([CentralCSP](https://next.centralcsp.com/en/blog/coop-coep-cross-origin-isolation)).
- **SharedWorker opt-in only.** Android support only returned in Chrome 148 ([Notebookcheck](https://www.notebookcheck.org/Chrome-148-Beta-para-Android-anade-soporte-para-Web-Serial-y-SharedWorker.1269767.0.html)).
- **Protobuf.** Prefer protobuf-es: v2.14 is up to 2× faster to decode and under 19 KB gzipped ([Buf](https://buf.build/blog/protobuf-es-performance)). Alternatively use static protobufjs, since its reflection mode depends on `new Function` and slows down under a strict CSP ([protobufjs](https://github.com/protobufjs/protobuf.js/blob/6a6c00c3e1def5d35c7fcaa1bbb6ce4e0fe67544/README.md)). Put positions in a raw `bytes` field so the worker can wrap them in a typed array without creating a JS object per entity.
- **Cesium.** The experimental BufferPointCollection with bulk `setPositions` fits this model ([Cesium docs](https://cesium.com/learn/cesiumjs/ref-doc/BufferPointCollection.html)). Keep PointPrimitiveCollection as a fallback, and use `show` instead of `remove` ([Cesium docs](https://cesium.com/learn/cesiumjs/ref-doc/PointPrimitiveCollection.html)).
- **deck.gl.** Feed typed arrays straight in as `data.attributes` ([deck.gl performance](https://deck.gl/docs/developer-guide/performance)).
- **MapLibre.** Avoid GeoJSON sources for high-churn layers, because `updateData` still goes through worker tiling ([MapLibre](https://maplibre.org/maplibre-gl-js/docs/API/classes/GeoJSONSource/)).
- **Frameworks.** Keep map ticks out of framework state entirely. React's `useSyncExternalStore` forces blocking renders ([React docs](https://react.dev/reference/react/useSyncExternalStore)), so feed it a 2–4 Hz UI snapshot channel. In Angular, signals set from the worker handler work well under zoneless change detection, the default in v21 ([Angular](https://angular.dev/guide/zoneless)).
- **Lists.** Use fixed-height rows, because CDK autosize is "not ready for production use yet" ([Angular CDK](https://raw.githubusercontent.com/angular/components/main/src/cdk/scrolling/scrolling.md)).
- **Background tabs.** Hidden Chrome tabs fall to one-per-minute timer wakeups after 5 minutes ([Chrome](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). Handle `visibilitychange`: coalesce while hidden and resnapshot on return.

## What the proof of concept must prove

These choices are confirmed best practice and need no change:

- A transactional outbox with insert+delete.
- One Debezium per slot.
- Fan-out XREAD without consumer groups.
- Rendezvous hashing at this scale.
- Accepting duplicate owners for read-only views.
- Re-query-by-ID over in-memory change-stream maintenance.
- Periodic reconciliation.
- Server-side sorted windows.
- uWS with topic publish.
- A worker-based SDK with transferable typed arrays and engine adapters.
- Node over Java at this load. One 2021 test ranked Node+uWS fastest at 10k clients ([Tomasetti](https://matttomasetti.medium.com/websocket-performance-comparison-10dc89367055)). No credible benchmark shows Node too slow for 1–2k sockets per pod.

The POC should produce numbers for each of these open questions, since none has a published benchmark:

- **Failover drills with real writes.** A Patroni switchover and a Redis Sentinel failover, each under load. The target is zero lost events, with duplicates allowed. Gap detection and the full-reload path must trigger automatically.
- **Throughput.** Debezium plus the Redis sink at the summed event rate with WAIT on, together with end-to-end latency. The Debezium docs publish no throughput figures.
- **Redis memory** under real payloads, using `MEMORY USAGE`, compared against the ~1.3–1.6 GB per-stream estimate.
- **Replica lag** at full write rate, and how often the LSN check defers a tick.
- **Batched multi-view queries vs one query per view**, measuring per-tick database time with ~1,000 views.
- **Per-tick CPU and GC** on a 1 CPU pod with 2M-entry typed-array indexes. This is also the trigger for the Java question: if a tick uses more than ~50% of the interval and cannot be sharded further, revisit.
- **Correctness of the cross-entity registry**, via the property test and the online sampler. Only the registry has no prior art to borrow from.
- **Client performance:** BufferPointCollection vs PointPrimitiveCollection at 30k points, and protobuf-es vs static protobufjs decode on the real schema.
- **A rolling deploy and a reconnect storm** through the actual OpenShift router.

## Conclusion

The design's main risk is not scale but silent divergence. Each layer is at-least-once or best-effort: Debezium replays, Redis drops tail entries on failover, Patroni slots can jump, and replicas lag. Each layer is fine on its own, but together they mean views can drift from Postgres with no error anywhere. So the most valuable additions are not more infrastructure but a few cheap invariants carried end to end: a per-type sequence number, a commit LSN, and a membership epoch. Each consumer checks these and falls back to "reload from Postgres". Once those exist, every failure mode above becomes a detectable, recoverable event instead of a quiet bug.

The second takeaway is that the riskiest code is the cross-entity reverse mapping, and the cleanest fix is architectural. The replicator is already the sole writer, so it can tell the pipeline which root entities a related change affects. That removes the hardest invalidation logic from the view service, and leaves the view service with only the "easy" invalidation that Figma's experience shows stays maintainable.
