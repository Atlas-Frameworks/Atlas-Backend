import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { AuthStore } from './auth/auth.store';

describe('routes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
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
    expect(el?.querySelector('app-connection-status')).toBeTruthy();
  });

  it('serves the map bench placeholder without a token', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/dev/map-bench');
    expect(TestBed.inject(Router).url).toBe('/dev/map-bench');
    expect(harness.routeNativeElement?.textContent).toContain('Map benchmark');
  });
});
