import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { DetailState, RowData } from '@atlas/client-sdk';
import { AuthStore } from '../auth/auth.store';
import { ATLAS_ENV } from '../config/environment';
import { ATLAS_CLIENT_FACTORY } from '../realtime/atlas-client-factory';
import { FakeAtlasClient } from '../realtime/fake-atlas-client';
import type { FakeDetail } from '../realtime/fake-atlas-client';
import { WorkspaceStore } from '../workspace/workspace.store';
import { DetailDrawer } from './detail-drawer';
import { describeFields, fieldLabel, formatValue } from './detail-model';

const PLANE = { entityType: 'airplanes', id: 'p1' };

function planeRow(crewName = 'Ada Lovelace', version = 7): RowData {
  return {
    id: 'p1',
    version,
    fields: {
      callsign: 'ATL123',
      altitude: 10_400,
      lat: 32.0123456,
      updatedAt: '2026-10-20T10:00:05.000Z',
      crew: [
        { memberId: 'm1', role: 'captain', name: crewName },
        { memberId: 'm2', role: 'first officer', name: 'Grace Hopper' },
      ],
      airport: {
        id: 'a1',
        iata: 'TLV',
        name: 'Ben Gurion',
        runways: [
          { length: 3_112, surface: 'asphalt' },
          { length: 2_772, surface: 'asphalt' },
        ],
      },
    },
  };
}

function detailState(patch: Partial<DetailState> = {}): DetailState {
  return {
    entityType: 'airplanes',
    id: 'p1',
    row: planeRow(),
    removed: false,
    loading: false,
    stale: false,
    staleSince: null,
    ...patch,
  };
}

let client: FakeAtlasClient | undefined;
let store: WorkspaceStore;
let fixture: ComponentFixture<DetailDrawer>;
let el: HTMLElement;

async function setup(): Promise<void> {
  client = undefined;
  TestBed.configureTestingModule({
    providers: [
      { provide: ATLAS_ENV, useValue: { services: {}, devApiUrl: '', registryUrl: '' } },
      {
        provide: ATLAS_CLIENT_FACTORY,
        useValue: (config: FakeAtlasClient['config']) => (client = new FakeAtlasClient(config)),
      },
    ],
  });
  TestBed.inject(AuthStore).signIn({ token: 'jwt', scope: { countries: ['c1'] }, label: 'c1' });
  store = TestBed.inject(WorkspaceStore);
  fixture = TestBed.createComponent(DetailDrawer);
  el = fixture.nativeElement as HTMLElement;
  await fixture.whenStable();
}

function details(): FakeDetail[] {
  return client?.details ?? [];
}

function lastDetail(): FakeDetail {
  const d = details().at(-1);
  if (!d) throw new Error('no detail opened');
  return d;
}

async function select(ref: { entityType: string; id: string } | null): Promise<void> {
  store.select(ref);
  await fixture.whenStable();
}

async function push(state: DetailState): Promise<void> {
  lastDetail().store.set(state);
  await fixture.whenStable();
}

function q(selector: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(selector);
}

function cells(table: string): string[][] {
  return [...el.querySelectorAll(`[data-table="${table}"] tbody tr`)].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? ''),
  );
}

function field(key: string): string | undefined {
  return q(`[data-field="${key}"] dd`)?.textContent?.trim();
}

describe('DetailDrawer', () => {
  beforeEach(setup);

  it('shows an empty state and opens nothing while nothing is selected', () => {
    expect(q('[data-test="empty"]')?.textContent).toContain('Select a point');
    expect(details()).toHaveLength(0);
  });

  it('opens a detail for the selection and renders fields, nested sections and tables', async () => {
    await select(PLANE);
    expect(lastDetail()).toMatchObject({ entityType: 'airplanes', id: 'p1', closed: false });
    expect(el.textContent).toContain('Loading…');

    await push(detailState());
    expect(q('.title')?.textContent).toBe('ATL123');
    expect(q('.type')?.textContent).toBe('Airplane');
    expect(field('altitude')).toBe('10,400');
    expect(field('lat')).toBe('32.01235');
    expect(field('updatedAt')).toBe('2026-10-20 10:00:05 UTC');
    expect(q('[data-field="lat"] dt')?.textContent).toBe('Latitude');
    expect([...el.querySelectorAll('[data-table="crew"] th')].map((th) => th.textContent)).toEqual([
      'Member ID',
      'Role',
      'Name',
    ]);
    expect(cells('crew')).toEqual([
      ['m1', 'captain', 'Ada Lovelace'],
      ['m2', 'first officer', 'Grace Hopper'],
    ]);
    expect(q('[data-table="crew"] td.id')?.title).toBe('m1');
    const airport = q('[data-section="airport"]');
    expect(airport?.querySelector('[data-field="iata"] dd')?.textContent).toBe('TLV');
    expect(cells('runways')).toEqual([
      ['3,112', 'asphalt'],
      ['2,772', 'asphalt'],
    ]);
    expect(airport?.querySelector('[data-table="runways"]')).not.toBeNull();
  });

  it('updates live when a crew change arrives', async () => {
    await select(PLANE);
    await push(detailState());
    await push(detailState({ row: planeRow('Katherine Johnson', 8) }));
    expect(cells('crew')[0]).toEqual(['m1', 'captain', 'Katherine Johnson']);
    expect(el.textContent).toContain('v8');
  });

  it('marks stale data', async () => {
    await select(PLANE);
    await push(detailState());
    expect(q('[data-test="stale"]')).toBeNull();
    const since = new Date(2026, 0, 1, 12, 3, 5).getTime();
    await push(detailState({ stale: true, staleSince: since }));
    expect(q('[data-test="stale"]')?.textContent).toBe('Stale since 12:03:05');
    expect(q('.body')?.classList).toContain('is-stale');
  });

  it('shows Removed when the entity is deleted and disables the actions', async () => {
    await select(PLANE);
    await push(detailState());
    await push(detailState({ row: null, removed: true }));
    expect(q('[data-test="removed"]')?.textContent).toContain('Removed.');
    expect(q('[data-table="crew"]')).toBeNull();
    expect(q('.title')?.textContent).toBe('ATL123');
    expect((q('[data-test="fly-to"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-test="find-in-list"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disposes the previous detail when the selection changes, and on clear', async () => {
    await select(PLANE);
    const first = lastDetail();
    await push(detailState());
    await select({ entityType: 'airplanes', id: 'p2' });
    expect(first.closed).toBe(true);
    expect(details()).toHaveLength(2);
    expect(lastDetail()).toMatchObject({ id: 'p2', closed: false });
    expect(q('[data-table="crew"]')).toBeNull();

    await select({ entityType: 'airplanes', id: 'p2' });
    expect(details()).toHaveLength(2);

    await select(null);
    expect(lastDetail().closed).toBe(true);
    expect(q('[data-test="empty"]')).not.toBeNull();
  });

  it('disposes the detail when the drawer is destroyed', async () => {
    await select(PLANE);
    fixture.destroy();
    expect(lastDetail().closed).toBe(true);
  });

  it('asks the store to fly to and find the entity', async () => {
    const flyTo = vi.spyOn(store, 'requestFlyTo');
    const find = vi.spyOn(store, 'requestFindInList');
    await select(PLANE);
    await push(detailState());
    q('[data-test="fly-to"]')?.click();
    q('[data-test="find-in-list"]')?.click();
    expect(flyTo).toHaveBeenCalledWith(PLANE);
    expect(find).toHaveBeenCalledWith(PLANE);
    expect(store.flyTo()).toMatchObject(PLANE);
    expect(store.findInList()).toMatchObject(PLANE);
  });
});

describe('detail model', () => {
  it('labels known and unknown fields', () => {
    expect(fieldLabel('aircraftKind')).toBe('Aircraft');
    expect(fieldLabel('airport.runwayCount')).toBe('Airport runways');
    expect(fieldLabel('fuelLevel')).toBe('Fuel level');
    expect(fieldLabel('gate_number')).toBe('Gate number');
  });

  it('formats scalars', () => {
    expect(formatValue('x', null)).toBe('—');
    expect(formatValue('x', true)).toBe('Yes');
    expect(formatValue('heading', 271.6)).toBe('272');
    expect(formatValue('tags', ['a', 'b'])).toBe('a, b');
  });

  it('splits scalars, tables and sections; empty arrays stay fields', () => {
    const node = describeFields({ a: 1, list: [], items: [{ x: 1 }, { y: 2 }], obj: { b: 'z' } });
    expect(node.fields.map((f) => [f.key, f.text])).toEqual([
      ['a', '1'],
      ['list', '—'],
    ]);
    expect(node.tables[0]?.columns.map((c) => c.key)).toEqual(['x', 'y']);
    expect(node.tables[0]?.rows).toEqual([
      ['1', '—'],
      ['—', '2'],
    ]);
    expect(node.sections[0]?.node.fields[0]).toEqual({ key: 'b', label: 'B', text: 'z' });
  });
});
