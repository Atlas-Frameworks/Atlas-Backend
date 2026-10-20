# Debezium Server: outbox → Redis Streams (task I-03)

Every row inserted into `outbox` (and deleted again in the same transaction) appears in Redis stream `changes:<aggregatetype>`, with field `value` holding exactly the committed payload JSON.

```
replicator tx: UPDATE entity_type_sequence ... RETURNING seq; INSERT outbox; DELETE outbox; COMMIT
      │  (pgoutput, publication atlas_outbox = outbox only, failover slot atlas_outbox)
      ▼
Debezium Server 3.7 ── EventRouter → RegexRouter → DropHeaders   (heartbeats: confirmed, not written)
      │  XADD via redis-proxy:6380, then WAIT 1 (replica ack), retried
      ▼
Redis stream changes:<type>   entry: key=<aggregateid>  value=<payload JSON>
```

| What | Where |
| --- | --- |
| Image | `infra/debezium/Dockerfile`: official `quay.io/debezium/server:3.7.0.Final` plus the outbox router jar (see below) |
| Config | `application.properties`, with a comment on every setting |
| Health | http://localhost:8080/q/health (`/q/health/live`, `/q/health/ready`) |
| Read position | Postgres table `debezium_offsets` (JDBC offset store), flushed every 2 s |
| Replication slot | `atlas_outbox`, created by Debezium with `failover=true`; the replica holds a synced copy |
| Tests | `test/pipeline-test.sh` and `test/verify-streams.mjs` |

## Stream entry shape

```
XRANGE changes:airplanes - + COUNT 1
1) "1792497672374-2"                                   entry ID: Redis server time (ms) of the XADD
   1) "key"    2) "0267507e-d02b-a29e-65db-e790ee9405d5"  aggregateid, plain text
   3) "value"  4) "{\"id\": \"0267507e-...\", \"op\": \"upsert\", ..., \"affectedRoots\": null}"
```

- `value` is the payload's jsonb text exactly as Postgres stores it (key order and spacing are Postgres's), including `null` fields.
- There are no other fields.
- Consumers parse `value` as JSON. They must not rely on the entry ID matching the commit time; use `committedAt` and `typeSeq`.

This matches docs/contracts.md §2 ("Field `value` holds the JSON payload"). The `key` field is an addition, documented in a separate contract-change PR.

## What had to change from the starter config

Each problem below was found by running the image, not by reading docs.

| Problem | Symptom | Fix |
| --- | --- | --- |
| Outbox router not on the classpath. In 3.7, `io.debezium.transforms.outbox.EventRouter` ships in `debezium-connect-plugins`, which the image keeps in `lib_opt/` | `ClassNotFoundException: io.debezium.transforms.outbox.EventRouter` | `Dockerfile` copies that one jar into `lib/` (the `ENABLE_DEBEZIUM_SCRIPTING` switch would add all of `lib_opt/`, including a duplicate `debezium-connector-common`) |
| `route.topic.replacement=changes:$${routedByValue}`: Quarkus expands `${...}` in property values, and neither `$${` nor `\\${` escapes survive Debezium Server's `debezium.*` → `quarkus.debezium.*` re-read | `SRCFG00011: Could not expand value routedByValue`, restart loop | Keep the router's built-in default topic `outbox.event.<type>`, then rename with `RegexRouter` (`outbox\.event\.(.+)` → `changes:$1`) |
| Default `compact` sink format writes the record key as the field name | No `value` field | `debezium.sink.redis.message.format=extended` |
| `table.expand.json.payload=true` re-parses the payload and drops `null` fields | `affectedRoots` and `map: null` missing; entry ≠ payload | `expand.json.payload=false` with `debezium.format.value=simplestring` (and `format.key=simplestring` for a bare id) |
| Extended format stores every Kafka header as a field: `ID` and 5 × `__DEBEZIUM.CONTEXT.*`, about 400 bytes per entry | Redis memory roughly doubled | `source.extended.headers.enabled=false` and `DropHeaders` for the router's `id` header |
| Router applied to every record | Risk of `table.op.invalid.behavior=error` on non-outbox records | `isOutbox` predicate on the router; `message.prefix.exclude.list=heartbeat` hides the heartbeat's logical message |
| Dropping heartbeat records with a `Filter` SMT (my first attempt at keeping them out of Redis) | With no writes, `confirmed_flush_lsn` stopped advancing: the engine commits offsets only for records the sink processes | No filter. The Redis sink recognises the `__debezium-heartbeat` prefix, writes nothing, and marks them processed |
| Default `poll.interval.ms=500` | Commit-to-stream p99 970 ms, too close to the 1 s target | `poll.interval.ms=100`: p99 156–302 ms |
| Redis failover while the sink waits on `WAIT 1`: Redis aborts it with `UNBLOCKED ... (master -> replica?)`, which the sink treats as fatal. The engine stops but the JVM keeps running | Events stopped until a manual restart. Nothing lost (they wait in the slot) | Compose watchdog healthcheck: if `/q/health/live` is DOWN, SIGTERM the JVM so `restart: unless-stopped` restarts it. In OpenShift a liveness probe does the same (I-04) |

Property names were checked against the running 3.7.0.Final image. Kafka Connect logs `... was supplied but isn't a known config` for every unknown name, and the final config logs none. Logs are plain text (`quarkus.log.console.json.enabled=false`); the image defaults to JSON.

## Lag

Change log the slot still holds, i.e. what Debezium hasn't confirmed yet. Run on the primary:

```sql
SELECT slot_name, active, wal_status, failover,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS retained_wal,
       pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)                 AS retained_bytes
FROM pg_replication_slots WHERE slot_name = 'atlas_outbox';
```

- **Alert:** over 1 GB, or `active = f` for more than a few minutes (plan, "Observability and capacity").
- **`wal_status`:** `reserved` is healthy; `extended` means WAL is past `max_wal_size`; `unreserved` means it's about to exceed `max_slot_wal_keep_size`; `lost` means the slot is invalidated (next section).

End-to-end delay per event: Redis entry ID time minus the payload's `committedAt`. `verify-streams.mjs` prints p50/p99/max.

With no writes, the 10 s heartbeat still moves `confirmed_flush_lsn` forward, so retained WAL stays small. Measured over 2.5 minutes with no outbox writes:
- `confirmed_flush_lsn` advanced at every one of 10 samples, 16 s apart (`0/7AC2C10` → `0/7ACEB48`);
- retained WAL stayed between 1 and 20 kB;
- no heartbeat key appeared in Redis.

## When `max_slot_wal_keep_size` (4 GB) is exceeded

If Debezium is down or stuck long enough for 4 GB of WAL to pile up, Postgres **invalidates the slot** to protect its disk. `wal_status = 'lost'` and `invalidation_reason = 'wal_removed'`. The changes in that gap are gone and will never reach Redis. This is a **full-reload incident** (plan caveat 29).

Recovery:

```bash
C="docker compose -f infra/docker-compose.yml"
$C stop debezium
$C exec postgres-primary psql -U postgres -d atlas -c "SELECT pg_drop_replication_slot('atlas_outbox');"
# The stored offset points into the lost range; clear it so Debezium starts cleanly at the new slot.
$C exec postgres-primary psql -U postgres -d atlas -c "DELETE FROM debezium_offsets;"
$C start debezium    # creates a new failover slot at the current position (snapshot.mode=no_data)
```

Then:
- **Workers:** they see a `typeSeq` gap on every type with writes in the lost range, and reload those views from Postgres (S-02). In production also trigger reconciliation for all views, because types without writes after the gap won't show one.
- **Replica:** its synced copy of the old slot is dropped by the slot sync worker, and the new slot is copied within about 30 s. Check `synced = t` on the replica (infra/postgres/README.md).
- **Prevention:** alert on retained WAL long before 4 GB, and size `max_slot_wal_keep_size` to the longest Debezium outage you can tolerate.

## Restart and failure behaviour

- **Debezium restart or crash:** it resumes from `debezium_offsets` and may resend up to about 2 s of events (offset flush interval). Workers drop them by `version`.
- **Redis failover:** writes through the proxy fail for about 1–2 s (infra/redis/README.md). If the sink is mid-`WAIT` on the old master it fails, the watchdog restarts it, and it resends from its offset. Measured worst event delay: 7.6 s.
- **Replica down:** `synchronized_standby_slots` holds Debezium back, so events pause until the replica returns. That's why compose starts Debezium only after the replica is healthy.

## Tests

Needs `npm run infra:up` and Node 24 on the host.

```bash
infra/debezium/test/pipeline-test.sh                      # 10,000 rows over 4 types at ~1,000 rows/s
infra/debezium/test/pipeline-test.sh --kill-debezium      # docker kill halfway, then start again
infra/debezium/test/pipeline-test.sh --redis-failover     # SENTINEL FAILOVER halfway
infra/debezium/test/pipeline-test.sh --rows 200 --rate 0  # quick smoke test
```

How the test works:
- Each row is its own transaction, like the replicator's. It takes the next gapless `typeSeq`, inserts the outbox row and deletes it again.
- The same transaction stores the payload in `pipeline_test.expected`, so the expected set is exactly what committed.
- `verify-streams.mjs` checks per type that every committed payload is in `changes:<type>`, field `value`, identical (deep-equal), with first occurrences in commit order. Duplicates are counted and must equal the original.

### Results

Docker Desktop on macOS (Apple Silicon), Postgres 17, Redis 7.4, Debezium Server 3.7.0.Final; 10,000 rows per run at about 1,000 rows/s, random across `countries`, `connections`, `airports`, `airplanes`.

| Run | Missing | Duplicates | Out of order | Payload differs | Commit → stream p50 / p99 / max | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Clean | 0 | 0 | 0 | 0 | 60 / 302 / 348 ms | 0 of 10,000 over 1 s. Outbox empty afterwards: each insert+delete transaction gave exactly one entry |
| `docker kill` at 5,100 rows | 0 | 100 | 0 | 0 | 106 ms / 12.8 s / 12.9 s | Restarted after 3 s; resent from the last flushed offset |
| `docker kill` at 5,472 rows (earlier config) | 0 | 1,260 | 0 | 0 | 101 ms / 13.3 s / 13.4 s | Same test before the heartbeat fix |
| `SENTINEL FAILOVER` at 5,200 rows (with watchdog) | 0 | 0 | 0 | 0 | 102 ms / 7.4 s / 7.6 s | Sink failed on `UNBLOCKED`; watchdog restarted Debezium once |
| `SENTINEL FAILOVER` at 5,158 rows (before watchdog) | 4,700 until manual restart, then 0 | 0 | 0 | 0 | events delayed 205 s | Engine dead, JVM alive. After restart every event arrived, none lost |

Before `poll.interval.ms=100`, the clean run measured p50 531 ms and p99 970 ms. With it, two clean runs measured p99 156 ms and 302 ms.

No acknowledged event was lost in these runs. Redis can still lose acknowledged writes on failover (infra/redis/README.md, "Known limits"). Those surface as `typeSeq` gaps for workers, and T-03 measures them under harder failures (killing the master container).
