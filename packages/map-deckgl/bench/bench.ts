/**
 * C-06 benchmark: 30,000 points updating 6,000 times per second through DeckGlAdapter on
 * MapLibre. Build and serve: `npm run bench -w @atlas/map-deckgl`, open http://127.0.0.1:5181/.
 *
 * Query parameters:
 *   n=30000        entities          rate=6000   position updates per second
 *   fps=10         frames per second (the SDK's FrameScheduler default)
 *   churn=50       removals + re-adds (new ids, reused slots) per second
 *   labels=200     labelled subset   icons=1     IconLayer instead of ScatterplotLayer
 *   style=demo     MapLibre demo tiles instead of a blank background
 *   live=1         frames from the mock server via the SDK (`npm run dev:mock -- --profile load`)
 *   mock=http://127.0.0.1:8090
 */
import { createAtlasClient, type MapFrame } from '@atlas/client-sdk';
import { Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import { DeckGlAdapter } from '../src/index.js';

const params = new URLSearchParams(location.search);
const num = (key: string, def: number): number => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : def;
};
const N = num('n', 30_000);
const RATE = num('rate', 6_000);
const FPS = num('fps', 10);
const CHURN = num('churn', 50);
const LABELS = num('labels', 200);
const ICONS = params.get('icons') === '1';
const LIVE = params.get('live') === '1';
const LAYER = 'planes';

const blank: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1015' } }],
};
const map = new MapLibreMap({
  container: 'map',
  style: params.get('style') === 'demo' ? 'https://demotiles.maplibre.org/style.json' : blank,
  center: [10, 30],
  zoom: 1.6,
  attributionControl: false,
});

// Time from deck.gl's beforeRender to afterRender: attribute upload plus draw.
const renderMs: number[] = [];
let renderStart = 0;
const adapter = new DeckGlAdapter(map, {
  overlayProps: {
    onBeforeRender: () => {
      renderStart = performance.now();
    },
    onAfterRender: () => {
      push(renderMs, performance.now() - renderStart);
    },
  },
});

const plane =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"><path fill="#4fc3f7" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>',
  );
adapter.createLayer(LAYER, {
  color: '#4fc3f7',
  pixelSize: 4,
  labelColor: '#ffe082',
  ...(ICONS ? { icons: [plane], iconSize: 14 } : {}),
});

// ---- measurement ---------------------------------------------------------------------------

const applyMs: number[] = [];
const fpsWindows: number[] = [];
let framesApplied = 0;
let updatesSent = 0;
let visibleCount = 0;
let picked = '-';

function push(arr: number[], v: number, max = 300): void {
  arr.push(v);
  if (arr.length > max) arr.shift();
}

function stats(arr: number[]): { avg: number; p95: number; max: number } {
  if (arr.length === 0) return { avg: 0, p95: 0, max: 0 };
  const sorted = arr.toSorted((a, b) => a - b);
  return {
    avg: arr.reduce((a, b) => a + b, 0) / arr.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    max: sorted[sorted.length - 1]!,
  };
}

function timedApply(frame: MapFrame): void {
  const t0 = performance.now();
  adapter.applyFrame(frame);
  push(applyMs, performance.now() - t0);
  framesApplied++;
  let v = 0;
  for (let i = 0; i < frame.count; i++) v += frame.visible[i]!;
  visibleCount = v;
}

let rafCount = 0;
let windowStart = performance.now();
const hud = document.getElementById('hud')!;
let lastFrames = 0;
let lastUpdates = 0;
function onRaf(now: number): void {
  rafCount++;
  if (now - windowStart >= 1000) {
    const secs = (now - windowStart) / 1000;
    push(fpsWindows, rafCount / secs, 120);
    const fps = rafCount / secs;
    const framesPerS = (framesApplied - lastFrames) / secs;
    const updatesPerS = (updatesSent - lastUpdates) / secs;
    lastFrames = framesApplied;
    lastUpdates = updatesSent;
    rafCount = 0;
    windowStart = now;
    const a = stats(applyMs);
    const r = stats(renderMs);
    const f = stats(fpsWindows.slice(-10));
    hud.textContent = [
      `${LIVE ? 'live (mock server)' : 'synthetic'} · ${ICONS ? 'IconLayer' : 'ScatterplotLayer'} · ${devicePixelRatio}x`,
      `FPS          ${fps.toFixed(1)}  (10 s avg ${f.avg.toFixed(1)}, min ${Math.min(...fpsWindows.slice(-10)).toFixed(1)})`,
      `applyFrame   avg ${a.avg.toFixed(2)} ms  p95 ${a.p95.toFixed(2)}  max ${a.max.toFixed(2)}`,
      `deck render  avg ${r.avg.toFixed(2)} ms  p95 ${r.p95.toFixed(2)}  max ${r.max.toFixed(2)}`,
      `frames/s     ${framesPerS.toFixed(1)}   updates/s ${LIVE ? '(server)' : updatesPerS.toFixed(0)}`,
      `visible      ${visibleCount}`,
      `picked       ${picked}`,
    ].join('\n');
  }
  requestAnimationFrame(onRaf);
}
requestAnimationFrame(onRaf);

map.on('click', (e) => {
  const t0 = performance.now();
  const id = adapter.pick(e.point.x, e.point.y);
  picked = `${id ?? 'none'} (${(performance.now() - t0).toFixed(1)} ms)`;
});

// Read by the benchmark harness (and handy from the console).
Object.assign(window, {
  __bench: {
    adapter,
    map,
    applyMs,
    renderMs,
    fpsWindows,
    reset() {
      applyMs.length = 0;
      renderMs.length = 0;
      fpsWindows.length = 0;
    },
    summary() {
      return {
        fps: stats(fpsWindows),
        fpsMin: Math.min(...fpsWindows),
        applyMs: stats(applyMs),
        renderMs: stats(renderMs),
        visible: visibleCount,
        framesApplied,
      };
    },
  },
});

// ---- frame sources -------------------------------------------------------------------------

if (LIVE) {
  const mock = params.get('mock') ?? 'http://127.0.0.1:8090';
  const res = await fetch(`${mock}/dev/token`, { method: 'POST', body: '{}' });
  const body: unknown = await res.json();
  const token =
    typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string'
      ? body.token
      : '';
  const client = createAtlasClient({
    services: { '*': `${mock.replace(/^http/, 'ws')}/ws` },
    token,
    worker: () => new Worker(new URL('./sdk.worker.js', import.meta.url), { type: 'module' }),
  });
  const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
  view.subscribeMap(LAYER);
  client.onFrame(timedApply);
  const camera = () => {
    const c = map.getCenter();
    client.setCamera({ lon: c.lng, lat: c.lat });
  };
  map.on('moveend', camera);
  camera();
} else {
  startSynthetic();
}

/** Same shape as the SDK's frames: stable slots, reused id table, hidden slots on removal. */
function startSynthetic(): void {
  const positions = new Float64Array(N * 3);
  const heading = new Float32Array(N);
  const icons = new Uint16Array(N);
  const visible = new Uint8Array(N);
  const ids: string[] = Array.from({ length: N }, () => '');
  const labels = new Map<number, string>();
  let seq = 0;
  let rnd = 0x9e3779b9;
  const random = (): number => {
    rnd ^= rnd << 13;
    rnd ^= rnd >>> 17;
    rnd ^= rnd << 5;
    return (rnd >>> 0) / 4294967296;
  };
  const spawn = (slot: number): void => {
    positions[slot * 3] = random() * 360 - 180;
    positions[slot * 3 + 1] = random() * 130 - 60;
    positions[slot * 3 + 2] = 9000 + random() * 3000;
    heading[slot] = random() * Math.PI * 2;
    visible[slot] = 1;
    ids[slot] = `ac-${++seq}`;
  };
  for (let s = 0; s < N; s++) spawn(s);
  const relabel = (): void => {
    labels.clear();
    for (let s = 0; s < N && labels.size < LABELS; s += Math.floor(N / Math.max(LABELS, 1)) || 1) {
      if (visible[s]) labels.set(s, ids[s]!.toUpperCase());
    }
  };
  relabel();
  const frame: MapFrame = { layerId: LAYER, count: N, ids, positions, icons, visible, labels };

  const perFrame = Math.round(RATE / FPS);
  const churnPerFrame = CHURN / FPS;
  let churnDebt = 0;
  const freed: number[] = [];
  timedApply(frame);
  setInterval(() => {
    for (let k = 0; k < perFrame; k++) {
      const s = Math.floor(random() * N);
      if (!visible[s]) continue;
      const h = heading[s]!;
      positions[s * 3] = ((positions[s * 3]! + Math.cos(h) * 0.05 + 540) % 360) - 180;
      positions[s * 3 + 1] = Math.max(
        -80,
        Math.min(80, positions[s * 3 + 1]! + Math.sin(h) * 0.05),
      );
    }
    updatesSent += perFrame;
    // Removal hides a slot and clears its id; the slot is reused (new id) a frame later, as in the SDK.
    for (const s of freed.splice(0)) spawn(s);
    churnDebt += churnPerFrame;
    for (; churnDebt >= 1; churnDebt--) {
      const s = Math.floor(random() * N);
      if (!visible[s]) continue;
      visible[s] = 0;
      ids[s] = '';
      freed.push(s);
    }
    relabel();
    timedApply(frame);
  }, 1000 / FPS);
}
