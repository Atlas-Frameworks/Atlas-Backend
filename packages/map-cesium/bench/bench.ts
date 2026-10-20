/**
 * C-05 benchmark: 30,000 points, 6,000 position updates per second, drawn by CesiumAdapter.
 *
 * Build and serve: `npm run bench -w @atlas/map-cesium`, then open http://127.0.0.1:5181/.
 * Query parameters:
 *   source=synthetic|mock   local generator (default) or the mock server through createAtlasClient
 *   kind=buffer|primitive|icons   collection type (also switchable in the panel)
 *   n=30000  ups=6000  hz=10      entities, position updates per second, frames per second
 *                                  (10 matches the SDK frame scheduler's default; 60 = every frame)
 *   h=18000000                    initial camera height in metres
 *   churn=0.01                    share of updates that remove an entity (a new one takes the slot)
 *   mock=http://127.0.0.1:8090    mock server (run it with `--profile load`)
 *
 * `window.bench` exposes the numbers for scripted runs: `await bench.measure(10)`.
 */
import { createAtlasClient } from '@atlas/client-sdk';
import type { LayerStyle, MapFrame } from '@atlas/client-sdk';
import {
  Cartesian3,
  CesiumWidget,
  Color,
  GridImageryProvider,
  ImageryLayer,
  SceneTransforms,
} from 'cesium';
import { CesiumAdapter } from '../src/index.js';
import type { PointCollectionKind } from '../src/index.js';

type Kind = PointCollectionKind | 'icons';

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => Number(params.get(key) ?? fallback);
const N = num('n', 30_000);
const UPS = num('ups', 6_000);
const HZ = num('hz', 10);
const CHURN = num('churn', 0.01);
const SOURCE = params.get('source') === 'mock' ? 'mock' : 'synthetic';
const LAYER = 'airplanes';

const el = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
};
const kindSelect = el('kind');
if (!(kindSelect instanceof HTMLSelectElement)) throw new Error('#kind is not a select');

// ---------------------------------------------------------------------------------------------
// Cesium, with no ion token: a local grid imagery layer over a plain base colour.

const widget = new CesiumWidget(el('globe'), {
  baseLayer: new ImageryLayer(new GridImageryProvider({})),
  requestRenderMode: false,
});
const scene = widget.scene;
scene.globe.baseColor = Color.fromCssColorString('#16324a');
scene.camera.setView({ destination: Cartesian3.fromDegrees(10, 30, num('h', 18_000_000)) });

const iconStyle: LayerStyle = { icons: ['icons/plane.svg', 'icons/heli.svg'], iconSize: 14 };
const styleFor = (kind: Kind): LayerStyle =>
  kind === 'icons' ? iconStyle : { color: '#4fc3f7', pixelSize: 4 };

let kind: Kind = ((): Kind => {
  const k = params.get('kind');
  return k === 'primitive' || k === 'icons' ? k : 'buffer';
})();
kindSelect.value = kind;
let adapter = makeAdapter(kind);

function makeAdapter(k: Kind): CesiumAdapter {
  const a = new CesiumAdapter(scene, { points: k === 'icons' ? 'buffer' : k });
  a.createLayer(LAYER, styleFor(k));
  return a;
}

// ---------------------------------------------------------------------------------------------
// Measurements: render FPS from scene.postRender, applyFrame time around every call.

let skipNext = true; // the first frame after (re)building an adapter writes every slot

/** applyFrame times, frame-to-frame render intervals and counters since `since`. */
class StatWindow {
  private static readonly SAMPLES = 8192;
  private readonly applyMs = new Float64Array(StatWindow.SAMPLES);
  private readonly renderMs = new Float64Array(StatWindow.SAMPLES);
  private applyN = 0;
  private renderN = 0;
  private moved = 0;
  private lastRender = 0;
  private since = performance.now();

  reset(): void {
    this.applyN = 0;
    this.renderN = 0;
    this.moved = 0;
    this.lastRender = 0;
    this.since = performance.now();
  }

  apply(ms: number, moved: number): void {
    this.applyMs[this.applyN++ % StatWindow.SAMPLES] = ms;
    this.moved += moved;
  }

  render(now: number): void {
    if (this.lastRender > 0)
      this.renderMs[this.renderN % StatWindow.SAMPLES] = now - this.lastRender;
    this.renderN++;
    this.lastRender = now;
  }

  summary() {
    const secs = (performance.now() - this.since) / 1000;
    const applies = this.applyN;
    return {
      kind,
      source: SOURCE,
      points: adapter.stats.count,
      seconds: secs,
      fps: this.renderN / secs,
      renderIntervalP95: pct(this.renderMs, this.renderN - 1, 95),
      applyP50: pct(this.applyMs, applies, 50),
      applyP95: pct(this.applyMs, applies, 95),
      applyMax: pct(this.applyMs, applies, 100),
      framesPerSecond: applies / secs,
      movedPerFrame: applies ? this.moved / applies : 0,
    };
  }
}

function pct(samples: Float64Array, count: number, p: number): number {
  const n = Math.min(count, samples.length);
  if (n <= 0) return Number.NaN;
  const sorted = samples.slice(0, n).toSorted();
  return sorted[Math.min(n - 1, Math.floor((p / 100) * n))]!;
}

/** The overlay's window (reset every 2 s) and any running `bench.measure` windows. */
const overlay = new StatWindow();
const windows = new Set<StatWindow>([overlay]);

function timedApply(frame: MapFrame): void {
  const t0 = performance.now();
  adapter.applyFrame(frame);
  const dt = performance.now() - t0;
  if (frame.count === 0) return;
  if (skipNext) {
    skipNext = false;
    console.info(`first full applyFrame (${frame.count} slots): ${dt.toFixed(1)} ms`);
    return;
  }
  for (const w of windows) w.apply(dt, adapter.stats.moved);
}

scene.postRender.addEventListener(() => {
  const now = performance.now();
  for (const w of windows) w.render(now);
});

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
setInterval(() => {
  const s = overlay.summary();
  el('fps').textContent = fmt(s.fps, 1);
  el('fps').className = s.fps >= 50 ? 'ok' : 'bad';
  el('p50').textContent = fmt(s.applyP50);
  el('p95').textContent = fmt(s.applyP95);
  el('p95').className = s.applyP95 < 4 ? 'ok' : 'bad';
  el('fhz').textContent = fmt(s.framesPerSecond, 1);
  el('moved').textContent = fmt(s.movedPerFrame, 0);
  el('count').textContent = String(s.points);
  overlay.reset();
}, 2000);
el('source').textContent = SOURCE;

kindSelect.addEventListener('change', () => {
  const v = kindSelect.value;
  kind = v === 'primitive' || v === 'icons' ? v : 'buffer';
  adapter.destroy();
  adapter = makeAdapter(kind);
  skipNext = true;
  overlay.reset();
  if (SOURCE === 'synthetic') synthetic.sendNow();
});

// ---------------------------------------------------------------------------------------------
// Picking: click a point; the overlay shows the id and how far (px) that entity is drawn from
// the click, so a wrong slot -> id mapping shows up as a large distance.

const scratch = new Cartesian3();
function screenOf(id: string): { x: number; y: number } | null {
  const f = latest;
  if (!f) return null;
  const slot = f.ids.indexOf(id);
  if (slot < 0 || slot >= f.count || f.visible[slot] !== 1) return null;
  const p = f.positions;
  const w = SceneTransforms.worldToWindowCoordinates(
    scene,
    Cartesian3.fromDegrees(p[slot * 3]!, p[slot * 3 + 1]!, p[slot * 3 + 2], undefined, scratch),
  );
  return w ? { x: w.x, y: w.y } : null;
}

const canvas = scene.canvas;
const clicks: { x: number; y: number; id: string | null; offsetPx: number | null }[] = [];
canvas.addEventListener('click', (ev) => {
  const r = canvas.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  const id = adapter.pick(x, y);
  const at = id ? screenOf(id) : null;
  const offsetPx = at ? Math.hypot(at.x - x, at.y - y) : null;
  clicks.push({ x, y, id, offsetPx });
  el('picked').textContent = id
    ? `${id} (${offsetPx === null ? '?' : offsetPx.toFixed(1)} px away)`
    : 'nothing';
});

// ---------------------------------------------------------------------------------------------
// Sources. `latest` is the frame most recently applied (synthetic only; mock frames' buffers go
// back to the worker after each call).

let latest: MapFrame | null = null;

/**
 * Local generator: N entities moving on great-circle-ish headings, UPS position updates per
 * second spread over HZ frames, CHURN of them removals (a new entity takes the freed slot in
 * the following frame, like the SDK's slot reuse rule). The first 200 slots are labelled.
 */
class Synthetic {
  readonly frame: MapFrame;
  private readonly heading: Float32Array;
  private readonly free: number[] = [];
  private readonly freedThisFrame: number[] = [];
  private nextId = 0;
  private budget = 0;
  private lastSend = performance.now();

  constructor(n: number) {
    this.frame = {
      layerId: LAYER,
      count: n,
      ids: Array.from({ length: n }, () => ''),
      positions: new Float64Array(n * 3),
      icons: new Uint16Array(n),
      visible: new Uint8Array(n),
      labels: new Map(),
    };
    this.heading = new Float32Array(n);
    for (let slot = 0; slot < n; slot++) this.spawn(slot);
  }

  private spawn(slot: number): void {
    const f = this.frame;
    const id = `plane-${this.nextId++}`;
    f.ids[slot] = id;
    f.positions[slot * 3] = Math.random() * 360 - 180;
    f.positions[slot * 3 + 1] = Math.asin(Math.random() * 2 - 1) * (180 / Math.PI) * 0.95;
    f.positions[slot * 3 + 2] = 10_000;
    f.icons[slot] = Math.random() < 0.8 ? 0 : 1;
    f.visible[slot] = 1;
    this.heading[slot] = Math.random() * Math.PI * 2;
    if (slot < 200) f.labels.set(slot, id);
  }

  /** Called before every render; sends a frame when one is due. */
  tick(now: number): void {
    if (now - this.lastSend < 1000 / HZ - 0.5) return;
    this.budget = Math.min(UPS, this.budget + (UPS * (now - this.lastSend)) / 1000);
    this.lastSend = now;
    const f = this.frame;
    // Slots freed in the previous frame may now be reused.
    for (const slot of this.free) this.spawn(slot);
    this.free.length = 0;
    for (; this.budget >= 1; this.budget--) {
      const slot = (Math.random() * f.count) | 0;
      if (f.visible[slot] !== 1) continue;
      if (Math.random() < CHURN) {
        f.visible[slot] = 0;
        f.ids[slot] = '';
        f.labels.delete(slot);
        this.freedThisFrame.push(slot);
        continue;
      }
      const h = this.heading[slot]!;
      const p = slot * 3;
      f.positions[p] = ((f.positions[p]! + 0.05 * Math.sin(h) + 540) % 360) - 180;
      f.positions[p + 1] = Math.max(-85, Math.min(85, f.positions[p + 1]! + 0.05 * Math.cos(h)));
    }
    for (const slot of this.freedThisFrame) this.free.push(slot);
    this.freedThisFrame.length = 0;
    this.sendNow();
  }

  sendNow(): void {
    latest = this.frame;
    timedApply(this.frame);
  }
}

const synthetic = new Synthetic(N);
let frozen = false;

if (SOURCE === 'synthetic') {
  scene.preUpdate.addEventListener(() => {
    if (!frozen) synthetic.tick(performance.now());
  });
  synthetic.sendNow();
} else {
  await startMock();
}

async function startMock(): Promise<void> {
  const mock = params.get('mock') ?? 'http://127.0.0.1:8090';
  const res = await fetch(`${mock}/dev/token`, { method: 'POST', body: '{}' });
  const body: unknown = await res.json();
  const token =
    typeof body === 'object' && body !== null ? (Reflect.get(body, 'token') as unknown) : null;
  if (typeof token !== 'string') throw new Error('mock server returned no token');
  const client = createAtlasClient({
    services: { '*': `${mock.replace(/^http/, 'ws')}/ws` },
    token,
    worker: () => new Worker(new URL('./sdk.worker.js', import.meta.url), { type: 'module' }),
  });
  const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
  view.subscribeMap(LAYER);
  client.onFrame((frame) => {
    if (frame.layerId === LAYER) timedApply(frame);
  });
}

// ---------------------------------------------------------------------------------------------

/** Ids drawn on the visible side of the globe, inside the canvas (for scripted pick checks). */
function visibleIds(max = 10, step = 97): { id: string; x: number; y: number }[] {
  const f = latest;
  const out: { id: string; x: number; y: number }[] = [];
  if (!f) return out;
  const cam = scene.camera.positionWC;
  for (let slot = 0; slot < f.count && out.length < max; slot += step) {
    const id = f.ids[slot];
    if (!id || f.visible[slot] !== 1) continue;
    const p = f.positions;
    const world = Cartesian3.fromDegrees(p[slot * 3]!, p[slot * 3 + 1]!, p[slot * 3 + 2]);
    // Facing the camera: the point's normal points towards the camera.
    if (Cartesian3.dot(world, Cartesian3.subtract(cam, world, new Cartesian3())) <= 0) continue;
    const at = screenOf(id);
    if (
      at &&
      at.x > 300 &&
      at.y > 20 &&
      at.x < canvas.clientWidth - 20 &&
      at.y < canvas.clientHeight - 20
    )
      out.push({ id, ...at });
  }
  return out;
}

const bench = {
  /** Measures for `seconds` from now (independent of the overlay's 2 s window). */
  measure: async (seconds = 10) => {
    const w = new StatWindow();
    windows.add(w);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    windows.delete(w);
    return w.summary();
  },
  setKind: (k: Kind) => {
    kindSelect.value = k;
    kindSelect.dispatchEvent(new Event('change'));
  },
  pick: (x: number, y: number) => adapter.pick(x, y),
  screenOf,
  visibleIds,
  clicks,
  /** Pauses updates (the synthetic source) so a scripted click hits a still point. */
  freeze: (on: boolean) => {
    frozen = on;
  },
};
Object.assign(window, { bench });
