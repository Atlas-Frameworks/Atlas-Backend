import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { AuthStore } from './auth/auth.store';
import { ATLAS_CLIENT_FACTORY } from './realtime/atlas-client-factory';
import { FakeAtlasClient, IDLE } from './realtime/fake-atlas-client';

describe('routes', () => {
  let clients: FakeAtlasClient[];

  beforeEach(() => {
    clients = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
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
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('redirects / to /login without a token', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    expect(TestBed.inject(Router).url).toBe('/login');
    expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toContain('Atlas');
  });

  it('renders the workspace layout once signed in', async () => {
    TestBed.inject(AuthStore).signIn({ token: 't', scope: { countries: ['c1'] }, label: 'Chad' });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    const el = harness.routeNativeElement;
    expect(TestBed.inject(Router).url).toBe('/');
    expect(el?.querySelector('.top-bar')?.textContent).toContain('Chad');
    expect(el?.querySelector('section.map')).toBeTruthy();
    expect(el?.querySelector('#layers-panel')).toBeTruthy();
    expect(el?.querySelector('#detail-drawer')).toBeTruthy();
    expect(el?.querySelector('app-connection-status')?.textContent?.trim()).toBe('Not connected');

    // The top bar follows the SDK status through AtlasRealtimeService.
    clients[0]?.status.set({ ...IDLE, connection: 'open' });
    await harness.fixture.whenStable();
    expect(el?.querySelector('app-connection-status')?.textContent?.trim()).toBe('Live');
    clients[0]?.status.set({ ...IDLE, connection: 'reconnecting' });
    await harness.fixture.whenStable();
    expect(el?.querySelector('app-connection-status')?.textContent?.trim()).toBe('Reconnecting…');
  });

  it('serves the map bench placeholder without a token', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/dev/map-bench');
    expect(TestBed.inject(Router).url).toBe('/dev/map-bench');
    expect(harness.routeNativeElement?.textContent).toContain('Map benchmark');
  });
});
