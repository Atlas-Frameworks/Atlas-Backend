# @atlas/map-cesium

Cesium implementation of the client SDK's `MapAdapter` (task C-05,
[docs/tasks/boaz/06-client-sdk.md](../../docs/tasks/boaz/06-client-sdk.md); interface in
[contracts.md §7](../../docs/contracts.md) and `@atlas/client-sdk` `src/adapters/`). The SDK has no
map dependency; this package depends on `cesium` (pinned to `1.146.0`, because
`BufferPointCollection` is experimental and may change without deprecation).

```ts
import { createAtlasClient } from '@atlas/client-sdk';
import { CesiumAdapter } from '@atlas/map-cesium';

const adapter = new CesiumAdapter(viewer.scene, { points: 'buffer' }); // or 'primitive'
adapter.createLayer('airplanes', { color: '#4fc3f7', pixelSize: 5 });
const detach = client.attachMap(adapter);
canvas.addEventListener('click', (e) => console.log(adapter.pick(e.offsetX, e.offsetY)));
```

## API

```ts
type PointCollectionKind = 'buffer' | 'primitive';

interface CesiumSceneLike {            // a Cesium Scene satisfies it
  readonly primitives: PrimitiveCollection;
  pick(windowPosition: Cartesian2): unknown;
  requestRender?(): void;
}

class CesiumAdapter implements MapAdapter {
  constructor(scene: CesiumSceneLike, options?: { points?: PointCollectionKind });
  createLayer(layerId: string, style: LayerStyle): void; // again with the same id replaces the layer
  applyFrame(frame: MapFrame): void;                     // unknown layerId: created with default style
  pick(screenX: number, screenY: number): string | null; // CSS pixels relative to the canvas
  resolvePick(picked: unknown): string | null;           // a scene.pick result -> entity id
  readonly stats: { layerId; count; moved; toggled; labels }; // last applyFrame, updated in place
  destroy(): void;
}
```

## How it draws

- **Collection per layer, chosen by feature flag.** `points: 'buffer'` (default) uses
  `BufferPointCollection`: all points in one ArrayBuffer, written through a single flyweight
  `BufferPoint`, with Cesium re-packing only points marked dirty. `points: 'primitive'` uses
  `PointPrimitiveCollection`. A layer whose `LayerStyle.icons` is non-empty always uses
  `BillboardCollection`, because buffer points cannot draw images.
- **Slots map 1:1 to Cesium points.** Points are created when a slot first appears and never removed:
  a hidden or freed slot gets `show = false`. A buffer collection cannot grow, so it is rebuilt with
  double the capacity (starting at 1,024) when `frame.count` passes it.
- **Only changes reach Cesium.** The adapter keeps its own copy of the last drawn lon/lat/alt, show
  flag and icon per slot (frame buffers go back to the worker after `applyFrame`), and writes only
  slots where these changed. Positions are converted with `Cartesian3.fromDegrees` into one scratch
  object (double precision, WGS84). The buffer collection gets a fixed globe-sized bounding sphere so
  Cesium doesn't recompute bounds over every point on each move.
- **Blending:** points use `BlendOption.OPAQUE`. Billboards use `OPAQUE_AND_TRANSLUCENT` because
  icons have anti-aliased edges.
- **Icons are registered once.** Billboards refer to icons by URL, and the collection's texture atlas
  keys images by URL, so each icon is loaded and packed once per layer. A billboard's image is set
  only when its icon index changes.
- **Labels** are drawn only for `frame.labels` (the SDK's labelled subset), in a `LabelCollection`
  per layer. They are pooled by slot and hidden, never removed.
- **Picking:** the pick payload is the slot, never the entity id. That is `{collection, index}` for
  buffer points, and `id = slot` for point primitives, billboards and labels. `pick` maps the slot
  through the slot → id table of the last applied frame, and returns `null` for hidden or freed
  slots. Layers with `pickable: false` are ignored.
- **zIndex:** each layer has its own `PrimitiveCollection`, and layers are ordered by `zIndex`.

## Benchmark

```bash
npm run mock -w @atlas/mock-server -- --profile load   # only for source=mock
npm run bench -w @atlas/map-cesium                     # http://127.0.0.1:5181/
```

The page (`bench/`, bundled with esbuild, with Cesium's static assets served from
`node_modules/cesium/Build/Cesium`) shows a `CesiumWidget` with no ion token: a local grid imagery
layer over a base colour. The overlay shows FPS, `applyFrame` p50/p95, frames/s and slots moved per
frame, plus a select that switches the collection type. Clicking a point shows the picked id and how
far (in px) that entity is drawn from the click. The query string sets `source=synthetic|mock`,
`kind=buffer|primitive|icons`, `n`, `ups`, `hz` (frames/s), `churn`, `h` (camera height) and
`mock`. `window.bench.measure(seconds)` returns the same numbers for scripted runs.

The synthetic source is 30,000 entities with 6,000 position updates/s. 1% of updates remove an
entity, and a new entity takes the freed slot in the next frame, following the SDK's reuse rule. The
first 200 slots are labelled. The mock source is `createAtlasClient` in a Worker against the mock
server's `load` profile (30,000 airplanes, 6,000 updates/s).

### Results

Measured 2026-10-20 in the Claude desktop app's built-in browser pane: Chromium 152, ANGLE Metal on
an **Apple M1 Pro**, devicePixelRatio 2, 120 Hz display, a pane about 700×780 CSS px, whole globe in
view. Each row is 15 s after a 4 s warm-up. `applyFrame` is wall time around the call. Chromium
rounds `performance.now()` to 0.1 ms on this non-isolated page, so sub-millisecond values are ±0.1.

| Source, frame rate | Collection | FPS | Render interval p95 | applyFrame p50 / p95 / max | Moved per frame |
| --- | --- | ---: | ---: | --- | ---: |
| synthetic, 10 frames/s (SDK default) | BufferPointCollection | **120.0** | 10.4 ms | **0.50 / 0.70** / 1.4 ms | 605 |
| synthetic, 10 frames/s | PointPrimitiveCollection | **120.0** | 14.5 ms | **0.80 / 1.00** / 2.7 ms | 600 |
| synthetic, 10 frames/s | BillboardCollection (icons) | 97.0 | 18.9 ms | 0.90 / 1.40 / 3.2 ms | 671 |
| mock server, 10 frames/s | BufferPointCollection | **109.7** | 9.4 ms | **0.30 / 0.40** / 0.7 ms | 637 |
| mock server, 10 frames/s | PointPrimitiveCollection | **112.1** | 12.4 ms | **0.30 / 0.40** / 1.4 ms | 608 |
| mock server, 10 frames/s | BillboardCollection (icons) | 70.6 | 15.9 ms | 0.40 / 0.60 / 0.9 ms | 609 |
| synthetic, every render (`hz=60`, about 50 frames/s) | BufferPointCollection | **109.3** | 16.6 ms | **0.40 / 0.80** / 3.7 ms | 115 |
| synthetic, every render | PointPrimitiveCollection | 72.5 | 26.3 ms | 0.40 / 1.00 / 3.2 ms | 143 |
| synthetic, every render | BillboardCollection (icons) | **36.1** | 50.6 ms | 0.50 / 1.20 / 5.1 ms | 243 |

What the numbers say:

- **The targets are met** (≥ 50 FPS, `applyFrame` < 4 ms) for both point collection types at the
  SDK's frame rate. `applyFrame` p95 stays at or below 1.4 ms in every configuration.
- **BufferPointCollection is the better default.** It holds about 110 FPS even when frames arrive on
  every render. PointPrimitiveCollection drops to 72 FPS there, and billboards to 36 FPS. The extra
  cost is not in `applyFrame`: it is Cesium re-packing vertex buffers in the collection's `update()`
  during render, which per-object collections do in bigger chunks.
- **Icons with frames on every render miss 50 FPS** on this machine. At the SDK's 10 frames/s they
  reach 71–97 FPS. A 30k-icon layer should stay at ≤ 10 frames/s.
- **The first frame is expensive.** It creates every point and positions every slot: about 9–19 ms
  for points and 125–206 ms for 30,000 billboards (console `first full applyFrame`). It happens once
  per layer and is excluded from the percentiles.
- **Allocation:** no objects are created per entity per frame. In Node, a steady frame with nothing
  moved allocates about 24 B. Each moved point leaves about 30 B of short-lived young-generation
  garbage, mostly number boxing inside Cesium's `Cartesian3.fromDegrees` / `BufferPoint.setPosition`
  (each about 16 B/call when measured alone). At 600 moved per frame that is about 19 KB per frame.
- **How representative this is:** the pane is a real Chromium with GPU acceleration on an M1 Pro
  laptop, with a smallish viewport. A larger full-screen window or a weaker integrated GPU would
  lower FPS, mainly for billboards. Treat the icon rows as an upper bound and re-measure on target
  hardware. FPS is capped by the 120 Hz display. Numbers from a hidden pane or background tab are
  meaningless, because Chromium throttles rendering there.

### Picking

- **Unit tests** (`src/cesium-adapter.spec.ts`, Vitest, no WebGL). The test pipeline is the real SDK
  `MapLayerStore` → `FrameBuilder` → `MapFrameAssembler`, with buffers released after every
  `applyFrame`. It runs 150 rounds of 120 moves, 15 removals and 15 additions over 1,500 entities,
  plus explicit slot reuse, for each of the three collection types. A fake `scene.pick` searches the
  **real Cesium collections** for the nearest shown point and returns Cesium's pick-object shape for
  that collection. The tests assert:
  - every live entity picks its own id;
  - none of the 2,000+ removed entities picks anything;
  - the number of shown Cesium points equals the number of live entities;
  - a reused slot picks the new id;
  - picking through a label returns that entity's id.

  Labels need a DOM, so the spec runs in jsdom.
- **Real clicks in the bench page** (synthetic source, `churn=0.05`, camera at 1,500 km, updates
  frozen for the click). The pane's mouse clicks on entities whose ids show they sit in reused slots
  returned the right id for every collection type. Offset is the distance from the click to where
  that entity is drawn:

  | Collection | Picked id | Offset |
  | --- | --- | ---: |
  | buffer | `plane-31353` | 0.4 px |
  | buffer | `plane-31432` | 0.3 px |
  | primitive | `plane-32416` | 0.3 px |
  | primitive | `plane-32219` | 0.4 px |
  | icons | `plane-31105` | 0.3 px |
  | icons | `plane-31284` | 0.7 px |

## Not done here

- The dev route `/dev/map-bench` in `apps/client` (C-05 deliverable 3) is wired in A-03. Until then
  this package's `bench/` page is the benchmark.
- `BufferPointCollection` requires `SceneMode.SCENE3D` (Cesium logs a warning otherwise). Use
  `points: 'primitive'` for 2D or Columbus view.
- No smooth motion between frames (C-02 decision: no interpolation in the POC).
