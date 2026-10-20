# Postgres: primary + read replica with failover slots (task I-01)

| Service | Host port | Role |
| --- | --- | --- |
| `postgres-primary` | 5432 | Writes (replicator), logical decoding (Debezium) |
| `postgres-replica` | 5433 | Hot standby for view-worker queries; keeps a synchronized copy of Debezium's slot |

Both start from `npm run infra:up` with no manual steps:

1. The primary runs `init/*` on first start: roles, schema, outbox and publication, then `04-replica-slot.sql`, which creates the physical slot `replica_1`.
2. The replica's `replica/entrypoint.sh` waits for the primary. If its data directory is empty, it clones the primary with `pg_basebackup -R -S replica_1 -d "... dbname=atlas"`, then starts as a hot standby.
3. `npm run infra:down` deletes both volumes. The next `infra:up` recreates everything.

## Settings

| Setting | Where | Why |
| --- | --- | --- |
| `wal_level=logical` | both | Debezium decodes the outbox. On the replica it is required for slot synchronization and lets a promoted replica serve Debezium. |
| `max_slot_wal_keep_size=4GB` | both | Caps WAL kept for a lagging slot. If exceeded, the slot is invalidated (see infra/debezium/README.md). |
| `hot_standby_feedback=on` | both | The replica tells the primary which rows its queries still need, so they aren't cancelled by vacuum and synced slots stay valid. |
| `synchronized_standby_slots=replica_1` | primary | Logical walsenders (Debezium) never confirm changes the replica hasn't received. A promoted replica's slot copy is therefore never behind Debezium. |
| `primary_slot_name=replica_1` | replica (written by `pg_basebackup -R -S`) | The replica streams through a physical slot, so the primary keeps WAL it hasn't received. |
| `primary_conninfo ... dbname=atlas` | replica (written by `pg_basebackup -R -d`) | The slot sync worker needs a database name. |
| `sync_replication_slots=on` | replica | Postgres 17 slot sync worker: copies every slot created with `failover=true`. |

**Trade-off of `synchronized_standby_slots`:** if the replica is down, Debezium stops advancing, so events pause. They aren't lost. WAL piles up on the primary until the replica returns, or until `max_slot_wal_keep_size` invalidates `replica_1`. In that case, re-clone the replica (`docker compose -f infra/docker-compose.yml rm -sf postgres-replica && docker volume rm atlas-realtime_pg-replica && npm run infra:up`), or temporarily `ALTER SYSTEM SET synchronized_standby_slots = ''; SELECT pg_reload_conf();` on the primary.

## Connecting

There's no `psql` needed on your machine:

```bash
docker compose -f infra/docker-compose.yml exec postgres-primary psql -U postgres -d atlas
docker compose -f infra/docker-compose.yml exec postgres-replica psql -U postgres -d atlas
```

From the host: `postgres://atlas_reader:atlas_reader@localhost:5433/atlas` (replica), `postgres://atlas_writer:atlas_writer@localhost:5432/atlas` (primary).

## Checking replication lag

On the **primary**:

```sql
SELECT application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- WAL retained for the replica's physical slot
SELECT slot_name, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots WHERE slot_type = 'physical';
```

On the **replica**:

```sql
SELECT pg_is_in_recovery(),                          -- t on a standby
       pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
       now() - pg_last_xact_replay_timestamp() AS replay_delay;  -- grows when the primary is idle too
```

View workers wait for the replica to replay past a tick's position (plan caveat 5). They compare `pg_last_wal_replay_lsn()` with the primary's LSN for the events in that tick.

Measured locally: a table created and filled on the primary was readable on the replica after 214–312 ms over 3 runs. That includes about 100–200 ms of `docker exec` overhead.

## Is Debezium's slot synced on the replica?

```sql
-- primary: the slot Debezium created (failover must be t)
SELECT slot_name, plugin, failover, active, confirmed_flush_lsn FROM pg_replication_slots WHERE slot_type = 'logical';

-- replica: the synchronized copy
SELECT slot_name, synced, failover, temporary, invalidation_reason, confirmed_flush_lsn
FROM pg_replication_slots WHERE slot_type = 'logical';
```

- `synced = t` on the replica means the copy is maintained by the slot sync worker.
- The copy appears a few seconds after the slot is created (measured: about 5 s with a manually created `failover=true` slot; up to about 30 s when the sync worker is idle), and only once the slot has a consistent point.
- If it never appears, check the replica's log for `slot sync worker` messages. Common causes: missing `dbname` in `primary_conninfo`, `hot_standby_feedback` off, or `primary_slot_name` not listed in the primary's `synchronized_standby_slots`.

Manual check without Debezium:

```sql
-- primary
SELECT pg_create_logical_replication_slot('failover_test', 'pgoutput', false, false, true);  -- last arg: failover
-- replica, a few seconds later: slot_name = failover_test, synced = t
SELECT slot_name, synced FROM pg_replication_slots;
-- primary
SELECT pg_drop_replication_slot('failover_test');
```

## Promoting the replica by hand (drills)

```bash
# 1. (optional) stop the primary to simulate its loss
docker compose -f infra/docker-compose.yml stop postgres-primary
# 2. promote the replica
docker compose -f infra/docker-compose.yml exec postgres-replica psql -U postgres -c "SELECT pg_promote();"
#    or: docker compose -f infra/docker-compose.yml exec -u postgres postgres-replica pg_ctl promote -D /var/lib/postgresql/data
# 3. check: f = now a primary; synced slots become normal slots usable by Debezium
docker compose -f infra/docker-compose.yml exec postgres-replica psql -U postgres -d atlas \
  -c "SELECT pg_is_in_recovery();" -c "SELECT slot_name, synced, failover FROM pg_replication_slots;"
```

Measured drill: a `failover=true` slot advanced on the primary (heartbeat message + `pg_replication_slot_advance`) was still present on the promoted replica with the same `confirmed_flush_lsn`. `pg_logical_slot_peek_binary_changes` worked on it there.

**Caveat found in the drill:** when idle, the slot sync worker naps for up to about 30 s. A slot created moments before promotion may not be copied yet, and then it's gone after promotion. Debezium creates its slot once, so this only matters right after a fresh Debezium start. Before a planned switchover, check `synced = t` on the target first.

After promotion, Debezium must be pointed at the new primary (`postgres-replica:5432`). In production the Patroni primary Service does this. Writers must move too.

The drill is one-way: the old primary can't rejoin as-is. Reset with `npm run infra:down && npm run infra:up`.

## Production: Patroni

The POC doesn't run Patroni. Production must configure the equivalent:

- **Same parameters** in `postgresql.parameters` for every member: `wal_level: logical`, `max_slot_wal_keep_size: 4GB` (sized to the longest tolerable Debezium outage), `hot_standby_feedback: on`, `sync_replication_slots: on`, `max_wal_senders` and `max_replication_slots` with headroom.
- **Use Postgres 17 failover slots, not Patroni permanent slots** for Debezium. Patroni's `slots:` copies logical slots on a timer, and that lost committed rows in a tested failover (plan, "Write path" 7). Debezium creates its slot with `slot.failover=true`.
- **dbname in `primary_conninfo`:** Patroni builds `primary_conninfo` itself. Check on a standby (`SHOW primary_conninfo`) that it includes `dbname=`, because slot sync fails without it. Verify this against the Patroni version you deploy.
- **Physical slots per standby:** `use_slots: true` (default), so every standby streams through a physical slot named after the member.
- **`synchronized_standby_slots` callback:** this setting must list the *current* standbys' physical slot names, and the set changes on every failover or switchover. Add an `on_role_change` (and `on_start`) callback that, on the leader, runs `ALTER SYSTEM SET synchronized_standby_slots = '<standby slot names>'; SELECT pg_reload_conf();`. On replicas it should clear the setting.
- **Debezium address:** the Patroni primary Service (leader endpoint), never a member hostname.
- **Alerts:** slot `wal_status` not `reserved`, retained WAL (Debezium slot and standby slots), replica lag over 2 s, `synced` copy missing on standbys.
