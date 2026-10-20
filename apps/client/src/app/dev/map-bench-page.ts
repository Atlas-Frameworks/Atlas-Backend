import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { SyntheticFrames } from '@atlas/client-sdk/testing';
import { ATLAS_ENV } from '../config/environment';
import type { MapEngine } from '../map/map-engine';

/** Which adapter draws the benchmark. `cesium-primitive` is CesiumAdapter's PointPrimitiveCollection. */
export type BenchAdapter = 'cesium' | 'cesium-primitive' | 'deckgl';
const ADAPTERS: readonly BenchAdapter[] = ['cesium', 'cesium-primitive', 'deckgl'];

const LAYER = 'bench';
const ENTITIES = 30_000;
const UPDATES_PER_SECOND = 6_000;
/** The SDK frame scheduler's default rate. */
const FRAMES_PER_SECOND = 10;

export interface BenchSummary {
  adapter: BenchAdapter;
  seconds: number;
  /** Page frames per second (requestAnimationFrame), i.e. how smooth the page is. */
  fps: number;
  /** Map renders per second (Cesium renders every frame here; deck.gl renders on change). */
  mapRendersPerSecond: number;
  framesPerSecond: number;
  applyP50: number;
  applyP95: number;
  applyMax: number;
}

/** Measurements over a window: rAF ticks, map renders and applyFrame times. */
class StatWindow {
  private static readonly SAMPLES = 4096;
  private readonly applyMs = new Float64Array(StatWindow.SAMPLES);
  private applies = 0;
  rafs = 0;
  renders = 0;
  private readonly since = performance.now();

  apply(ms: number): void {
    this.applyMs[this.applies++ % StatWindow.SAMPLES] = ms;
  }

  summary(adapter: BenchAdapter): BenchSummary {
    const seconds = (performance.now() - this.since) / 1000;
    const n = Math.min(this.applies, StatWindow.SAMPLES);
    const sorted = this.applyMs.slice(0, n).toSorted();
    const pct = (p: number) =>
      n === 0 ? Number.NaN : sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
    return {
      adapter,
      seconds,
      fps: this.rafs / seconds,
      mapRendersPerSecond: this.renders / seconds,
      framesPerSecond: this.applies / seconds,
      applyP50: pct(50),
      applyP95: pct(95),
      applyMax: n === 0 ? Number.NaN : sorted[n - 1],
    };
  }
}

/**
 * C-05 / C-06 benchmark inside the app: 30,000 synthetic points with 6,000 position updates per
 * second at 10 frames per second, drawn by the Cesium or the deck.gl adapter (switchable at run
 * time, `?adapter=cesium|cesium-primitive|deckgl`). The HUD shows FPS and `applyFrame` time;
 * `await mapBench.measure(15)` returns them for scripted runs. No backend needed.
 */
@Component({
  selector: 'app-map-bench-page',
  template: `
    <div #map class="map"></div>
    <section class="hud" aria-labelledby="bench-title">
      <h1 id="bench-title">Map benchmark</h1>
      <label>
        Adapter
        <select (change)="onSelect($event)">
          @for (a of adapters; track a) {
            <option [value]="a" [selected]="a === adapter()">{{ a }}</option>
          }
        </select>
      </label>
      <dl>
        <dt>Points</dt>
        <dd>{{ entities }} · {{ updatesPerSecond }} upd/s · {{ framesPerSecond }} frames/s</dd>
        <dt>FPS</dt>
        <dd [class.bad]="(hud()?.fps ?? 60) < 50">{{ fmt(hud()?.fps, 1) }}</dd>
        <dt>Map renders/s</dt>
        <dd>{{ fmt(hud()?.mapRendersPerSecond, 1) }}</dd>
        <dt>applyFrame p50 / p95 / max</dt>
        <dd [class.bad]="(hud()?.applyP95 ?? 0) >= 4">
          {{ fmt(hud()?.applyP50) }} / {{ fmt(hud()?.applyP95) }} / {{ fmt(hud()?.applyMax) }} ms
        </dd>
        <dt>Picked</dt>
        <dd>{{ picked() }}</dd>
      </dl>
      @if (error(); as e) {
        <p class="error" role="alert">{{ e }}</p>
      }
    </section>
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      height: 100%;
      background: var(--atlas-map-bg);
    }

    .map {
      position: absolute;
      inset: 0;
      z-index: 0; /* own stacking context: the map's canvases stay under the HUD */
    }

    .hud {
      position: absolute;
      top: var(--atlas-space-3);
      left: var(--atlas-space-3);
      z-index: 1;
      min-width: 18rem;
      padding: var(--atlas-space-3);
      font-family: var(--atlas-font-mono);
      font-size: var(--atlas-font-sm);
      color: var(--atlas-text);
      background: var(--atlas-surface-overlay);
      border-radius: var(--atlas-radius);
    }

    h1 {
      margin: 0 0 var(--atlas-space-2);
      font-size: var(--atlas-font-md);
      color: var(--atlas-text-strong);
    }

    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--atlas-space-1) var(--atlas-space-3);
      margin: var(--atlas-space-2) 0 0;
    }

    dt {
      color: var(--atlas-text-muted);
    }

    dd {
      margin: 0;
      color: var(--atlas-ok);
    }

    dd.bad {
      color: var(--atlas-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapBenchPage {
  private readonly basemap = inject(ATLAS_ENV).basemap;
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('map');

  protected readonly adapters = ADAPTERS;
  protected readonly entities = ENTITIES;
  protected readonly updatesPerSecond = UPDATES_PER_SECOND;
  protected readonly framesPerSecond = FRAMES_PER_SECOND;
  protected readonly adapter = signal<BenchAdapter>(initialAdapter());
  /** Refreshed once per second (not per frame). */
  protected readonly hud = signal<BenchSummary | null>(null);
  protected readonly picked = signal('–');
  protected readonly error = signal<string | null>(null);

  private engine: MapEngine | null = null;
  private offEngine: (() => void) | null = null;
  private loading = 0;
  private readonly source = new SyntheticFrames({
    layerId: LAYER,
    entities: ENTITIES,
    updatesPerSecond: UPDATES_PER_SECOND,
  });
  private windows = new Set<StatWindow>();
  private hudWindow = new StatWindow();
  /** The first frame after an engine starts creates every point; it is not measured. */
  private skipNext = true;

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.windows.add(this.hudWindow);

    afterNextRender(() => {
      void this.switchTo(this.adapter());
      let last = performance.now();
      const frames = setInterval(() => {
        const now = performance.now();
        this.source.step(now - last);
        last = now;
        this.apply();
      }, 1000 / FRAMES_PER_SECOND);
      let raf = 0;
      const tick = () => {
        for (const w of this.windows) w.rafs++;
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      const hud = setInterval(() => {
        this.hud.set(this.hudWindow.summary(this.adapter()));
        this.windows.delete(this.hudWindow);
        this.hudWindow = new StatWindow();
        this.windows.add(this.hudWindow);
      }, 1000);
      destroyRef.onDestroy(() => {
        clearInterval(frames);
        clearInterval(hud);
        cancelAnimationFrame(raf);
        this.stopEngine();
      });
    });

    Object.assign(globalThis, {
      mapBench: {
        /** Measures for `seconds` from now. */
        measure: async (seconds = 15): Promise<BenchSummary> => {
          const w = new StatWindow();
          this.windows.add(w);
          await new Promise((r) => setTimeout(r, seconds * 1000));
          this.windows.delete(w);
          return w.summary(this.adapter());
        },
        setAdapter: (a: BenchAdapter) => this.switchTo(a),
      },
    });
    destroyRef.onDestroy(() => Reflect.deleteProperty(globalThis, 'mapBench'));
  }

  protected fmt(v: number | undefined, digits = 2): string {
    return v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);
  }

  protected onSelect(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    const adapter = ADAPTERS.find((a) => a === value);
    if (adapter) void this.switchTo(adapter);
  }

  /** Replaces the map and adapter; the synthetic source keeps running. */
  protected async switchTo(adapter: BenchAdapter): Promise<void> {
    const ticket = ++this.loading;
    this.adapter.set(adapter);
    this.error.set(null);
    this.stopEngine();
    let engine: MapEngine;
    try {
      engine = await this.createEngine(adapter);
    } catch (error: unknown) {
      console.error('map-bench: failed to create the map', error);
      this.error.set(`${adapter}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (ticket !== this.loading) {
      engine.destroy();
      return;
    }
    engine.adapter.createLayer(LAYER, { color: '#4fc3f7', pixelSize: 4, labelColor: '#ffe082' });
    const offRender = engine.onRender(() => {
      for (const w of this.windows) w.renders++;
    });
    const offClick = engine.onClick((x, y) =>
      this.picked.set(engine.adapter.pick(x, y) ?? 'nothing'),
    );
    this.offEngine = () => {
      offRender();
      offClick();
    };
    this.engine = engine;
    this.skipNext = true;
    this.apply();
  }

  private async createEngine(adapter: BenchAdapter): Promise<MapEngine> {
    const container = this.container().nativeElement;
    if (adapter === 'deckgl') {
      const { createDeckGlEngine } = await import('./deckgl-engine');
      return createDeckGlEngine(container, this.basemap.baseColor);
    }
    const { createCesiumEngine } = await import('../map/cesium-engine');
    return createCesiumEngine(container, {
      basemap: this.basemap,
      // Render every animation frame, so FPS measures what the GPU and main thread sustain.
      requestRenderMode: false,
      points: adapter === 'cesium' ? 'buffer' : 'primitive',
    });
  }

  private apply(): void {
    const engine = this.engine;
    if (!engine) return;
    const t0 = performance.now();
    engine.adapter.applyFrame(this.source.frame);
    const ms = performance.now() - t0;
    if (this.skipNext) {
      this.skipNext = false;
      console.info(`map-bench ${this.adapter()}: first full applyFrame ${ms.toFixed(1)} ms`);
      return;
    }
    for (const w of this.windows) w.apply(ms);
  }

  private stopEngine(): void {
    this.offEngine?.();
    this.offEngine = null;
    this.engine?.destroy();
    this.engine = null;
  }
}

function initialAdapter(): BenchAdapter {
  const a = new URLSearchParams(location.search).get('adapter');
  return ADAPTERS.find((x) => x === a) ?? 'cesium';
}
