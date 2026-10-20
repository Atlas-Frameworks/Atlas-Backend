# Contracts between components

These are the interfaces every task builds against, so tasks can be implemented in parallel.
**Change a contract only in its own PR**, tagged `contract-change`, and update every task that mentions it.
The full design and its reasoning are in [architecture-plan.md](architecture-plan.md).

## 1. Outbox event payload (replicator → outbox → Debezium → Redis)

Written by the replicator (task W-02) in the same transaction as the entity change. Debezium's Outbox Event Router copies `payload` into the stream entry `changes:<aggregatetype>`. JSON schema file: `packages/protocol/schema/outbox-event.v1.json` (task P-02).

```json
{
  "schema": 1,
  "type": "airplanes",
  "id": "7f1c2a9e-...-uuid",
  "op": "upsert",
  "version": 42,
  "typeSeq": 918273,
  "committedAt": "2026-10-20T10:15:03.123Z",
  "map": { "lat": 32.01, "lon": 34.88, "alt": 11200, "heading": 271.5, "icon": 3, "label": "LY001" },
  "routing": {
    "old": { "country_id": "uuid-A", "airport_id": "uuid-X" },
    "new": { "country_id": "uuid-A", "airport_id": "uuid-Y" }
  },
  "affectedRoots": null
}
```

| Field | Meaning |
| --- | --- |
| `op` | `upsert` or `delete`. A delete carries the last known `routing.old` and `routing.new` (equal). |
| `version` | Root entity version, incremented on any change to the entity or its child rows. Consumers ignore versions they already applied. |
| `typeSeq` | Gapless, commit-ordered sequence per entity type (from `entity_type_sequence`). A gap means a lost event: reload that type's views. |
| `map` | Render fields only, so workers never read Postgres for map updates. `null` for types not shown on the map. |
| `routing` | Old and new values of the fields that decide view membership (declared per type in the field registry). |
| `affectedRoots` | For related entities (airport, country, connection): the root entities whose views must be re-checked, e.g. `{ "airplanes": ["uuid", ...] }`. `null` when not applicable. Optional optimization; the registry links are the fallback. |

## 2. Redis keys

Every key is prefixed with the service name (`<svc>`, e.g. `tracks`) except streams, which are shared by all services.

| Key | Type | Written by | Purpose |
| --- | --- | --- | --- |
| `changes:<entityType>` | Stream | Debezium | Change events. Field `value` holds the JSON payload above. |
| `<svc>:workers:<workerName>` | String, 10 s TTL | each worker | Membership entry: `{"name","address","grpcPort","startedAt"}`. Renewed every 3 s. |
| `<svc>:workers:epoch` | Integer | any worker on join/leave | Membership epoch, incremented with `INCR`. |
| `<svc>:workers:changes` | Pub/Sub channel | any worker | "Re-read the list now" notice carrying the new epoch. |
| `<svc>:access` | Stream | replicator (later: auth system) | Access changes: `{userId, countries?, connectionId?, revoked: true}`. |
| `trim-lock:<entityType>` | String, 90 s TTL | trimmer | Designated trimmer for that stream (`SET NX PX`). |

## 3. Client ↔ worker protocol (WebSocket, binary Protobuf)

Schema: `packages/protocol/proto/atlas/client/v1/` (task P-01). One WebSocket per service. Every server → client frame carries `subId` and `seq`; the client applies a frame only if `seq == last + 1`, otherwise it sends `Resync`.

| Direction | Message | Key fields |
| --- | --- | --- |
| C → S | `Auth` | `token`, `protocolVersion` |
| C → S | `OpenView` / `CloseView` | `viewRef` (client-chosen id), `entityType`, `filter` (JSON filter tree, see §5), `scope` (`countries[]` or `connectionId`) |
| C → S | `SetLayout` | `viewRef`, `groupBy[]`, `sort {field, dir}` |
| C → S | `SubscribeMap` / `UnsubscribeMap` | `viewRef` |
| C → S | `SetWindow` | `viewRef`, `groupPath[]`, `page`, `pageSize` |
| C → S | `OpenDetail` / `CloseDetail` | `entityType`, `id` |
| C → S | `Locate` | `viewRef`, `id` → server replies with the page number |
| C → S | `Resync` | `subId` |
| S → C | `Snapshot` | `subId`, `seq`, full state of one subscription |
| S → C | `MapDelta` | `subId`, `seq`, `upsertIds[]`, `positions` (packed `bytes`, float64 lon/lat/alt per entity), `icons` (packed uint16), `removeIds[]`, labels for changed ids |
| S → C | `PageWindow` | `subId`, `seq`, `orderedIds[]` (the whole page), `rows[]` (only new or changed rows), `total`, `pageCount`, `groupCounts[]` |
| S → C | `DetailUpdate` | `subId`, `seq`, `row` or `removed: true` |
| S → C | `Reconnect` | `afterMs` (random 0–15 000), sent before a planned shutdown |
| S → C | `Error` | `code` (`INVALID_FILTER`, `LIMIT`, `AUTH`, `RETRY`), `message`, optional `subId` |

## 4. Worker ↔ worker (gRPC)

Schema: `packages/protocol/proto/atlas/cluster/v1/view_owner.proto` (task P-01). Mutual TLS in OpenShift; plaintext allowed locally.

```proto
service ViewOwner {
  // One bidirectional stream per subscriber-worker → owner-worker pair.
  rpc Subscribe(stream OwnerRequest) returns (stream OwnerEvent);
}
// OwnerRequest: Hello{workerName, epoch} | Sub{subKey, viewKey, kind: MAP|PAGE|DETAIL, pageSpec?} | Unsub{subKey}
// OwnerEvent:   Snapshot{subKey, seq, epoch, payload} | Delta{subKey, seq, epoch, payload} | NotOwner{subKey, epoch}
```

`payload` reuses the client messages (`MapDelta`, `PageWindow`, `DetailUpdate`), so the subscribing worker can forward bytes to its clients without re-encoding.

## 5. Filter tree (client → server)

```json
{ "and": [
  { "field": "airline", "op": "eq", "value": "LY" },
  { "field": "airport.runwayCount", "op": "gte", "value": 3 },
  { "or": [ { "field": "callsign", "op": "contains", "value": "LY0" },
            { "field": "aircraftKind", "op": "in", "value": ["B738", "B789"] } ] }
] }
```

Operators: `eq`, `neq`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `between`, `contains` (min 3 characters, trigram index), `isNull`, `notNull`. Limits: depth ≤ 4, ≤ 20 conditions, `in` ≤ 200 values. Only fields declared in the field registry are allowed.

## 6. View-engine public API (`@atlas/view-engine`, tasks E-01 to E-06)

Pure TypeScript, no I/O. The view-service (tasks S-*) wires it to Postgres, Redis and sockets.

```ts
// E-01 registry
export interface FieldDef {
  name: string;                     // e.g. "airport.runwayCount"
  sql: string;                      // SQL expression using table aliases, e.g. "jsonb_array_length(ap.details->'runways')"
  type: 'string' | 'number' | 'boolean' | 'uuid' | 'timestamp';
  ops: FilterOp[];
  join?: string;                    // join key from the registry's join table, e.g. "airport"
  groupable?: boolean;
  sortable?: boolean;
}
export interface EntityTypeDef {
  type: string;                     // "airplanes"
  table: string;                    // "airplanes"
  alias: string;                    // "a"
  joins: Record<string, JoinDef>;   // e.g. airport: { sql: "LEFT JOIN airports ap ON ap.id = a.airport_id", relatedType: "airports", link: { column: "airport_id", relatedColumn: "id" } }
  fields: FieldDef[];
  scope: ScopeDef;                  // how countries / connection restrict this type
  routingFields: string[];          // fields copied into outbox routing, e.g. ["country_id", "airport_id"]
  mapFields?: string[];             // fields in the map shape
}
export function defineRegistry(types: EntityTypeDef[]): Registry;
export function validateFilter(reg: Registry, type: string, tree: unknown): Result<FilterTree, FilterError>;
export function viewKey(type: string, scope: Scope, tree: FilterTree): string;   // stable hash of the normalized query

// E-02 compiler
export function compileFullQuery(reg, view: ViewDef, opts: { layout?: Layout }): SqlStatement;
export function compileRecheckBatch(reg, type: string, views: ViewDef[]): SqlStatement;   // WHERE id = ANY($1), one boolean column per view
export function compileRowFetch(reg, type: string, kind: 'page' | 'detail'): SqlStatement;

// E-03 dependencies
export class DependencyIndex { add(view: ViewDef): void; remove(viewKey: string): void; candidates(evt: ChangeEvent): string[]; }

// E-04 store
export class ViewStore { applyFull(rows: RecheckRow[]): Diff; applyRecheck(rows: RecheckRow[], ids: string[]): Diff; window(groupPath: string[], page: number, size: number): PageWindow; counts(): GroupCount[]; entitiesHeld(): number; }

// E-05 tick
export class TickBatcher { push(evt: ChangeEvent): void; drain(): TickBatch; markInFlight(viewKey: string, ids: string[]): void; }
export class SequenceTracker { observe(type: string, typeSeq: number): 'ok' | 'gap' | 'duplicate'; }

// E-06 cluster
export function ownerOf(viewKey: string, workers: string[]): string;     // rendezvous hashing
export class Membership { /* epoch, flap damping, eligible workers */ }
```

## 7. Map adapter (client, task C-05)

```ts
export interface MapFrame {
  layerId: string;
  count: number;
  ids: string[];                 // slot -> entity id (stable slots)
  positions: Float64Array;       // lon, lat, alt per slot
  icons: Uint16Array;
  visible: Uint8Array;
  labels: Map<number, string>;   // slot -> label, only for the labelled subset
}
export interface MapAdapter {
  createLayer(layerId: string, style: LayerStyle): void;
  applyFrame(frame: MapFrame): void;
  pick(screenX: number, screenY: number): string | null;   // entity id
  destroy(): void;
}
```

## 8. Metrics (all workers, prom-client)

`atlas_commit_to_send_seconds` (histogram), `atlas_tick_duration_seconds`, `atlas_views_owned`, `atlas_entities_held`, `atlas_build_queue_length`, `atlas_stream_lag_seconds{type}`, `atlas_sequence_gaps_total{type}`, `atlas_reconcile_mismatches_total`, `atlas_sampler_mismatches_total`, `atlas_replica_wait_seconds`, `atlas_ownership_moves_total`, `atlas_ws_connections`, `atlas_ws_buffered_bytes`, `atlas_backpressure_drops_total`, `atlas_event_loop_delay_seconds`.
