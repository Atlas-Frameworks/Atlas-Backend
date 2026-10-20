# boaz · Client SDK and Angular app

You own the browser side: the framework-free SDK (`packages/client-sdk`) and the Angular app (`apps/client`).

**None of your tasks depends on another person's open task.** The only outside input is the Protobuf schema (P-01), which dvir is finishing now on `task/P-01-protobuf`. A-01 needs nothing, so start there.

## Your tasks, in order

| # | ID | Title | Size | Depends on | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | A-01 | Angular app shell and login stub | M | F-01 ✓ | [07-client-app.md](07-client-app.md) |
| 2 | C-07 | Mock protocol server and deterministic SDK tests | M | P-01 | [06-client-sdk.md](06-client-sdk.md) |
| 3 | C-01 | SDK core: transport, protocol, sequence, reconnect | L | P-01 | [06-client-sdk.md](06-client-sdk.md) |
| 4 | C-02 | Map data store and frame scheduling | M | C-01 | [06-client-sdk.md](06-client-sdk.md) |
| 5 | C-03 | Pages, detail and locate | M | C-01 | [06-client-sdk.md](06-client-sdk.md) |
| 6 | C-04 | Worker bridge and public API | M | C-01 | [06-client-sdk.md](06-client-sdk.md) |
| 7 | A-02 | Angular SDK service (signals) | S | C-04, A-01 | [07-client-app.md](07-client-app.md) |
| 8 | C-05 | MapAdapter interface and Cesium adapter | L | C-02 | [06-client-sdk.md](06-client-sdk.md) |
| 9 | A-03 | Map component | M | C-05, A-02 | [07-client-app.md](07-client-app.md) |
| 10 | A-04 | Layers panel: filters, grouping, live pages | L | A-02, C-03 | [07-client-app.md](07-client-app.md) |
| 11 | A-05 | Detail drawer | S | A-02, C-03 | [07-client-app.md](07-client-app.md) |
| 12 | C-06 | deck.gl / MapLibre adapter (stretch) | M | C-05 | [06-client-sdk.md](06-client-sdk.md) |

About 57 working days for one person (S ≈ 1.5, M ≈ 4, L ≈ 7.5), or about 53 without the stretch task.

## Working without the real server

You never wait for the view-service. C-07's mock server speaks the real protocol from [contracts.md §3](../../contracts.md), injects sequence gaps and generates 30,000-entity load, so every SDK and app task is built and tested against it. Pointing the app at a real worker later is a config change.

## Rules for this area

- `packages/client-sdk` must not import Angular, React, Cesium, deck.gl or MapLibre.
- Per-tick map data stays in typed arrays. It never becomes per-entity JS objects or Angular state.
- The `MapAdapter` shape is fixed in contracts §7. If it must change, open a `contract-change` PR first.
