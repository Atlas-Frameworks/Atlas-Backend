import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type {
  LocateAnswer,
  PageHandle,
  PageOptions,
  ViewHandle,
  ViewSpec,
} from '@atlas/client-sdk';
import { AuthStore } from '../auth/auth.store';
import { ATLAS_ENV } from '../config/environment';
import { ATLAS_CLIENT_FACTORY } from '../realtime/atlas-client-factory';
import { FakeAtlasClient, pageState } from '../realtime/fake-atlas-client';
import { WorkspaceStore } from '../workspace/workspace.store';
import { emptyGroup, newCondition } from './filter-model';
import { LayersPanel } from './layers-panel';
import { parseRegistry, RegistryApi } from './registry';

const REGISTRY = parseRegistry({
  types: [
    {
      type: 'airplanes',
      label: 'Airplanes',
      map: true,
      defaultSort: 'callsign',
      fields: [
        {
          name: 'callsign',
          label: 'Callsign',
          type: 'string',
          ops: ['eq', 'contains'],
          sortable: true,
        },
        {
          name: 'airline',
          label: 'Airline',
          type: 'string',
          ops: ['eq'],
          groupable: true,
          sortable: true,
        },
      ],
    },
    { type: 'airports', label: 'Airports', map: true, defaultSort: 'iata', fields: [] },
  ],
});

interface PageCall {
  options: PageOptions | undefined;
  freeze: boolean[];
  pages: number[];
  locates: { id: string; jump: boolean | undefined }[];
}

/** The fake SDK, also recording what the panel does with page handles. */
class SpyClient extends FakeAtlasClient {
  readonly pageCalls: PageCall[] = [];
  locateAnswer: LocateAnswer = { found: false, groupPath: [], page: 0 };
  readonly viewLocates: string[] = [];

  override openView(spec: ViewSpec): ViewHandle {
    const h = super.openView(spec);
    return {
      ...h,
      locate: (id) => {
        this.viewLocates.push(id);
        return Promise.resolve(this.locateAnswer);
      },
      subscribePage: (options) => {
        const p = h.subscribePage(options);
        const call: PageCall = { options, freeze: [], pages: [], locates: [] };
        this.pageCalls.push(call);
        const spy: PageHandle = {
          ...p,
          subscribe: (l) => p.subscribe(l),
          getSnapshot: () => p.getSnapshot(),
          setFreezeOrder: (f) => call.freeze.push(f),
          setPage: (n) => call.pages.push(n),
          locate: (id, o) => {
            call.locates.push({ id, jump: o?.jump });
            return Promise.resolve(this.locateAnswer);
          },
        };
        return spy;
      },
    };
  }
}

let client: SpyClient;

async function setup(): Promise<{ fixture: ComponentFixture<LayersPanel>; el: HTMLElement }> {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: ATLAS_ENV,
        useValue: { services: { '*': 'ws://fake' }, devApiUrl: '', registryUrl: '' },
      },
      {
        provide: ATLAS_CLIENT_FACTORY,
        useValue: (c: FakeAtlasClient['config']) => (client = new SpyClient(c)),
      },
      { provide: RegistryApi, useValue: { load: () => Promise.resolve(REGISTRY) } },
    ],
  });
  localStorage.clear();
  // jsdom has no scrolling; the virtual scroll viewport calls it.
  if (!('scrollTo' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'scrollTo', { value: () => undefined });
  }
  TestBed.inject(AuthStore).signIn({ token: 'jwt', scope: { countries: ['c1'] }, label: 'c1' });
  const fixture = TestBed.createComponent(LayersPanel);
  await fixture.whenStable();
  await settle(fixture);
  return { fixture, el: fixture.nativeElement };
}

async function settle(fixture: ComponentFixture<LayersPanel>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await fixture.whenStable();
  }
}

/** Calls a protected member, as the template would. */
function panel(fixture: ComponentFixture<LayersPanel>): Record<string, any> {
  return fixture.componentInstance;
}

const lastPage = () => client.pageCalls.at(-1)!;
const pageStore = (viewIndex: number) => client.views[viewIndex].pages.at(-1)!.store;

describe('LayersPanel', () => {
  it('opens the default view from the registry and puts it into WorkspaceStore.views', async () => {
    const { el } = await setup();
    const store = TestBed.inject(WorkspaceStore);
    expect(client.views).toHaveLength(1);
    expect(client.views[0]?.spec).toEqual({
      entityType: 'airplanes',
      scope: { countries: ['c1'] },
    });
    expect(store.views()).toHaveLength(1);
    expect(store.views()[0]?.handle.spec.entityType).toBe('airplanes');
    expect(lastPage().options).toEqual({ groupPath: [], pageSize: 50, prefetch: true });
    expect(el.querySelector('app-live-page-list')).not.toBeNull();
  });

  it('re-subscribes on a new filter: old view closed, new one in WorkspaceStore.views, list total follows', async () => {
    const { fixture, el } = await setup();
    const store = TestBed.inject(WorkspaceStore);
    pageStore(0).set(pageState({ total: 3000, pageCount: 60 }));
    await fixture.whenStable();
    expect(el.querySelector('.pos')?.textContent).toContain('3000');
    const first = store.views()[0];

    const c = newCondition(REGISTRY[0].fields[1]);
    panel(fixture)['filter'].set({ ...emptyGroup(), children: [{ ...c, value: 'LY' }] });
    await fixture.whenStable();
    (el.querySelector('.actions .primary') as HTMLButtonElement).click();
    await settle(fixture);

    expect(client.views[0]?.closed).toBe(true);
    expect(client.views[1]?.spec.filter).toEqual({
      and: [{ field: 'airline', op: 'eq', value: 'LY' }],
    });
    expect(store.views()).toHaveLength(1);
    expect(store.views()[0]).not.toBe(first);
    expect(store.views()[0]?.handle.spec).toBe(client.views[1]?.spec);

    pageStore(1).set(pageState({ total: 250, pageCount: 5 }));
    await fixture.whenStable();
    expect(el.querySelector('.pos')?.textContent).toContain('250');
  });

  it('does not apply a filter that breaks the limits, and shows the server INVALID_FILTER', async () => {
    const { fixture, el } = await setup();
    const c = newCondition(REGISTRY[0].fields[0]);
    panel(fixture)['filter'].set({
      ...emptyGroup(),
      children: [{ ...c, op: 'contains', value: 'LY' }],
    });
    await fixture.whenStable();
    expect((el.querySelector('.actions .primary') as HTMLButtonElement).disabled).toBe(true);
    expect(el.textContent).toContain('"contains" needs at least 3 characters');

    client.views[0].error.set({ code: 'INVALID_FILTER', message: 'unknown field "x"', at: 1 });
    await fixture.whenStable();
    expect(el.querySelector('[role=alert]')?.textContent).toContain(
      'INVALID_FILTER: unknown field "x"',
    );
  });

  it('freezes the order while hovering, shows the banner and refreshes on click', async () => {
    const { fixture, el } = await setup();
    const list = el.querySelector('app-live-page-list .list') as HTMLElement;
    list.dispatchEvent(new PointerEvent('pointerenter'));
    expect(lastPage().freeze).toEqual([true]);

    pageStore(0).set(pageState({ total: 100, pageCount: 2, frozen: true, pendingReorder: 7 }));
    await fixture.whenStable();
    const banner = el.querySelector('.banner') as HTMLButtonElement;
    expect(banner.textContent?.trim()).toBe('7 changed — refresh order');
    banner.click();
    expect(lastPage().freeze).toEqual([true, false, true]);

    list.dispatchEvent(new PointerEvent('pointerleave'));
    expect(lastPage().freeze).toEqual([true, false, true, false]);
  });

  it('groups: setLayout, a counts tree, and a page per expanded group', async () => {
    const { fixture, el } = await setup();
    panel(fixture)['setGroupBy'](0, 'airline');
    await fixture.whenStable();
    (el.querySelector('.actions .primary') as HTMLButtonElement).click();
    await settle(fixture);
    expect(client.views).toHaveLength(1);
    const counts = pageStore(0);
    expect(lastPage().options).toEqual({ pageSize: 1 });
    counts.set(
      pageState({
        total: 30,
        groupCounts: [
          { groupPath: ['LY'], count: 20 },
          { groupPath: ['BA'], count: 10 },
        ],
      }),
    );
    await fixture.whenStable();
    const toggles = [...el.querySelectorAll<HTMLButtonElement>('app-group-tree .toggle')];
    expect(toggles.map((t) => t.textContent?.replace(/\s+/g, ''))).toEqual(['▸LY20', '▸BA10']);
    toggles[1].click();
    await fixture.whenStable();
    expect(lastPage().options).toEqual({ groupPath: ['BA'], pageSize: 50, prefetch: true });
  });

  it('Find in list locates the entity, opens its group and jumps to its page', async () => {
    const { fixture } = await setup();
    const store = TestBed.inject(WorkspaceStore);
    client.locateAnswer = { found: true, groupPath: [], page: 4 };
    store.requestFindInList({ entityType: 'airplanes', id: 'a42' });
    await settle(fixture);
    expect(client.viewLocates).toEqual(['a42']);
    expect(lastPage().locates).toEqual([{ id: 'a42', jump: true }]);

    store.requestFindInList({ entityType: 'airports', id: 'TLV' });
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('TLV is not a Airplanes entity');
  });

  it('page controls and saved views', async () => {
    const { fixture, el } = await setup();
    pageStore(0).set(pageState({ total: 120, pageCount: 3 }));
    await fixture.whenStable();
    el.querySelectorAll<HTMLButtonElement>('app-live-page-list .bar .link')[2].click();
    expect(lastPage().pages).toEqual([1]);

    const p = panel(fixture);
    p['setGroupBy'](0, 'airline');
    p['saveName'].set('By airline');
    p['saveView']();
    p['setType']('airports');
    p['loadView']('By airline');
    await settle(fixture);
    expect(p['entityType']()).toBe('airplanes');
    expect(p['groupBy']()).toEqual(['airline']);
    expect(JSON.parse(localStorage.getItem('atlas.savedViews.c1') ?? '[]')).toHaveLength(1);
  });
});
