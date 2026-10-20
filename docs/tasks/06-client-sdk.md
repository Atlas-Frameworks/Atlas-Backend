# 06 · Client SDK (`packages/client-sdk`)

A framework-free TypeScript SDK that runs in a dedicated Web Worker. It must not import Angular, React, Cesium, deck.gl or MapLibre, which keeps the app free to switch frameworks and map libraries.

Plan section: "Client architecture". Contracts: §3 (protocol), §7 (MapAdapter).

Design rules for every task here:

- **Inject the clock, the random source and the transport,** so everything is testable deterministically in Node.
- **Per-tick map data never becomes JS objects per entity.** Typed arrays only.
- **The SDK core runs in a dedicated Worker by default.** Keep it behind an interface so it can also run on the main thread (tests) or in a SharedWorker later.

---

## C-01 · SDK core: transport, protocol, sequence, reconnect

- **Depends on:** P-01 (use C-07's mock server, or build both together)
- **Size:** L
- **Folder:** `src/core/`

**Goal.** Reliable sessions with each view service: always either in sync or knowingly stale and recovering.

**Deliverables**

1. **`Transport` interface** (`send`, `onMessage`, `onClose`), with two implementations: browser WebSocket, and an in-memory one for tests.
2. **`ServiceSession`, one per service URL:**
   - connect, then `Auth`;
   - jittered exponential reconnect: 1 s doubling to 30 s, full jitter, or the server's `Reconnect.afterMs`;
   - re-open every subscription after reconnect.
3. **`Subscription` state machine:**
   - states `pending → snapshot-wait → live → stale → resyncing`;
   - applies a frame only if `seq == last + 1`, otherwise sends `Resync` and marks stale;
   - **listen first:** deltas that arrive before the snapshot are buffered, then those covered by the snapshot are dropped.
4. **Routing:** config maps each entity type to its service URL (S-10). `openView({entityType, filter, scope})` picks the session.
5. **Hidden tabs:** on `visibilitychange` to hidden, stop emitting frames and keep only the latest state. On visible: re-snapshot every subscription and keep showing the old data marked stale until fresh data arrives.
6. **Status stream:** connection state, `staleSince` per subscription, last error.

**Acceptance criteria**

- [ ] Deterministic tests (fake clock and transport):
  - a gap triggers `Resync`;
  - reconnect re-opens all subscriptions;
  - a delta before the snapshot is handled correctly;
  - the server's `Reconnect` hint is respected;
  - backoff caps at 30 s with jitter.
- [ ] No Angular, React or map imports (enforced by a lint rule or a test that scans imports).

---

## C-02 · Map data store and frame scheduling

- **Depends on:** C-01
- **Size:** M
- **Folder:** `src/map-store/`

**Goal.** Hold up to 30,000 entities per layer in typed arrays and hand the main thread render-ready frames cheaply.

**Deliverables**

1. **Per map subscription:**
   - stable slot allocation (entity id ↔ slot);
   - `positions: Float64Array` (lon, lat, alt), `icons: Uint16Array`, `visible: Uint8Array`, labels map;
   - grows by doubling.
   - A freed slot is reused only after the next frame has been sent, so picking never returns a wrong id.
2. **Apply `MapDelta`:** unpack `positions` bytes straight into the arrays (P-01 helpers) and apply removals.
3. **Frame scheduler:**
   - emits a `MapFrame` (contracts §7) only when data changed, at most 10 per second (configurable);
   - **buffer rotation:** 2–3 buffers per layer are transferred to the main thread and returned after rendering, so nothing is allocated per frame.
4. **Label selection:** only a subset gets labels (selected entity, ≤ N nearest to a supplied camera point, or a zoom threshold), at most 500 by default.
5. **Smooth motion decision:** document whether frames include speed and timestamp for interpolation (coordinate with C-05). Default: no interpolation in the POC.

**Acceptance criteria**

- [ ] Benchmark in Node: applying a delta of 5,000 changed positions into a 30,000-entity store takes < 2 ms; building a frame takes < 1 ms with no new allocations (check with `--trace-gc` or heap stats).
- [ ] Picking test: slot → id mapping stays valid across removals and reuse.

---

## C-03 · Pages, detail and locate

- **Depends on:** C-01
- **Size:** M
- **Folder:** `src/pages/`

**Goal.** Live server-side pages and detail screens that are simple to render and never show torn data.

**Deliverables**

1. **`subscribePage(viewRef, {groupPath, page, pageSize})`:**
   - applies `PageWindow`: rebuilds the page from `orderedIds` plus a row cache keyed by entity id, replacing rows present in `rows`;
   - exposes `{rows, total, pageCount, groupCounts, stale}`;
   - evicts rows that are no longer on any open page.
2. **Prefetch option:** also subscribe to the next page.
3. **Reorder damping:** an option `freezeOrder: boolean`. While true (the UI sets it while the user hovers or scrolls), keep the old order, update row data in place, and report `pendingReorder: number`. When it is set back to false, apply the latest order.
4. **`openDetail(type, id)`:** live row or `removed`.
5. **`locate(viewRef, id)`:** returns the page number.

**Acceptance criteria**

- [ ] Unit tests with mock `PageWindow` sequences: row insert at top, removal, moves across pages, freeze and unfreeze.
- [ ] Memory: the row cache holds only rows on open pages plus prefetch.

---

## C-04 · Worker bridge and public API

- **Depends on:** C-01 (C-02, C-03 for full API)
- **Size:** M
- **Folder:** `src/bridge/`, `src/index.ts`

**Goal.** One small, typed API the app uses from the main thread, while all the work happens in the Worker.

**Deliverables**

1. **Worker entry** `src/worker.ts`, bundlable by Angular's builder (`new Worker(new URL('./sdk.worker', import.meta.url), {type: 'module'})`).
2. **Control channel** (Comlink or a small typed RPC): `configure`, `openView`, `setLayout`, `subscribeMap`, `subscribePage`, `setFreezeOrder`, `openDetail`, `locate`, `setCamera`, `close*`.
3. **Data channels:**
   - frames sent with `postMessage(frame, [buffers])`; the main side returns buffers after rendering;
   - page, detail and status updates batched to at most 4 per second.
4. **Main-thread API `createAtlasClient(config)`:**
   - returns an object with methods and `subscribe(callback)` style observers, not RxJS-specific, so Angular, React and plain JS can all wrap it;
   - a `getSnapshot()` per observable slice, to fit React's `useSyncExternalStore`.
5. **Fallback** to running the core on the main thread when Workers are unavailable (tests only).

**Acceptance criteria**

- [ ] Example in `packages/client-sdk/examples/plain.html` works with the mock server (C-07): map frame counts and a page list update live.
- [ ] Public API documented in the package README with TypeScript signatures.

---

## C-05 · MapAdapter interface and Cesium adapter

- **Depends on:** C-02
- **Size:** L
- **Location:** interface in `packages/client-sdk/src/adapters/`; Cesium implementation in a new package `packages/map-cesium` (depends on `cesium`), so the SDK itself has no map dependency.

**Goal.** Draw 30,000 updating points per layer smoothly in Cesium, behind an interface another engine can implement.

**Deliverables**

1. **`MapAdapter` and `LayerStyle` types** exactly as contracts §7.
2. **`CesiumAdapter`:**
   - preferred: `BufferPointCollection` (experimental in recent Cesium) using bulk position updates; fallback: `PointPrimitiveCollection`, or `BillboardCollection` for icons. Choose by feature flag, and benchmark both.
   - hide with `show = false`, never `remove`; opaque blending where possible; icons registered once; positions in double precision;
   - labels only for the labelled subset (`LabelCollection`);
   - `pick` returns the entity id via the slot table.
3. **Benchmark page** in `apps/client` (a dev-only route) with 30,000 points updating 6,000 per second, showing FPS and frame-apply time.

**Acceptance criteria**

- [ ] 30,000 points, 6,000 updates per second: ≥ 50 FPS on a typical developer laptop; `applyFrame` < 4 ms. Record the numbers for both collection types.
- [ ] Clicking a point returns the correct entity id after many updates and removals.

---

## C-06 · deck.gl / MapLibre adapter (stretch)

- **Depends on:** C-05
- **Size:** M
- **Location:** `packages/map-deckgl`

**Goal.** Prove the adapter boundary: switching map engines requires no SDK or app-logic change.

**Deliverables**

1. **`DeckGlAdapter`:** `ScatterplotLayer` or `IconLayer` fed the frame's typed arrays directly as binary `data.attributes`. Mounted on MapLibre with `MapboxOverlay` from `@deck.gl/mapbox`, so the same code works on Mapbox.
2. Picking enabled only on layers that need it.
3. A dev route in `apps/client` that switches between the Cesium and deck.gl adapters at runtime.

**Acceptance criteria**

- [ ] The same benchmark as C-05 reaches ≥ 50 FPS.
- [ ] No GeoJSON sources are used for the live layer.

---

## C-07 · Mock protocol server and deterministic SDK tests

- **Depends on:** P-01
- **Size:** M
- **Location:** `packages/mock-server`

**Goal.** Client work can proceed without the real backend, and SDK bugs are reproducible.

**Deliverables**

1. Node WebSocket server speaking the real protocol (P-01):
   - generates N entities moving on the map;
   - serves pages and details;
   - configurable update rate.
2. Fault injection via an HTTP control endpoint:
   - drop a frame (sequence gap);
   - delay;
   - disconnect;
   - send `Reconnect`;
   - duplicate frames;
   - slow consumer.
3. **Recorder and replayer:** record a real session's frames to a file and replay them.
4. **Script `npm run mock -w @atlas/mock-server`.**

**Acceptance criteria**

- [ ] C-01 and C-03 tests use the in-memory transport; an end-to-end test runs the SDK against the mock server with every fault type and ends in a consistent state.
- [ ] 30,000 entities at 6,000 updates per second sustained.
