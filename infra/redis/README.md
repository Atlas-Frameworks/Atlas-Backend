# Redis + Sentinel + master-only proxy (task I-02)

| Service | Host port | Role |
| --- | --- | --- |
| `redis-primary`, `redis-replica` | not published | One master and exactly one replica. Which is master changes on failover. |
| `sentinel-1..3` | not published | Quorum 2, master name `atlas` |
| `redis-proxy` (HAProxy) | 6380, stats 8404 | Always routes to the current master. Used by Debezium and by apps on your machine. |

The nodes aren't published on the host on purpose: after a failover, "redis-primary" may be the replica. Always connect through `localhost:6380`. For direct access, use `docker compose -f infra/docker-compose.yml exec redis-primary redis-cli`.

## Configuration

`redis.conf` (both nodes):

| Setting | Why |
| --- | --- |
| `appendonly yes`, `appendfsync everysec` | At most about 1 s of acknowledged writes lost if a node crashes |
| `min-replicas-to-write 1`, `min-replicas-max-lag 10` | A master without a live replica refuses writes (`NOREPLICAS`), which also stops writes to a stale master during split brain |
| `maxmemory 2gb`, `maxmemory-policy noeviction` | Streams and worker-list entries are never silently evicted; writes fail instead |
| `repl-diskless-sync-delay 0` | The resync after a failover starts at once, not after 5 s |

- **Configs are copied into each container's `/data` on first start only.** Sentinel rewrites them on failover, and a restart must keep that (otherwise a restarted old master comes back as a second master). After editing `redis.conf` or `sentinel.conf`, run `npm run infra:down` so the next start copies them again.
- **`sentinel-reconfig.sh`** is Sentinel's `client-reconfig-script`. When a failover ends, the leader runs `REPLICAOF` on the old master straight away. Without it, Sentinel only converts the old master after its 10 s INFO period plus grace time. Until then the new master has no replica and `min-replicas-to-write` rejects every write: the first drill measured a 15 s outage.
- **`haproxy.cfg`:**
  - checks every 500 ms and requires `role:master`;
  - sends `QUIT` before reading, so a demoted node fails the check at once;
  - `on-marked-down shutdown-sessions` cuts existing connections to a node that stops being master;
  - `balance first`, so traffic only ever goes to one node;
  - resolves container names through Docker DNS.

## Useful commands

```bash
C="docker compose -f infra/docker-compose.yml"
$C exec sentinel-1 redis-cli -p 26379 SENTINEL get-master-addr-by-name atlas   # current master
$C exec sentinel-1 redis-cli -p 26379 SENTINEL replicas atlas                  # replicas as Sentinel sees them
$C exec sentinel-1 redis-cli -p 26379 SENTINEL FAILOVER atlas                  # manual failover
docker run --rm --network atlas-realtime_default redis:7.4 redis-cli -h redis-proxy -p 6380 INFO replication
```

From your machine with a local `redis-cli`: `redis-cli -p 6380 INFO replication` always shows `role:master`.

## HAProxy stats page

Open http://localhost:8404/stats. In the `redis_nodes` backend:

- the current master is green (**UP**);
- the replica is red (**DOWN**, reason `L7RSP`/`L7TOUT` at the `role:master` step), which is expected;
- during a failover the two swap within about 1 s;
- **Cur** sessions shows client connections on the master; **Wght/Act/Bck** shows which node is serving.

If both rows are red, there's no master (Sentinel is still failing over, or quorum is lost) and clients get connection resets.

## Failover drill

```bash
npm run infra:up
infra/redis/failover-drill.sh        # optional: seconds to keep writing after the failover (default 20)
```

The drill:
1. writes `XADD drill:<ts> * n <i>` through the proxy every 50 ms, with a new connection each time;
2. runs `SENTINEL FAILOVER atlas`;
3. keeps writing;
4. reports the outage window and error kinds, and checks that every acknowledged `n` is still in the stream.

It exits non-zero if an acknowledged entry is missing, the master didn't change, or writes took more than 10 s to resume. Running it twice fails over and back.

### Results

Docker Desktop on macOS (Apple Silicon), Redis 7.4, HAProxy 3.2; 15 s of writes after the failover command.

| Run | Failover | Failed writes | Outage window | Resumed after `FAILOVER` | Error kinds | Acknowledged lost |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | primary → replica | 28 of 317 | 1.68 s | 1.88 s | 18 NOREPLICAS, 10 READONLY | 0 of 289 |
| 2 | replica → primary | 18 of 321 | 1.01 s | 1.18 s | 18 NOREPLICAS | 0 of 303 |
| 3 | primary → replica | 31 of 327 | 1.74 s | 2.01 s | 17 NOREPLICAS, 14 READONLY | 0 of 296 |

Before the fixes above, the same drill measured 15.1 s (READONLY from slow health checks, plus NOREPLICAS until Sentinel demoted the old master), and 6.3 s with only the reconfig script (5 s waiting on `repl-diskless-sync-delay`).

- `NOREPLICAS` is the new master refusing writes until the old master has resynced as its replica.
- `READONLY` is the proxy still sending writes to the just-demoted node, for up to one health-check cycle.

Neither error acknowledges a write, so neither loses data. Clients must retry: Debezium does, with `wait.retry.enabled`.

## Known limits

- **Redis can still lose acknowledged writes on failover.** Replication is asynchronous. `min-replicas-to-write` only checks that a replica *was* connected recently, not that it received a given write, and `WAIT` (Debezium's `wait.enabled`) narrows the gap but doesn't close it. The drill above, a graceful `SENTINEL FAILOVER`, lost nothing. A crash of the master under load can. That's why every event carries `typeSeq` and workers reload on a gap (plan caveat 39).
- **A crashed master stalls writes until it returns.** With `min-replicas-to-write 1` and exactly one replica, a new master has no replica until the old node comes back and resyncs. This was not measured here (the drill uses a graceful failover); T-03 should kill the master container and measure it. It trades availability for not acknowledging writes that exist on only one node. Adding a second replica fixes it, but see the next point.
- **Debezium's `wait.enabled` waits for exactly 1 replica.** Its Redis sink's replica check misbehaves with 2 or more replicas (plan, "Write path" 4). Keep exactly 1 replica, or test Debezium with more before adding one.
- **Split brain is bounded, not prevented.** For a moment two nodes can report `role:master`. `balance first` sends everything to one of them, and `min-replicas-to-write` makes a master without a replica refuse writes.
