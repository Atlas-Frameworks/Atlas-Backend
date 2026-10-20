# @atlas/client-sdk

Framework-free browser SDK for the Atlas realtime view service. It runs in a dedicated Web Worker
(or on the main thread in tests) and owns the WebSocket connections, the protocol, sequence checks,
reconnects, the typed-array map store, live pages and detail subscriptions. It must not import
Angular, React, Cesium, deck.gl or MapLibre (oxlint rule plus `src/no-framework-imports.spec.ts`).

Specs: [docs/tasks/boaz/06-client-sdk.md](../../docs/tasks/boaz/06-client-sdk.md). Protocol:
[contracts.md §3](../../docs/contracts.md) and `@atlas/protocol`.

| Folder | Task | What |
| --- | --- | --- |
| `src/core/` | C-01 | `Transport` (WebSocket, in-memory), `ServiceSession`, `Subscription` state machine, `AtlasCore` |
| `src/map-store/` | C-02 | `MapLayerStore` (typed arrays, stable slots), `FrameBuilder` (buffer rotation), `LabelSelector`, `FrameScheduler` |
| `src/adapters/` | C-05 | `MapFrame`, `MapAdapter`, `LayerStyle` (contracts §7) |
| `src/testing/` | C-01 | `FakeClock`, `seededRandom`, `ScriptedServer`, map fixtures (`@atlas/client-sdk/testing`) |

## Core rules (C-01)

- One `ServiceSession` per service URL; `services` in the config maps entity types to URLs (`'*'` is
  the fallback).
- Connect, then `Auth`, then every view (`OpenView`, `SetLayout`, `SubscribeMap`, `SetWindow`) and
  detail (`OpenDetail`) is (re-)sent. This replay runs after every reconnect.
- Reconnect: full-jitter exponential backoff, ceiling 1 s doubling to 30 s (`delay = random() *
  ceiling`). A connection that received a frame or stayed open 5 s resets it. A server `Reconnect
  {afterMs}` makes the client move by itself after `afterMs` (or reconnect at that time if the server
  closes first), with no backoff.
- Subscription states: `pending → snapshot-wait → live → stale → resyncing`. A frame is applied only
  if `seq == last + 1`; a gap sends `Resync` (again every 10 s until a snapshot arrives) and marks
  the subscription stale. Duplicates (`seq <= last`) are ignored.
- Listen first: frames whose `sub_id` no snapshot has bound yet are buffered; when the snapshot
  arrives, frames it covers (`seq <= snapshot.seq`) are dropped and the rest applied in order.
- Hidden tab: frames stop; on return every live subscription is re-snapshotted (`Resync`) and its
  old data is shown as stale until the snapshot arrives.

## Map store (C-02)

- One `MapLayerStore` per map subscription: `positions: Float64Array` (lon, lat, alt per slot),
  `icons: Uint16Array`, `visible: Uint8Array`, labels by slot, and the id ↔ slot table. Capacity
  doubles when full. Applying a delta allocates nothing per entity.
- A removed entity's slot is hidden at once but reused only after the next frame has been sent, so
  a pick against the frame on screen never returns a wrong id. A snapshot keeps the slots of
  entities that are still present.
- `FrameBuilder` copies the store into one of up to 3 buffer sets per layer, which are transferred
  to the main thread and handed back after rendering. When all 3 are out, no frame is built until
  one returns (backpressure, no allocation). Ids cross the boundary as changes only; the main side
  (`MapFrameAssembler`) keeps the slot → id table and builds the contracts §7 `MapFrame`.
- `FrameScheduler` emits a frame only when data (or the label subset) changed, at most 10 per second
  per layer by default, and never while the tab is hidden.
- Labels: the selected entity, plus the entities nearest the camera point when the camera is below
  2,000 km, at most 500 per frame (a fixed-size heap, no allocation).
- **Smooth motion: none in the POC.** Frames carry positions only, no speed or timestamp, and
  adapters draw the latest position. With updates every 5–10 s points jump; if that proves a
  problem, add `velocity: Float32Array` (east, north m/s) and a frame timestamp to `FrameBuffers`
  and let the adapter extrapolate between frames (coordinate with C-05).

Benchmark (`npm run bench -w @atlas/client-sdk`, Node 24, Apple Silicon laptop):

| Measure | Target | Result |
| --- | --- | --- |
| Apply a delta of 5,000 changed positions into a 30,000-entity store | < 2 ms | p50 0.72 ms, p95 1.03 ms |
| Build a 30,000-entity frame (500 labels) | < 1 ms | p50 0.45 ms, p95 0.52 ms |
| Heap growth per frame (GC-free windows) | no new buffers | ~520 B (the small frame object; buffers ≈ 1 MB are reused) |
