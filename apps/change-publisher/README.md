# Change publisher

The change publisher replaces the Debezium outbox relay. A database trigger
appends raw events to a separate durable outbox for every registered entity
type. The publisher starts one independent loop for each type and performs:

1. Claim a batch and allocate its gapless per-type `typeSeq` in PostgreSQL.
2. Append every payload to Redis Stream `changes:<entityType>`.
3. Delete the acknowledged rows from that entity's outbox.

If the process stops before Redis accepts a batch, the rows remain pending. If
it stops after Redis accepts a batch but before PostgreSQL deletes it, the batch
is sent again. Consumers must therefore continue treating delivery as at least
once and discard duplicates by `version` and `typeSeq`.

A normal replicator or publisher restart does not reset any table or sequence.
The publisher lease expires automatically, allowing another instance to take
over. Each entity type is independent and can later be assigned to a different
publisher or Redis deployment without changing the trigger flow.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://atlas_publisher:atlas_publisher@localhost:5432/atlas` | Primary PostgreSQL connection |
| `REDIS_URL` | `redis://localhost:6380` | Stable Redis master endpoint |
| `PUBLISHER_ID` | Generated per process | Lease owner identity |
| `PUBLISHER_BATCH_SIZE` | `1000` | Events claimed per entity and batch |
| `PUBLISHER_LEASE_SECONDS` | `30` | Entity publisher lease duration |
| `PUBLISHER_IDLE_DELAY_MS` | `100` | Delay when no event is available or a retry is needed |

Run locally after `postgres:setup` and `postgres:seed`:

```bash
npm run publisher:start
```
