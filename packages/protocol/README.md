# @atlas/protocol

The single source of truth for every message that crosses a process boundary:

| Schema | Between | Owner task |
| --- | --- | --- |
| `proto/atlas/client/v1/*.proto` | Browser SDK ↔ view-service worker (WebSocket, binary frames) | P-01 |
| `proto/atlas/cluster/v1/*.proto` | Worker ↔ worker (gRPC) | P-01 |
| `schema/outbox-event.v1.json` | Replicator → outbox → Debezium → Redis stream payload | P-02 |

Generated TypeScript (protobuf-es) is written to `src/gen/` and is not committed.
Run `npm run generate -w @atlas/protocol` after changing a `.proto` file.

Rules:

- Never reuse or renumber a field. Add new fields; deprecate old ones.
- Bump `PROTOCOL_VERSION` in `src/index.ts` for breaking changes. Every component accepts the current and the previous version.
- Positions on the map are packed into `bytes` fields so the client decodes them straight into typed arrays.

## Protobuf schemas (P-01)

### Layout and entry points

| Path | What |
| --- | --- |
| `proto/atlas/client/v1/client.proto` | Browser ↔ worker frames (contracts §3): `ClientMessage` and `ServerMessage` wrappers, one WebSocket frame = one wrapper |
| `proto/atlas/cluster/v1/view_owner.proto` | `service ViewOwner { rpc Subscribe(stream OwnerRequest) returns (stream OwnerEvent); }` (contracts §4) |
| `buf.yaml`, `buf.gen.yaml` | `buf lint` (STANDARD) / `buf breaking` (FILE) rules; generation with the local `protoc-gen-es` plugin (protobuf-es v2, `target=ts`) |
| `src/codec.ts` | `encodeServer` / `decodeServer` / `encodeClient` / `decodeClient`, `bindSnapshot` |
| `src/positions.ts` | `packPositions` / `unpackPositions`, `packIcons` / `unpackIcons` |
| `src/cluster.ts` | the `@atlas/protocol/cluster` entry point |

```ts
// Browser SDK, view-service: client protocol (browser-safe, no Node imports).
import { decodeServer, encodeClient, unpackPositions, PROTOCOL_VERSION } from '@atlas/protocol';
// View-service only: worker <-> worker gRPC schema.
import { ViewOwner, OwnerEventSchema } from '@atlas/protocol/cluster';
```

The cluster schema is a separate subpath export, so a browser bundle of `@atlas/protocol` never contains
it. `src/bundle.spec.ts` bundles the browser entry with esbuild and checks this. The generated file also
exports a message called `Error`. Import it under another name (`import type { Error as ErrorFrame }`) so it
does not shadow the global.

### Code generation

- `npm run generate -w @atlas/protocol` runs `buf generate` and writes `src/gen/`. That folder is
  gitignored, and prettier and oxlint skip it. buf (`@bufbuild/buf`) and the plugin
  (`@bufbuild/protoc-gen-es`) are npm devDependencies, so nothing has to be installed globally and nothing
  is downloaded at generate time.
- The package's `prebuild`, `pretypecheck`, `pretest` and `prelint` scripts run `generate`, so
  `npm run <script> -w @atlas/protocol` works from a clean clone. The root `npm run build|typecheck|test|lint`
  also generate first, because other workspaces resolve `@atlas/protocol` to its sources (the
  `@atlas/source` condition) and may run before this package.
- `@bufbuild/buf` has a `postinstall` script. It only checks the platform binary and, if that is missing,
  downloads it. The binary already arrives as an optional dependency (`@bufbuild/buf-<os>-<arch>`, all of
  them pinned in `package-lock.json`, including linux-x64 for CI), so root `allowScripts` sets
  `"@bufbuild/buf": false`.
- `npm run lint -w @atlas/protocol` runs `buf lint` before oxlint. Four STANDARD rules are switched off
  because contracts §4 fixes the names `ViewOwner`, `OwnerRequest` and `OwnerEvent`.
- `npm run breaking -w @atlas/protocol` compares the schema with `main`
  (`buf breaking --against ../../.git#branch=main,subdir=packages/protocol`). It only works once `main`
  contains these `.proto` files. To run it in CI, check out with `fetch-depth: 0` (or fetch `main`) and add
  `npm run breaking -w @atlas/protocol` on pull requests.

### Schema rules

These refine the short rules above.

1. **Never renumber or reuse a field number or enum value.** When you remove a field, add its number
   *and* name to `reserved`.
2. **Only additive changes inside `v1`:** new fields, new messages, new oneof cases, new enum values.
   Old readers skip unknown fields, and protobuf-es keeps them. Never change a field's type, label or
   meaning. `buf breaking` (rule set `FILE`) enforces this against `main`.
3. **`PROTOCOL_VERSION` policy** (`src/index.ts`, sent in `Auth.protocol_version`). Every component
   accepts the current version and the one before it (`PROTOCOL_VERSION` and `PROTOCOL_VERSION - 1`) and
   rejects anything else with `Error{code: AUTH}`. Bump the version when an additive change still alters
   behaviour that a peer must know about. Within the two-version window, a server serves each client
   according to the version it sent.
4. **A breaking change gets a new major version:** a new package and path, `atlas.client.v2` in
   `proto/atlas/client/v2/` (and likewise for `cluster`). Workers serve v1 and v2 side by side for at least
   one release, so a rolling deploy never strands old clients or workers.
5. Field names are `snake_case` in `.proto`, and protobuf-es generates `camelCase`. Enum values carry the
   enum's name as a prefix (`ERROR_CODE_AUTH`); the TypeScript enum drops it (`ErrorCode.AUTH`). Value 0 is
   always `*_UNSPECIFIED`.
6. Hot-path counters (`seq`, `epoch`) are `uint32`, so TypeScript sees a `number`. protobuf-es maps 64-bit
   integers to `bigint` and does not honour `jstype = JS_NUMBER`. Widening to `uint64` later is
   wire-compatible.

### Message notes

- **`sub_id` and `seq` are on the `ServerMessage` wrapper,** so every server frame carries them.
  Subscription frames (`snapshot`, `map_delta`, `page_window`, `detail_update`) have a non-empty `sub_id`.
  The client applies one only if `seq == last + 1`, and a `Snapshot` resets the baseline. Connection-level
  frames (`locate_result`, `reconnect`, and an `error` that is not about a subscription) have `sub_id = ""`
  and `seq = 0` and are never sequence-checked. The optional subscription of an `Error` (contracts §3) is the
  wrapper's `sub_id`.
- **The server chooses `sub_id`,** and it is the same for every client of one shared subscription: one
  view's map, one page of one group, or one detail. A delta is therefore encoded once, published to every
  socket on the topic, and forwarded between workers as bytes. `cluster.v1.Sub.sub_key` equals this
  `sub_id`.
- **The `Snapshot` binding:** `Snapshot.view_ref` and `window_ref` tie a snapshot back to the client's
  `SubscribeMap` or `SetWindow`. Owner-produced snapshot payloads leave them empty. The forwarding worker
  calls `bindSnapshot(payload, {viewRef, windowRef})`, which appends a few bytes; protobuf merges the
  repeated message, so nothing is decoded or re-encoded.
- **`SetWindow.window_ref`** is chosen by the client (for example `"main"` or `"prefetch"`). It lets one
  view hold several windows, as with prefetch or several expanded groups. `page_size = 0` closes the
  window. `Locate` is answered by `LocateResult{found, group_path, page}`. `PageWindow.page` is the page
  actually served, which can be lower than the one requested when the list shrank.
- **`MapDelta`:**
  - `positions` holds little-endian float64 `lon, lat, alt` per `upsert_ids` entry (24 bytes each), and
    `icons` holds little-endian uint16 per entry;
  - `labels` is either empty or parallel to `upsert_ids`;
  - a map `Snapshot` uses the same message, with every entity listed as an upsert.
- **`Error.view_ref`** says which `OpenView` an error answers, because at that point no `sub_id` exists yet.
- **`cluster.v1.Sub` carries a full `ViewSpec`** (entity type, filter, scope, layout), so the owner can
  build the view from the request alone. `Sub` and `Unsub` also carry the `epoch`. `OwnerSnapshot` and
  `OwnerDelta` repeat the payload's `seq`, so the subscriber can drop deltas already covered by a
  snapshot without decoding them.

### Decisions

**`Row.fields` is a `google.protobuf.Struct`, not a typed message per entity type.**

- The field registry (E-01) decides at runtime which display fields an entity type has, and every
  service is the same engine plus configuration. Typed messages would need a `.proto` change, a
  regeneration and a client release for every new display field or entity type, and they would couple
  this shared package to each service's domain.
- protobuf-es v2 maps `Struct` to a plain `JsonObject`, so the client reads `row.fields.callsign` with no
  conversion.
- The costs: field names travel with every row, and numbers are float64. Both are acceptable, because
  rows go only to open pages and details (at most a page size per tick, and only new or changed rows),
  never to the 30,000-entity map, whose hot data is packed into `bytes`.
- Conventions: int64 values and uuids are strings, timestamps are ISO-8601 strings, and SQL `NULL` is
  `null`. `Row.id` and `Row.version` sit outside the Struct.

**`OpenView.filter` (and `ViewSpec.filter`) is the filter tree of contracts §5 as JSON text (`string`), not
a `google.protobuf.Value`.**

- The contract defines the filter as JSON, and the view-engine takes `validateFilter(reg, type, tree:
  unknown)`, so the server calls `JSON.parse` and hands the result over.
- The server can reject an oversized filter by byte length before parsing anything.
- `Value` would add nested wrappers (larger on the wire, more allocations to decode) and give nothing in
  return, because the tree is validated against the registry anyway.
- A filter is sent once per `OpenView`, so bandwidth does not matter.

**Node gRPC: `@connectrpc/connect-node` (gRPC protocol over HTTP/2), not `@grpc/grpc-js`.**

- It works directly with the protobuf-es v2 descriptors that `protoc-gen-es` already generates (`ViewOwner`
  is a `GenService`). That means one code generator, one message runtime, and no hand-written serializers.
  grpc-js would need serializer glue for every method, or a second generator.
- Bidirectional streaming works over Node's own `http2` module. Mutual TLS is plain Node TLS options:
  `http2.createSecureServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true })` on the
  owner, and `createGrpcTransport({ baseUrl: 'https://…', nodeOptions: { ca, key, cert } })` on the
  subscriber. Plaintext uses `http2.createServer` with `http://`.
- Explicit keepalives (S-07: 10 s ping, 5 s timeout) are transport options:
  `pingIntervalMs: 10_000, pingTimeoutMs: 5_000`.
- `src/cluster.spec.ts` runs a real `ViewOwner` server and client in three cases: plaintext; mutual TLS
  with throwaway openssl certificates; and mutual TLS with a client that has no certificate, which is
  rejected.
- The trade-off: grpc-js has more knobs on the server side (for example a minimum ping interval it will
  accept, and channelz). Connect speaks the standard gRPC protocol, so it can switch to grpc-js later
  without changing the schema.
- This package holds only the runtime-neutral descriptors (`@atlas/protocol/cluster`).
  `@connectrpc/connect` and `@connectrpc/connect-node` are devDependencies here, for the test only. The
  view-service (S-07) adds them as its own dependencies.

**Map positions are packed `bytes`, not `repeated double`.**

- On little-endian hosts (all supported browsers and Node platforms), `packPositions` is a zero-copy view.
- `unpackPositions` is zero-copy when the bytes are 8-byte aligned. Bytes decoded from a frame are a
  subarray at an arbitrary offset, so it usually copies once. That copy takes about 0.04 ms for 30,000
  entities.
- Endianness is checked once (`HOST_IS_LITTLE_ENDIAN`). A big-endian host falls back to `DataView`
  (`src/positions-portable.ts`).
