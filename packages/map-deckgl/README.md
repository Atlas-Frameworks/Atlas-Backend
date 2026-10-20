# @atlas/map-deckgl

deck.gl implementation of the SDK's `MapAdapter` (contracts §7, task C-06). It mounts on
MapLibre GL or Mapbox GL through `MapboxOverlay` from `@deck.gl/mapbox`, so the same code serves
both basemaps.

```ts
import { Map } from 'maplibre-gl';
import { DeckGlAdapter } from '@atlas/map-deckgl';

const map = new Map({ container: 'map', style });
const adapter = new DeckGlAdapter(map, { interleaved: false });
adapter.createLayer('planes', { color: '#4fc3f7', pixelSize: 6 });
client.attachMap(adapter); // createAtlasClient from @atlas/client-sdk
map.on('click', (e) => console.log(adapter.pick(e.point.x, e.point.y)));
```

`new DeckGlAdapter(map, options?)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `interleaved` | `false` | Draw in the map's own WebGL context and layer stack instead of a canvas on top. |
| `pickRadius` | `3` | Pick tolerance in CSS pixels. |
| `overlayProps` | — | Extra `MapboxOverlay` / `Deck` props (`useDevicePixels`, `onAfterRender`, …). |
| `overlay` | — | Replaces the `MapboxOverlay` (tests; there is no WebGL in Node). |

`maplibre-gl` / `mapbox-gl` is not a dependency: the app passes its map in (anything with
`addControl` / `removeControl`).

## How it draws

- **Points:** a `ScatterplotLayer`, or an `IconLayer` when `LayerStyle.icons` is set. Data is deck.gl
  binary data, `{ length, attributes: { getPosition: { value: Float64Array, size: 3 } } }`. No GeoJSON
  source, no map source or style layer, no object per entity.
- **Visibility:** hidden slots are left out. Each frame the visible slots are packed into a dense
  buffer with a parallel `slotOf: Uint32Array` (instance → slot), so hidden entities are neither
  drawn nor pickable and no per-instance color/alpha trick is needed.
- **Double precision:** positions stay `Float64Array`. deck.gl's position attributes are `float64`
  with fp64 on for `LNGLAT`, so it splits each value into high/low float32 parts on upload. (A
  float32 + `LNGLAT_OFFSETS` origin was rejected: its offsets are a linear approximation around the
  origin, wrong for a global layer.)
- **Re-upload only on change:** deck.gl compares `data` and binary attribute values by reference.
  Two buffer sets alternate: each frame fills the set that is not on screen and hands deck.gl that
  set's `data` object, which makes it re-upload; nothing changes between frames, so nothing is
  uploaded. Nothing is allocated per frame unless the layer grows (deck.gl's fp64 split allocates
  its own upload array). The frame's buffers go back to the worker when `applyFrame` returns, so
  the adapter copies what it needs during the call.
- **Icons:** one icon def object per icon code, created in `createLayer`; `getIcon` reads the
  compacted `Uint16Array` by index and returns the shared def (deck.gl auto-packs the atlas).
- **Labels:** a `TextLayer` over `frame.labels` only (the SDK picks at most 500), always above the
  point layers, never pickable.
- **Picking:** only layers with `style.pickable !== false` are `pickable`, and `pick` passes only
  those `layerIds` to `pickObject` (it returns `null` without picking when there are none).
  `pick` maps the picked instance through the `slotOf` of the buffer set the picked layer actually
  holds (it may still be the previous one) and then through the SDK's slot → id table.
- **Order:** `zIndex`, then creation order; labels above all points.

## Benchmark

```sh
npm run bench -w @atlas/map-deckgl    # builds bench/ with esbuild, serves http://127.0.0.1:5181/
```

The page draws MapLibre with a blank background style (no token, no network; `?style=demo` uses
the MapLibre demo tiles) and a HUD with FPS, `applyFrame` time and deck.gl render time.
Synthetic mode (default): 30,000 airplanes, 6,000 position updates per second delivered as 10
frames per second (the SDK's `FrameScheduler` rate), 50 removals/re-adds per second with slot
reuse, 200 labels. Parameters: `n`, `rate`, `fps`, `churn`, `labels`, `icons=1`, `live=1` (frames
from the mock server through `createAtlasClient`, `mock=` URL). `window.__bench.summary()` returns
the numbers.

### Results (2026-10-20)

Built-in browser pane of the Claude desktop app (Chromium, devicePixelRatio 2, 800×600 viewport,
Apple Silicon Mac). 15 s windows after 3 s warm-up, pane visible.

| Run | FPS (avg / min 1 s window) | `applyFrame` avg / p95 / max | deck.gl render hook avg / p95 |
| --- | --- | --- | --- |
| 30,000 points, ScatterplotLayer, 6,000 upd/s, 200 labels | 120.0 / 119.9 | 0.25 / 0.30 / 0.60 ms | 0.43 / 0.60 ms |
| 30,000 points, IconLayer, same load | 120.1 / 119.9 | 0.25 / 0.30 / 0.90 ms | 0.42 / 0.60 ms |
| Live: mock server via SDK worker (≈3,000 airplanes) | 113.7 / 86 | 0.20 / 0.30 / 1.1 ms | 1.05 / 4.0 ms |

- **≥ 50 FPS: met.** FPS sits at the display's 120 Hz cap, so the real headroom is larger than
  the table shows.
- `applyFrame` is the adapter's synchronous cost (compaction copy + new layer descriptors).
  deck.gl's attribute upload runs later in its render loop; its own metrics put the
  `updateAttributes` cost at about 1 ms per frame for the IconLayer run (positions + icon defs +
  labels).
- The render hook (`onBeforeRender` → `onAfterRender`) is CPU submit time; GPU time isn't
  measured (no timer query in this pane).
- Picking against real WebGL in live mode: 18 of 18 projected entity positions returned the
  right id.

How far to trust these numbers: the pane is a real Chromium with WebGL2, but a small viewport on
a fast machine. It throttles hard when the app window is not in view (rAF stops), so only runs
with the pane visible are reported. The live run used whichever mock server was already running
on :8090 (≈3,000 entities, not `--profile load`). Re-run on a typical laptop at full-screen size
before relying on the margin. A full-HD window has about 4× the pixels, but 30,000 small points
are vertex-bound, not fill-bound.

## Tests

`npm test -w @atlas/map-deckgl` (Vitest, Node, no WebGL; the deck.gl overlay is faked):

- `layer-buffers.spec.ts`: compaction, fp64 values kept, buffer-set alternation with no
  reallocation, growth, label subset, pick-id resolution after many updates, removals and slot
  reuse, and against the previous (still on screen) set.
- `deckgl-adapter.spec.ts`: layer types and binary `Float64Array` data, no GeoJSON layer or map
  source (runtime check plus a scan of `src/`), a new `data` object per frame with untouched layers
  reused, IconLayer icon defs shared per code, `pick` through the slot table, picking only on
  pickable layers, `destroy`.

The runtime Cesium/deck.gl switch (task deliverable 3) is the `/dev/map-bench` route in
`apps/client`, wired in A-03 (results in `apps/client/README.md`).
