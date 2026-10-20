# 07 · Client app (`apps/client`, Angular 22)

A thin Angular app over the SDK. The app holds no realtime logic of its own, so it could be rewritten in React using the same SDK.

Generated with Angular 22: standalone components, zoneless change detection, Vite-based builder, Vitest. Plan section: "Client architecture".

---

## A-01 · Angular app shell and login stub

- **Depends on:** F-01
- **Size:** M

**Goal.** The layout and navigation every other client task plugs into.

**Deliverables**

1. **Layout:** a full-screen map area; a collapsible "Layers" side panel; a detail drawer; a top bar with connection status ("Live", "Reconnecting…", "Stale since 12:03:05").
2. **Login stub page,** for the POC only:
   - choose one country, several countries, or a connection from lists fetched from the dev endpoint `GET /dev/scopes` on the replicator-sim (W-03);
   - get a dev JWT from `POST /dev/token`;
   - store it in memory, not localStorage.
3. **Environment config:** service URLs per entity type, and the dev token URL.
4. **Styles:** SCSS design tokens for colors and spacing, and a dark theme suitable for a map.
5. **Routing:** `/login`, `/` (the map workspace), `/dev/map-bench` (C-05's benchmark page).

**Acceptance criteria**

- [ ] `npm run dev:client` serves the app. Login → workspace layout renders with placeholder panels.
- [ ] Builds with no warnings in production mode.

---

## A-02 · Angular SDK service (signals)

- **Depends on:** C-04, A-01
- **Size:** S

**Goal.** One injectable service that adapts the SDK's observers to Angular signals.

**Deliverables**

1. `AtlasRealtimeService` (`providedIn: 'root'`):
   - starts the SDK Worker;
   - exposes `connectionStatus`, `stale` and per-subscription signals: page rows, totals, group counts, detail rows;
   - set from SDK callbacks; no RxJS needed.
2. Helpers `openView`, `subscribePage`, `openDetail`, each returning a handle with signals plus `dispose()`, cleaned up automatically through `DestroyRef`.
3. Map frames are **not** turned into signals; they go straight to the map adapter (A-03).

**Acceptance criteria**

- [ ] Unit test with a fake SDK: signals update; dispose closes the subscription.
- [ ] No change-detection work per map frame (verify with Angular DevTools profiler).

---

## A-03 · Map component

- **Depends on:** C-05, A-02
- **Size:** M

**Goal.** Live map layers through the Cesium adapter.

**Deliverables**

1. `MapComponent`:
   - creates the Cesium viewer with the on-prem basemap configured in the environment;
   - creates a `CesiumAdapter`;
   - registers it with the SDK for the map subscriptions of the active views.
2. The camera position is sent to the SDK (`setCamera`, throttled) for label selection, and later for viewport mode.
3. Clicking a point → `pick` → opens the detail drawer (A-05).
4. The map shows a stale overlay (grey tint or badge) when the SDK reports stale.

**Acceptance criteria**

- [ ] With the backend or the mock server: thousands of points move, clicking opens details, and stopping the server shows "Reconnecting", then recovery.
- [ ] Cesium's render loop doesn't trigger Angular change detection. The app is zoneless; verify with the profiler.

---

## A-04 · Layers panel: filters, grouping, live pages

- **Depends on:** A-02, C-03
- **Size:** L

**Goal.** Users build filters and groupings and browse live paginated results.

**Deliverables**

1. **Filter builder:**
   - field list, operators and value editors generated from registry metadata, served by the view-service `GET /meta/registry` (coordinate with S-05; read-only, from E-01);
   - and/or groups;
   - validation messages from server `INVALID_FILTER` errors.
2. **Grouping:** choose up to 2 group-by fields; an expandable group tree with live counts.
3. **Live pages:**
   - Angular CDK virtual scroll with **fixed row height**;
   - page size 50, page controls plus `locate`;
   - rows tracked by entity id;
   - row click → detail drawer;
   - hovering or scrolling sets `freezeOrder`, with a banner "N changed — refresh order".
4. **Saved views** per user in localStorage (filter + grouping), only as a POC convenience.

**Acceptance criteria**

- [ ] Changing a filter re-subscribes and the map and list update together.
- [ ] Rows never jump under the cursor while hovering.
- [ ] A view of 30,000 entities pages smoothly.

---

## A-05 · Detail drawer

- **Depends on:** A-02, C-03
- **Size:** S

**Goal.** Show one entity's full nested data, live.

**Deliverables**

1. Drawer opened from map click or row click.
   - Shows top-level fields and nested data (crew list, runways) as tables.
   - Updates live, and shows "Removed" if the entity is deleted.
2. "Show on map" (fly to) and "Find in list" (`locate` → jump to the page).

**Acceptance criteria**

- [ ] A crew change made by the simulator appears in the open drawer within 2 s.
