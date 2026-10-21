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
once and discard duplicates by `sequence` and `typeSeq`.

A normal replicator or publisher restart does not reset any table or sequence.
The publisher lease expires automatically, allowing another instance to take
over. Each entity type is independent and can later be assigned to a different
publisher or Redis deployment without changing the trigger flow.

## Configuration

Publisher settings are loaded from `apps/change-publisher/config/default.json`.
They are not read individually from `process.env`. The checked-in defaults are:

| Property | Default | Purpose |
| --- | --- | --- |
| `databaseUrl` | `postgresql://atlas_publisher:atlas_publisher@localhost:5432/atlas` | Primary PostgreSQL connection |
| `redisUrl` | `redis://localhost:6380` | Stable Redis master endpoint |
| `sourceSchema` | `benchmark_publisher` | Source schema; other values are rejected |
| `owner` | Generated per process when omitted | Lease owner identity |
| `batchSize` | `1000` | Events claimed per entity and batch |
| `leaseSeconds` | `30` | Entity publisher lease duration |
| `idleDelayMilliseconds` | `100` | Delay when no event is available or a retry is needed |

To configure an environment, add
`apps/change-publisher/config/<environment>.json` containing only its overrides.
For example, `config/production.json` can contain:

```json
{
  "databaseUrl": "postgresql://atlas_publisher:secret@postgres.example/atlas",
  "redisUrl": "rediss://redis.example:6380",
  "batchSize": 2000
}
```

Select it with the single environment selector:

```powershell
$env:PUBLISHER_ENV = 'production'
npm run publisher:start
```

The selected file is merged over `default.json`. If `PUBLISHER_ENV` is not set,
only `default.json` is used. If it names a missing or invalid file, startup fails
instead of silently using local defaults. Do not commit environment files that
contain production secrets.

Run locally after `postgres:setup` and `postgres:seed`:

```bash
npm run publisher:start
```

## PostgreSQL schema contract

The Publisher environment keeps application data in a dedicated schema. In
this repository that schema is `benchmark_publisher`; no commerce entity table
is required under `public`.

Every synchronized entity table must have:

- an `id uuid` column;
- a primary key or another application-enforced uniqueness rule for `id`;
- its business columns;
- `sequence bigint NOT NULL`, supplied by the source replicator;
- `updated_at timestamptz NOT NULL DEFAULT now()`.

For example:

```sql
CREATE TABLE benchmark_publisher.items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price      numeric(12, 2) NOT NULL CHECK (price >= 0),
  type       text NOT NULL,
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

The shared Publisher infrastructure is installed in `public` by
`infra/postgres/init/03-outbox.sql` and
`infra/postgres/init/04-commerce-sync.sql`:

| Object | Responsibility |
| --- | --- |
| `synchronized_entity_types` | Registry, independent sequence state and publisher lease for every entity type |
| `build_entity_changes(old, new)` | Builds the business-field diff and excludes `id`, `sequence`, and `updated_at` |
| `validate_entity_sequence()` | Requires a positive source sequence and rejects non-increasing updates |
| `sync_entity_change()` | Appends the raw event to the entity-specific durable outbox in the business transaction |
| `register_synced_table()` | Creates the outbox, grants permissions, registers the type and attaches both triggers |
| `claim_sync_events()` | Claims a batch under a lease and assigns `typeSeq` values after commit |
| `mark_sync_events_published()` | Deletes rows only after Redis accepted the batch |

Register each table once after creating it:

```sql
SELECT public.register_synced_table(
  'benchmark_publisher.items'::regclass,
  'items'
);
```

Registration creates `benchmark_publisher.items_outbox` with this logical
shape:

```sql
event_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
aggregate_id   text NOT NULL,
payload        jsonb NOT NULL,
event_sequence bigint UNIQUE,
published_at   timestamptz,
created_at     timestamptz NOT NULL DEFAULT clock_timestamp()
```

It also creates these triggers on the source table:

```text
atlas_validate_sequence BEFORE INSERT OR UPDATE -> public.validate_entity_sequence()
atlas_sync_change     AFTER INSERT OR UPDATE OR DELETE -> public.sync_entity_change(...)
```

Do not allocate `typeSeq` in the entity transaction for this pipeline. The
outbox trigger writes the payload without `typeSeq`; `claim_sync_events()` adds
it when the Publisher claims a committed batch. A separate outbox and publish
loop per entity type prevents one busy entity type from blocking the others.

The `atlas_writer` role needs write access to source tables and insert access
to their outboxes. `atlas_publisher` needs only the granted registry reads and
execution rights on the claim/acknowledgement functions; it does not need to
write application tables directly.

The repository's complete setup and registration examples are in:

- `infra/postgres/init/03-outbox.sql`
- `infra/postgres/init/04-commerce-sync.sql`
- `infra/postgres/init/05-register-commerce.sql`

## Redis event format

For an entity type named `items`, the Publisher executes the equivalent of:

```text
XADD changes:items * value <JSON payload>
```

An update is stored in the `value` field as JSON:

```json
{
  "schema": 3,
  "type": "items",
  "id": "7f1c2a9e-36e7-4f83-a50c-d21497d7628a",
  "op": "upsert",
  "sequence": 918260,
  "typeSeq": 918273,
  "committedAt": "2026-10-20T10:15:03.123Z",
  "changes": {
    "old": { "price": 50.25 },
    "new": { "price": 72.9 }
  }
}
```

An insert is also an `upsert`: `changes.old` is empty and `changes.new`
contains every business field. A no-op update contains two empty objects. A
delete has no `changes` member:

```json
{
  "schema": 3,
  "type": "items",
  "id": "7f1c2a9e-36e7-4f83-a50c-d21497d7628a",
  "op": "delete",
  "typeSeq": 918274,
  "committedAt": "2026-10-20T10:16:11.456Z"
}
```

The authoritative payload schema is
`packages/protocol/schema/outbox-event.v3.json`. Delivery is at least once, so
consumers must use `sequence` and `typeSeq` to reject duplicates and detect
gaps.
