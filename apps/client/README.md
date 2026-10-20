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
| `/dev/map-bench` | Placeholder for the C-05 / C-06 adapter benchmarks. |

Endpoints are in `src/environments/environment.ts` (`AtlasEnvironment`, injected as `ATLAS_ENV`):
`services` (entity type → view-service WebSocket URL, `'*'` = fallback), `devApiUrl` and
`registryUrl`. They default to the mock server until the replicator-sim dev endpoints (W-03) and
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
