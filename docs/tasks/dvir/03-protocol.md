# 03 · Protocol and contracts

Turns [contracts.md](../../contracts.md) §1, §3 and §4 into code that every component imports from `@atlas/protocol`.

---

## P-01 · Protobuf schemas and code generation

- **Depends on:** nothing
- **Size:** M
- **Plan sections:** "Client protocol and subscriptions", "Pagination and live updates", "Multi-pod deployment"
- **Files:** `packages/protocol/proto/**`, `packages/protocol/buf.yaml`, `buf.gen.yaml`, `src/index.ts`

**Goal.** One schema, generated into TypeScript for the browser SDK, the view-service and worker-to-worker gRPC.

**Deliverables**

1. **`proto/atlas/client/v1/client.proto`:** every message in contracts §3.
   - Top-level wrappers `ClientMessage { oneof body }` and `ServerMessage { oneof body }`, so one WebSocket frame = one wrapper.
   - Map positions as `bytes positions` (little-endian float64 lon, lat, alt per entity) and `bytes icons` (uint16), so the client decodes straight into typed arrays.
   - `PageWindow` with `repeated string ordered_ids`, `repeated Row rows`, totals and group counts.
   - A `Row` holds the entity's display fields as `google.protobuf.Struct`, or a typed message per entity type. Decide which, and record the decision in the README.
2. **`proto/atlas/cluster/v1/view_owner.proto`:** the gRPC service in contracts §4. `payload` is a `bytes` field carrying an encoded `ServerMessage`, so workers forward without re-encoding.
3. **Code generation:**
   - `buf` + `@bufbuild/protoc-gen-es` (protobuf-es v2) for messages;
   - for gRPC in Node, use `@connectrpc/connect-node` with gRPC protocol, or `@grpc/grpc-js` with protobuf-es serializers. Pick one and document why.
   - Script `npm run generate -w @atlas/protocol`, run automatically before `build`.
   - Generated code goes to `src/gen/` (gitignored).
4. **Helpers in `src/`:**
   - `encodeServer(msg)` / `decodeServer(bytes)` / `encodeClient` / `decodeClient`;
   - `packPositions(Float64Array) → Uint8Array` and its inverse without copying where possible;
   - `PROTOCOL_VERSION`.
5. **Tests:**
   - round-trip every message type;
   - pack/unpack positions for 30,000 entities in under 5 ms on a laptop.

**Acceptance criteria**

- [ ] `npm run build -w @atlas/protocol` generates and compiles from a clean clone with no global tools; `buf` comes in as an npm dependency (`@bufbuild/buf`).
- [ ] The browser bundle of `@atlas/protocol` works under a strict Content Security Policy (no `eval` or `new Function`). protobuf-es satisfies this.
- [ ] README updated with the schema rules (never renumber fields, the source-sequence policy).

---

## P-02 · Outbox event JSON schema and validator

- **Depends on:** nothing
- **Size:** S
- **Files:** `packages/protocol/schema/outbox-event.v3.json`, `packages/protocol/src/outbox.ts`

**Goal.** The replicator writes, and the workers read, exactly the event shape in contracts §1.

**Deliverables**

1. JSON Schema (draft 2020-12) for the payload in contracts §1.
2. TypeScript types `OutboxEvent`, `OutboxOp`, `EntityChanges`.
3. Functions:
   - `parseOutboxEvent(raw: string | object): Result<OutboxEvent>`, a fast validator compiled with ajv at build time or hand-written. Workers call it for every event, so it must handle 50,000 events/s on one core;
   - `buildOutboxEvent(...)`, used by the replicator.
4. **The Redis stream entry shape** produced by Debezium, confirmed in I-03 (field name, whether the value is a JSON string), and a function `parseStreamEntry(fields: string[])` that returns an `OutboxEvent`.
5. Tests with valid and invalid examples, plus a micro-benchmark.

**Acceptance criteria**

- [ ] Rejects a missing `typeSeq` or `op`, a missing `sequence` on upsert, a `sequence` on delete, and an unknown `schema` version.
- [ ] Benchmark result recorded in the PR.
