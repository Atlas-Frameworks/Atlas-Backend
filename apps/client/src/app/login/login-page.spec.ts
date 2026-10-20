import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthStore } from '../auth/auth.store';
import { ATLAS_ENV } from '../config/environment';
import { LoginPage } from './login-page';

const SCOPES = {
  countries: [
    { id: 'c-1', code: 'FR', name: 'France', region: 'Europe' },
    { id: 'c-2', code: 'JP', name: 'Japan', region: 'Asia' },
  ],
  connections: [{ id: 'k-1', name: 'Pacific link', countryIds: ['c-2'], criteria: {} }],
};

async function render() {
  const fixture = TestBed.createComponent(LoginPage);
  await fixture.whenStable();
  const el: HTMLElement = fixture.nativeElement;
  return { fixture, el };
}

function click(el: Element | null) {
  if (!(el instanceof HTMLElement)) throw new Error('missing element');
  el.click();
}

describe('LoginPage', () => {
  let calls: { url: string; init: RequestInit | undefined }[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const body = url.endsWith('/dev/scopes') ? SCOPES : { token: 'jwt-123' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        {
          provide: ATLAS_ENV,
          useValue: { services: { '*': 'ws://x/ws' }, devApiUrl: 'http://dev', registryUrl: '' },
        },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists countries and connections from GET /dev/scopes', async () => {
    const { fixture, el } = await render();
    expect(calls[0]?.url).toBe('http://dev/dev/scopes');
    expect(el.querySelectorAll('ul[aria-label="Countries"] li')).toHaveLength(2);
    click(el.querySelector('input[value="connection"]'));
    await fixture.whenStable();
    expect(el.querySelector('ul[aria-label="Connections"]')?.textContent).toContain('Pacific link');
  });

  it('signs in with several countries and keeps the token in memory only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { fixture, el } = await render();
    const submit = el.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    for (const box of el.querySelectorAll('ul[aria-label="Countries"] input')) click(box);
    await fixture.whenStable();
    expect(submit?.disabled).toBe(false);
    click(submit);
    await vi.waitFor(() => expect(TestBed.inject(AuthStore).token()).toBe('jwt-123'));

    const post = calls[1];
    expect(post?.url).toBe('http://dev/dev/token');
    expect(post?.init?.method).toBe('POST');
    expect(post?.init?.body).toBe(JSON.stringify({ countries: ['c-1', 'c-2'] }));
    expect(TestBed.inject(AuthStore).session()).toEqual({
      token: 'jwt-123',
      scope: { countries: ['c-1', 'c-2'] },
      label: '2 countries',
    });
    expect(setItem).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/'));
  });

  it('signs in with a connection', async () => {
    const { fixture, el } = await render();
    click(el.querySelector('input[value="connection"]'));
    await fixture.whenStable();
    click(el.querySelector('ul[aria-label="Connections"] input'));
    await fixture.whenStable();
    click(el.querySelector('button[type="submit"]'));
    await vi.waitFor(() =>
      expect(TestBed.inject(AuthStore).session()?.scope).toEqual({ connectionId: 'k-1' }),
    );
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ connectionId: 'k-1' }));
    expect(TestBed.inject(AuthStore).session()?.label).toBe('Pacific link');
  });
});
