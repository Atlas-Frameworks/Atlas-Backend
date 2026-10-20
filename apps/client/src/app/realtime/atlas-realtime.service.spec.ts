import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterEveryRender,
  effect,
  inject,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MapAdapter, MapFrame } from '@atlas/client-sdk';
import { AuthStore } from '../auth/auth.store';
import { ATLAS_ENV } from '../config/environment';
import { ATLAS_CLIENT_FACTORY } from './atlas-client-factory';
import { AtlasRealtimeService } from './atlas-realtime.service';
import { FakeAtlasClient, IDLE, mapFrame, pageState } from './fake-atlas-client';

const SERVICES = { '*': 'ws://fake/ws' };

let clients: FakeAtlasClient[];

function setup(): AtlasRealtimeService {
  clients = [];
  TestBed.configureTestingModule({
    providers: [
      { provide: ATLAS_ENV, useValue: { services: SERVICES, devApiUrl: '', registryUrl: '' } },
      {
        provide: ATLAS_CLIENT_FACTORY,
        useValue: (config: FakeAtlasClient['config']) => {
          const c = new FakeAtlasClient(config);
          clients.push(c);
          return c;
        },
      },
    ],
  });
  TestBed.inject(AuthStore).signIn({ token: 'jwt-1', scope: { countries: ['c1'] }, label: 'c1' });
  return TestBed.inject(AtlasRealtimeService);
}

function client(): FakeAtlasClient {
  const c = clients.at(-1);
  if (!c) throw new Error('no client created');
  return c;
}

/** Destroyed at the end of each test that uses it, like a component's DestroyRef. */
function lifetime(): { destroyRef: DestroyRef; destroy: () => void } {
  const callbacks = new Set<() => void>();
  const destroyRef: DestroyRef = {
    destroyed: false,
    onDestroy: (cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
  };
  return { destroyRef, destroy: () => [...callbacks].forEach((cb) => cb()) };
}

describe('AtlasRealtimeService', () => {
  it('creates one client lazily with the configured services and session token', () => {
    const rt = setup();
    expect(clients).toHaveLength(0);
    const { destroyRef } = lifetime();
    rt.openView({ entityType: 'airplanes' }, { destroyRef });
    rt.openDetail('airplanes', 'a1', { destroyRef });
    expect(clients).toHaveLength(1);
    expect(client().config).toEqual({ services: SERVICES, token: 'jwt-1' });
    expect(client().views[0]?.spec).toEqual({
      entityType: 'airplanes',
      scope: { countries: ['c1'] },
    });
  });

  it('mirrors status into connectionStatus, staleSince, stale and lastError', () => {
    const rt = setup();
    rt.openView({ entityType: 'airplanes' }, lifetime());
    expect(rt.connectionStatus()).toBe('idle');
    client().status.set({ ...IDLE, connection: 'open' });
    expect(rt.connectionStatus()).toBe('open');
    expect(rt.stale()).toBe(false);
    const error = { code: 'TRANSPORT', message: 'closed', at: 5 };
    client().status.set({
      ...IDLE,
      connection: 'reconnecting',
      staleSince: 1234,
      lastError: error,
    });
    expect(rt.connectionStatus()).toBe('reconnecting');
    expect(rt.staleSince()).toBe(1234);
    expect(rt.stale()).toBe(true);
    expect(rt.lastError()).toEqual(error);
  });

  it('page signals follow the SDK; dispose closes the subscription and stops updates', () => {
    const rt = setup();
    const { destroyRef } = lifetime();
    const view = rt.openView({ entityType: 'airplanes' }, { destroyRef });
    const page = rt.subscribePage(view, { pageSize: 20 }, { destroyRef });
    const fake = client().views[0]?.pages[0];
    if (!fake) throw new Error('no page');
    expect(fake.options).toEqual({ pageSize: 20 });
    expect(page.loading()).toBe(true);
    expect(page.rows()).toEqual([]);

    const row = { id: 'a1', version: 1, fields: { callsign: 'AT1' }, nested: {} };
    fake.store.set(
      pageState({ rows: [row], total: 321, groupCounts: [{ groupPath: ['x'], count: 3 }] }),
    );
    expect(page.loading()).toBe(false);
    expect(page.total()).toBe(321);
    expect(page.rows()).toEqual([row]);
    expect(page.groupCounts()).toEqual([{ groupPath: ['x'], count: 3 }]);
    fake.store.set(pageState({ total: 321, stale: true, staleSince: 9 }));
    expect(page.stale()).toBe(true);

    expect(fake.store.listenerCount).toBe(1);
    page.dispose();
    expect(fake.closed).toBe(true);
    expect(fake.store.listenerCount).toBe(0);
    fake.store.set(pageState({ total: 999 }));
    expect(page.total()).toBe(321);
    page.dispose(); // idempotent
  });

  it('detail and view-error signals follow the SDK; dispose closes them', () => {
    const rt = setup();
    const { destroyRef } = lifetime();
    const view = rt.openView({ entityType: 'airplanes' }, { destroyRef });
    const detail = rt.openDetail('airplanes', 'a1', { destroyRef });
    const fakeDetail = client().details[0];
    const fakeView = client().views[0];
    if (!fakeDetail || !fakeView) throw new Error('missing');

    const row = { id: 'a1', version: 2, fields: {}, nested: {} };
    const base = {
      entityType: 'airplanes',
      id: 'a1',
      loading: false,
      stale: false,
      staleSince: null,
    };
    fakeDetail.store.set({ ...base, row, removed: false });
    expect(detail.row()).toEqual(row);
    fakeDetail.store.set({ ...base, row: null, removed: true });
    expect(detail.removed()).toBe(true);

    const err = { code: 'INVALID_FILTER', message: 'bad field', at: 1 };
    fakeView.error.set(err);
    expect(view.error()).toEqual(err);

    detail.dispose();
    view.dispose();
    expect(fakeDetail.closed).toBe(true);
    expect(fakeView.closed).toBe(true);
    expect(fakeDetail.store.listenerCount).toBe(0);
    expect(fakeView.error.listenerCount).toBe(0);
  });

  it('disposing a view disposes its pages', () => {
    const rt = setup();
    const { destroyRef } = lifetime();
    const view = rt.openView({ entityType: 'airplanes' }, { destroyRef });
    rt.subscribePage(view, {}, { destroyRef });
    rt.subscribePage(view, { page: 1 }, { destroyRef });
    view.dispose();
    const pages = client().views[0]?.pages ?? [];
    expect(pages.map((p) => [p.closed, p.store.listenerCount])).toEqual([
      [true, 0],
      [true, 0],
    ]);
  });

  it('cleans up through the DestroyRef', () => {
    const rt = setup();
    const life = lifetime();
    const view = rt.openView({ entityType: 'airplanes' }, life);
    rt.subscribePage(view, {}, life);
    rt.openDetail('airplanes', 'a1', life);
    life.destroy();
    expect(client().views[0]?.closed).toBe(true);
    expect(client().views[0]?.pages[0]?.closed).toBe(true);
    expect(client().details[0]?.closed).toBe(true);
  });

  it('forwards token changes and destroys the client on sign-out', () => {
    const rt = setup();
    rt.openView({ entityType: 'airplanes' }, lifetime());
    client().status.set({ ...IDLE, connection: 'open' });
    const auth = TestBed.inject(AuthStore);
    auth.signIn({ token: 'jwt-2', scope: { countries: ['c1'] }, label: 'c1' });
    TestBed.tick();
    expect(client().tokens).toEqual(['jwt-2']);
    auth.signOut();
    TestBed.tick();
    expect(client().destroyed).toBe(true);
    expect(rt.connectionStatus()).toBe('idle');
  });
});

// -------------------------------------------------------------------------------------------
// Map frames must not cause change detection (A-02 acceptance; Angular DevTools can't run here).
// -------------------------------------------------------------------------------------------

@Component({
  selector: 'app-host',
  template: `{{ rt.connectionStatus() }} {{ page.total() }}`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly rt = inject(AtlasRealtimeService);
  readonly view = this.rt.openView({ entityType: 'airplanes' });
  readonly page = this.rt.subscribePage(this.view);
  renders = 0;
  effectRuns = 0;
  framesSeen = 0;

  constructor() {
    afterEveryRender(() => this.renders++);
    effect(() => {
      // Reads every public signal of the service and the page.
      this.rt.status();
      this.rt.staleSince();
      this.rt.lastError();
      this.page.state();
      this.effectRuns++;
    });
    const adapter: MapAdapter = {
      createLayer: () => undefined,
      applyFrame: (frame: MapFrame) => {
        this.framesSeen += frame.count > 0 ? 1 : 0;
      },
      pick: () => null,
      destroy: () => undefined,
    };
    inject(DestroyRef).onDestroy(this.rt.attachMap(adapter));
  }
}

describe('map frames and change detection', () => {
  it('runs no change detection and no effects per map frame', async () => {
    setup();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const host = fixture.componentInstance;
    const rendersBefore = host.renders;
    const effectsBefore = host.effectRuns;
    expect(rendersBefore).toBeGreaterThan(0);

    // 1,000 frames of 30,000 points, spread over macrotasks like Worker messages.
    const frame = mapFrame(30_000);
    for (let batch = 0; batch < 100; batch++) {
      for (let i = 0; i < 10; i++) client().emitFrame(frame);
      await new Promise((r) => setTimeout(r, 0));
    }
    await fixture.whenStable();

    expect(host.framesSeen).toBe(1_000);
    expect(host.renders).toBe(rendersBefore);
    expect(host.effectRuns).toBe(effectsBefore);

    // Control: a status update (a signal) does render, so the counters work.
    client().status.set({ ...IDLE, connection: 'open' });
    client().views[0]?.pages[0]?.store.set(pageState({ total: 42 }));
    await fixture.whenStable();
    expect(host.renders).toBeGreaterThan(rendersBefore);
    expect(host.effectRuns).toBeGreaterThan(effectsBefore);
    expect(fixture.nativeElement.textContent).toContain('open 42');

    fixture.destroy();
    expect(client().frameListeners.size).toBe(0);
    expect(client().views[0]?.closed).toBe(true);
  });
});
