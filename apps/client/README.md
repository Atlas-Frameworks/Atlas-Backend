# @atlas/client

Angular 22 app (standalone components, zoneless change detection, Vitest). A thin UI over `@atlas/client-sdk`; it holds no realtime logic of its own.

- Tasks: [docs/tasks/boaz/07-client-app.md](../../docs/tasks/boaz/07-client-app.md) (A-01 – A-05)
- SDK it builds on: [docs/tasks/boaz/06-client-sdk.md](../../docs/tasks/boaz/06-client-sdk.md)

```bash
npm start -w @atlas/client      # dev server on http://localhost:4200
npm run build -w @atlas/client
npm test -w @atlas/client
```

## Running it (A-01)

```bash
npm run dev:mock     # C-07 mock server: ws://127.0.0.1:8090/ws, dev auth and registry endpoints
npm run dev:client   # http://localhost:4200
```

| Route | What |
| --- | --- |
| `/login` | Dev sign-in stub: pick one or several countries, or a connection, from `GET {devApiUrl}/dev/scopes`; `POST {devApiUrl}/dev/token` returns a dev JWT, kept in memory only (a reload signs out). |
| `/` | Map workspace (needs a token, otherwise redirects to `/login`): full-screen map area, collapsible Layers panel, detail drawer, top bar with the connection status. |
| `/dev/map-bench` | C-05 / C-06 adapter benchmark (no backend, no token): 30,000 synthetic points, 6,000 updates/s, Cesium or deck.gl switchable at run time. See [Map (A-03)](#map-a-03). |

Endpoints are in `src/environments/environment.ts` (`AtlasEnvironment`, injected as `ATLAS_ENV`):
`services` (entity type → view-service WebSocket URL, `'*'` = fallback), `devApiUrl` and
`registryUrl`, and `basemap` (the map imagery, below). They default to the mock server until the replicator-sim dev endpoints (W-03) and
the view-service exist.

Styles: design tokens (colors, spacing, radii, type, layout) are SCSS maps in
`src/styles/_tokens.scss`, emitted once as `--atlas-*` custom properties; the theme is dark, tuned
for a map background.

## Realtime service (A-02)

`AtlasRealtimeService` (`src/app/realtime/`) wraps `createAtlasClient` from `@atlas/client-sdk`. The
SDK core runs in a Web Worker (`sdk.worker.ts`, bundled by the Angular builder); one client per
signed-in session is created lazily on first use, gets new tokens, and is destroyed on sign-out.

```ts
readonly rt = inject(AtlasRealtimeService);
rt.connectionStatus();  // 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
rt.staleSince();        // ms or null; rt.stale(), rt.lastError(), rt.status()

// In an injection context (field initializer, constructor) these clean up with the component;
// elsewhere pass { destroyRef }.
readonly view = this.rt.openView({ entityType: 'airplanes', filter });  // scope = the session's
readonly page = this.rt.subscribePage(this.view, { pageSize: 50 });      // rows(), total(), groupCounts(), loading(), stale()
readonly detail = this.rt.openDetail('airplanes', id);                  // row(), removed(), loading(), stale()
page.dispose();                                                         // or let DestroyRef do it

// Map frames never become signals: the adapter gets them straight from the SDK, outside
// change detection.
rt.subscribeMap(view);
const detach = rt.attachMap(adapter);
```

Workspace packages resolve to their TypeScript sources: `conditions: ["@atlas/source", …]` in
`angular.json` (also applied to the worker bundle), `customConditions` in `tsconfig.json`, and
`prebundle.exclude` for the dev server (otherwise Vite would load a stale `dist/`).

## Map (A-03)

`MapView` (`src/app/map/`, `<app-map-view>` in the workspace) draws the live views of
`WorkspaceStore` on a Cesium globe through `CesiumAdapter` (`@atlas/map-cesium`):

- **Layers:** one per view in `WorkspaceStore.views`, layer id = `view.handle.id`
  (`rt.subscribeMap(view, id)` + `adapter.createLayer`, style by entity type). A view that leaves
  the list has its map subscription closed and its layer emptied.
- **Frames:** `rt.attachMap(adapter)`; the SDK calls `applyFrame` from its Worker message handler.
  Cesium's render loop, frames, camera and click handlers are plain DOM / rAF callbacks that write
  no signals, so the zoneless app runs no change detection for them.
- **Camera:** sent with `rt.setCamera` (ground point at the canvas centre + camera height) on
  every camera change, throttled to one call per 250 ms (leading and trailing). Below 2,000 km the
  SDK labels the entities nearest that point.
- **Click:** `adapter.pick` → `WorkspaceStore.select({ entityType, id })` (opens the drawer); the
  selection goes to `rt.setSelected`, which labels it, also for a list row click.
- **Fly-to:** `WorkspaceStore.flyTo` → `CesiumAdapter.locate(id)` (slot table + last drawn
  position of the last frame) → `camera.flyTo`. An entity not on the map yet is retried on each
  frame for 10 s.
- **Stale overlay:** grey tint plus a badge while reconnecting ("Reconnecting… showing last known
  positions") or while the SDK reports stale data ("Stale since HH:MM:SS").
- **Basemap:** `environment.basemap`. `url: null` (default) is a plain globe with a lat/lon grid,
  which needs no network or token; set `url` to the on-prem XYZ template (`{z}/{x}/{y}`), with
  `maximumLevel` and `credit`. No Cesium ion.
- **Bundle:** Cesium is loaded on demand (`MAP_ENGINE_FACTORY` → `import('./cesium-engine')`, a
  4 MB lazy chunk); the initial bundle stays at 236 kB. Its static files (workers, CSS) are copied
  to `.map-assets/` by `scripts/map-assets.mjs` before `build` / `start` and served at `/cesium/`.
  `allowedCommonJsDependencies` lists Cesium's and deck.gl's CommonJS dependencies.

In dev mode `window.atlasMap.counters` counts frames applied, Angular renders and Cesium renders.

### Verification

- Unit tests (`map-view.spec.ts`, fake engine and fake SDK): layers per view and their removal,
  500 frames of 30,000 points with **0** Angular renders and **0** effect runs (a status change
  does render), click → select + label, camera throttle, fly-to once the entity appears, stale
  overlay.
- Live, with the mock server (`--profile load`, 30,000 airplanes): the globe shows about 30,000
  points; over 10 s, **92 frames applied, 0 Angular renders** (`atlasMap.counters`). A real click
  on a point selected it (`airplanes`, its id) and opened the drawer. `POST /control/fault
  {"type":"disconnect"}` for the session: Live → "Reconnecting…" with the overlay (+0.4 s) →
  "Stale since …" (+0.9 s) → Live (+1.15 s); then 90 frames per 10 s again, still 0 renders.

### `/dev/map-bench` results

Headless Chrome 155 with GPU (ANGLE Metal, Apple M1 Pro), 1024×681 CSS px, devicePixelRatio 1,
60 Hz frame cap. 15 s per row after 4 s warm-up (`await mapBench.measure(15)`). FPS is the page's
requestAnimationFrame rate; Cesium renders every frame here, deck.gl only when data changes.

| Adapter | FPS | Map renders/s | applyFrame p50 / p95 / max |
| --- | ---: | ---: | --- |
| Cesium, BufferPointCollection | **60.0** | 60.0 | 0.4 / 0.5 / 0.6 ms |
| Cesium, PointPrimitiveCollection | **60.0** | 60.0 | 0.6 / 0.7 / 1.2 ms |
| deck.gl on MapLibre | **60.1** | 10.0 | 0.3 / 0.4 / 0.6 ms |

All hold the frame cap, so the headroom is larger than the table shows (see the C-05 / C-06
READMEs for 120 Hz runs). The desktop app's browser pane could not be used: it was hidden, and a
hidden pane stops requestAnimationFrame (FPS 0) and throttles timers.
