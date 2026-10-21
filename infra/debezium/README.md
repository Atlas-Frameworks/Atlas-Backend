# Debezium PostgreSQL outbox relay

Debezium reads entity-specific outbox tables from PostgreSQL logical decoding,
applies the Outbox Event Router transformation, and writes the payloads to
Redis Streams. It does not read the entity tables directly.

The benchmark uses `benchmark_debezium` as its isolated source schema. Its
runtime configuration is `infra/benchmark/debezium.properties`; the base
configuration template is `infra/debezium/application.properties`.

## PostgreSQL schema contract

Every synchronized entity table must have the same application shape used by
the Publisher environment:

- `id uuid` as its stable entity identifier;
- its business columns;
- `sequence bigint NOT NULL`, supplied by the source replicator;
- `updated_at timestamptz NOT NULL DEFAULT now()`.

For example:

```sql
CREATE TABLE benchmark_debezium.items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price      numeric(12, 2) NOT NULL CHECK (price >= 0),
  type       text NOT NULL,
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Unlike the Publisher pipeline, Debezium requires the sequence to be allocated
inside the entity transaction because the event is complete before logical
decoding reads it. The schema therefore contains one sequence row per entity
type:

```sql
CREATE TABLE benchmark_debezium.entity_type_sequence (
  entity_type text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0)
);

INSERT INTO benchmark_debezium.entity_type_sequence (entity_type, seq)
VALUES ('items', 0);
```

Each entity type also needs a Debezium outbox table with the column names
expected by the Outbox Event Router:

```sql
CREATE TABLE benchmark_debezium.items_outbox (
  id            uuid PRIMARY KEY,
  aggregatetype text NOT NULL,
  aggregateid   text NOT NULL,
  payload       jsonb NOT NULL
);
```

The required functions and triggers are installed by
`infra/postgres/init/06-debezium-sync.sql`:

| Object | Responsibility |
| --- | --- |
| `benchmark_debezium.validate_entity_sequence()` | Requires a positive source sequence and rejects non-increasing updates |
| `benchmark_debezium.capture_entity_change()` | Locks and increments the entity's sequence row, builds the diff, inserts the complete outbox event, then deletes that outbox row in the same transaction |
| `public.build_entity_changes(old, new)` | Shared diff helper; excludes `id`, `sequence`, and `updated_at` |

Every source table needs these two triggers:

```sql
CREATE TRIGGER atlas_validate_sequence
BEFORE INSERT OR UPDATE ON benchmark_debezium.items
FOR EACH ROW
EXECUTE FUNCTION benchmark_debezium.validate_entity_sequence();

CREATE TRIGGER atlas_sync_change
AFTER INSERT OR UPDATE OR DELETE ON benchmark_debezium.items
FOR EACH ROW
EXECUTE FUNCTION benchmark_debezium.capture_entity_change(
  'items',
  'benchmark_debezium.items_outbox'
);
```

The insert followed by delete keeps the outbox table empty in normal operation,
but both changes remain visible in WAL. Debezium routes the `INSERT` event and
uses its `payload`; the delete is not a second business event.

All outbox tables must belong to the publication used by the connector:

```sql
CREATE PUBLICATION benchmark_debezium_outbox FOR TABLE
  benchmark_debezium.customers_outbox,
  benchmark_debezium.items_outbox,
  benchmark_debezium.orders_outbox,
  benchmark_debezium.distributors_outbox;
```

The `debezium` database role needs `LOGIN REPLICATION`, schema usage, and
`SELECT` on every outbox table. It also needs access to its durable offset
table:

```sql
CREATE TABLE benchmark_debezium.debezium_offsets (
  id text PRIMARY KEY,
  offset_key text,
  offset_val text,
  record_insert_ts timestamp NOT NULL,
  record_insert_seq integer NOT NULL
);
```

When adding another entity type, all of the following must be updated together:

1. Create the entity table and its outbox table.
2. Insert its `entity_type_sequence` row.
3. Attach both triggers.
4. Add the outbox table to the PostgreSQL publication.
5. Add it to `debezium.source.table.include.list`.

## Debezium routing configuration

The relevant connector settings are:

```properties
debezium.source.plugin.name=pgoutput
debezium.source.publication.name=benchmark_debezium_outbox
debezium.source.publication.autocreate.mode=disabled
debezium.transforms=outbox
debezium.transforms.outbox.type=io.debezium.transforms.outbox.EventRouter
debezium.transforms.outbox.route.by.field=aggregatetype
debezium.transforms.outbox.route.topic.replacement=changes:$$$${routedByValue}
debezium.transforms.outbox.table.field.event.key=aggregateid
debezium.transforms.outbox.table.field.event.payload=payload
debezium.transforms.outbox.table.expand.json.payload=true
```

`aggregatetype = 'items'` is therefore written to `changes:items`. Offsets are
stored in PostgreSQL rather than Redis so a total Redis loss does not also lose
the connector's WAL position.

## Redis event format

Debezium writes the same consumer contract as the Publisher pipeline. A Redis
entry has the generated Stream ID and a field named `value` containing the
JSON payload:

```text
XADD changes:items * value <JSON payload>
```

Example update:

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

Example delete:

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

On insert, `changes.old` is empty and `changes.new` contains every business
field. On update, only changed business fields appear. Deletes contain neither
`sequence` nor `changes`. The authoritative contract is
`packages/protocol/schema/outbox-event.v3.json`.

## Local operation

Start only the Debezium relay when testing this pipeline because Publisher and
Debezium intentionally share the same Redis Stream names:

```powershell
npm run benchmark:debezium:start
npm run replicator:watch
npm run replicator:simulate:debezium
```

Stop it with:

```powershell
npm run benchmark:debezium:stop
```
