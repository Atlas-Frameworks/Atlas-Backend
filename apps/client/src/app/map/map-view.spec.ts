import {
  ChangeDetectionStrategy,
  Component,
  afterEveryRender,
  effect,
  inject,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Camera, MapAdapter, MapFrame } from '@atlas/client-sdk';
import { AuthStore } from '../auth/auth.store';
import { ATLAS_ENV } from '../config/environment';
import { ATLAS_CLIENT_FACTORY } from '../realtime/atlas-client-factory';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import type { LiveView } from '../realtime/atlas-realtime.service';
import { FakeAtlasClient, IDLE, mapFrame } from '../realtime/fake-atlas-client';
import { WorkspaceStore } from '../workspace/workspace.store';
import { MAP_ENGINE_FACTORY } from './map-engine';
import type { EntityLocation, MapEngine } from './map-engine';
import { MapView, throttle } from './map-view';

/** Records what MapView asks of the map; tests drive camera moves and clicks. */
class FakeEngine implements MapEngine {
  readonly created: string[] = [];
  readonly applied: MapFrame[] = [];
  readonly flights: [number, number][] = [];
  readonly locations = new Map<string, EntityLocation>();
  pickResult: string | null = null;
  destroyed = false;
  camera: ((c: Camera) => void) | null = null;
  click: ((x: number, y: number) => void) | null = null;

  readonly adapter: MapAdapter = {
    createLayer: (layerId) => this.created.push(layerId),
    applyFrame: (frame) => this.applied.push(frame),
    pick: () => this.pickResult,
    destroy: () => undefined,
  };

  locate(id: string, layerId?: string): EntityLocation | null {
    const at = this.locations.get(id);
    return at && (layerId === undefined || at.layerId === layerId) ? at : null;
  }

  flyTo(lon: number, lat: number): void {
    this.flights.push([lon, lat]);
  }

  onCameraChange(listener: (c: Camera) => void): () => void {
    this.camera = listener;
    return () => (this.camera = null);
  }

  onClick(listener: (x: number, y: number) => void): () => void {
    this.click = listener;
    return () => (this.click = null);
  }

  onRender(): () => void {
    return () => undefined;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

@Component({
  selector: 'app-host',
  imports: [MapView],
  template: '<app-map-view />',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly store = inject(WorkspaceStore);
  readonly rt = inject(AtlasRealtimeService);
  renders = 0;
  effectRuns = 0;

  constructor() {
    afterEveryRender(() => this.renders++);
    effect(() => {
      this.store.views();
      this.store.selected();
      this.rt.status();
      this.effectRuns++;
    });
  }
}

let engine: FakeEngine;
let client: FakeAtlasClient;
const mapSubs: { layerId: string; closed: boolean }[] = [];
const cameras: (Camera | null)[] = [];
const selections: (string | null)[] = [];

async function setup() {
  engine = new FakeEngine();
  mapSubs.length = 0;
  cameras.length = 0;
  selections.length = 0;
  TestBed.configureTestingModule({
    providers: [
      {
        provide: ATLAS_ENV,
        useValue: {
          services: { '*': 'ws://fake/ws' },
          devApiUrl: '',
          registryUrl: '',
          basemap: { url: null, baseColor: '#000' },
        },
      },
      {
        provide: ATLAS_CLIENT_FACTORY,
        useValue: (config: FakeAtlasClient['config']) => (client = new FakeAtlasClient(config)),
      },
      { provide: MAP_ENGINE_FACTORY, useValue: () => Promise.resolve(engine) },
    ],
  });
  TestBed.inject(AuthStore).signIn({ token: 't', scope: { countries: [] }, label: 'all' });
  const rt = TestBed.inject(AtlasRealtimeService);
  vi.spyOn(rt, 'subscribeMap').mockImplementation((_view: LiveView, layerId?: string) => {
    const sub = { layerId: layerId ?? '', closed: false };
    mapSubs.push(sub);
    return { layerId: sub.layerId, close: () => (sub.closed = true) };
  });
  vi.spyOn(rt, 'setCamera').mockImplementation((c) => cameras.push(c));
  vi.spyOn(rt, 'setSelected').mockImplementation((id) => selections.push(id));
  const store = TestBed.inject(WorkspaceStore);
  const view = (entityType: string) =>
    TestBed.runInInjectionContext(() => rt.openView({ entityType }));
  const planes = view('airplanes');
  store.views.set([planes]);

  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  await fixture.whenStable(); // engine promise -> layers
  return { fixture, store, rt, planes, view };
}

describe('MapView', () => {
  it('subscribes one map layer per view and drops layers of removed views', async () => {
    const { fixture, store, planes, view } = await setup();
    const id = planes.handle.id;
    expect(engine.created).toEqual([id]);
    expect(mapSubs).toEqual([{ layerId: id, closed: false }]);
    expect(client.frameListeners.size).toBe(1);

    const airports = view('airports');
    store.views.set([planes, airports]);
    await fixture.whenStable();
    expect(engine.created).toEqual([id, airports.handle.id]);

    store.views.set([airports]);
    await fixture.whenStable();
    expect(mapSubs[0]?.closed).toBe(true);
    // The removed layer is emptied (hidden).
    expect(engine.applied.at(-1)).toMatchObject({ layerId: id, count: 0 });

    fixture.destroy();
    expect(mapSubs[1]?.closed).toBe(true);
    expect(client.frameListeners.size).toBe(0);
    expect(engine.destroyed).toBe(true);
  });

  it('applies frames without change detection or effects', async () => {
    const { fixture } = await setup();
    const host = fixture.componentInstance;
    const renders = host.renders;
    const effects = host.effectRuns;
    const frame = mapFrame(30_000);
    for (let batch = 0; batch < 50; batch++) {
      for (let i = 0; i < 10; i++) client.emitFrame(frame);
      await new Promise((r) => setTimeout(r, 0));
    }
    await fixture.whenStable();
    expect(engine.applied.filter((f) => f === frame)).toHaveLength(500);
    expect(host.renders).toBe(renders);
    expect(host.effectRuns).toBe(effects);

    // Control: a status signal does render.
    client.status.set({ ...IDLE, connection: 'open' });
    await fixture.whenStable();
    expect(host.renders).toBeGreaterThan(renders);
  });

  it('selects a clicked entity with its view type and labels it', async () => {
    const { fixture, store, planes } = await setup();
    engine.pickResult = 'AF123';
    engine.locations.set('AF123', { layerId: planes.handle.id, lon: 2, lat: 48, alt: 0 });
    engine.click?.(10, 20);
    await fixture.whenStable();
    expect(store.selected()).toEqual({ entityType: 'airplanes', id: 'AF123' });
    expect(store.drawerOpen()).toBe(true);
    expect(selections.at(-1)).toBe('AF123');

    engine.pickResult = null;
    engine.click?.(1, 1);
    await fixture.whenStable();
    expect(store.selected()?.id).toBe('AF123');
  });

  it('sends the camera to the SDK, throttled', async () => {
    await setup();
    engine.camera?.({ lon: 1, lat: 2, height: 3 });
    engine.camera?.({ lon: 4, lat: 5, height: 6 });
    expect(cameras).toEqual([{ lon: 1, lat: 2, height: 3 }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(cameras.at(-1)).toEqual({ lon: 4, lat: 5, height: 6 });
  });

  it('flies to a requested entity once it is on the map', async () => {
    const { fixture, store, planes } = await setup();
    store.requestFlyTo({ entityType: 'airplanes', id: 'LY1' });
    await fixture.whenStable();
    expect(engine.flights).toEqual([]);

    engine.locations.set('LY1', { layerId: planes.handle.id, lon: 34.8, lat: 32, alt: 9000 });
    client.emitFrame(mapFrame(1));
    expect(engine.flights).toEqual([[34.8, 32]]);
    client.emitFrame(mapFrame(1));
    expect(engine.flights).toHaveLength(1);
  });

  it('shows the stale overlay while reconnecting or stale', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.stale')).toBeNull();
    client.status.set({ ...IDLE, connection: 'reconnecting' });
    await fixture.whenStable();
    expect(el.querySelector('.stale')?.textContent).toContain('Reconnecting');
    client.status.set({ ...IDLE, connection: 'open', staleSince: Date.now() });
    await fixture.whenStable();
    expect(el.querySelector('.stale')?.textContent).toContain('Stale since');
    client.status.set({ ...IDLE, connection: 'open' });
    await fixture.whenStable();
    expect(el.querySelector('.stale')).toBeNull();
  });
});

describe('throttle', () => {
  it('passes the first call, then the latest value once per interval', () => {
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      const t = throttle((v: number) => seen.push(v), 250);
      t.call(1);
      t.call(2);
      t.call(3);
      expect(seen).toEqual([1]);
      vi.advanceTimersByTime(250);
      expect(seen).toEqual([1, 3]);
      t.call(4);
      t.cancel();
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual([1, 3]);
    } finally {
      vi.useRealTimers();
    }
  });
});
