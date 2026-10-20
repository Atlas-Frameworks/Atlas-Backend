import { SubscriptionKind } from '@atlas/protocol';
import type { PageWindowInit } from '../testing/scripted-server.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { AtlasCore } from '../core/atlas-core.js';
import type { CoreView } from '../core/atlas-core.js';
import { FakeClock } from '../testing/fake-clock.js';
import { ScriptedServer } from '../testing/scripted-server.js';
import { DetailSubscription } from './detail-subscription.js';
import type { DetailState } from './detail-subscription.js';
import { PageSubscription } from './page-subscription.js';
import type { PageState } from './page-subscription.js';
import { RowCache } from './row-cache.js';

const row = (id: string, version = 1, callsign = id.toUpperCase()) => ({
  id,
  version: BigInt(version),
  fields: { callsign },
});

let server: ScriptedServer;
let core: AtlasCore;
let view: CoreView;
let cache: RowCache;

beforeEach(() => {
  server = new ScriptedServer();
  core = new AtlasCore({
    services: { '*': 'ws://svc.test' },
    transport: server.factory,
    clock: new FakeClock(),
  });
  view = core.openView({ entityType: 'airplanes', scope: { countries: ['IL'] } });
  cache = new RowCache();
});

function openPage(options: ConstructorParameters<typeof PageSubscription>[2] = {}) {
  const states: PageState[] = [];
  const page = new PageSubscription(view, cache, { pageSize: 3, ...options }, (s) =>
    states.push(s),
  );
  server.flush();
  const last = () => states.at(-1) as PageState;
  return { page, states, last };
}

function pageSnapshot(subId: string, seq: number, windowRef: string, w: PageWindowInit) {
  server.send({
    subId,
    seq,
    body: {
      case: 'snapshot',
      value: {
        kind: SubscriptionKind.PAGE,
        viewRef: view.viewRef,
        windowRef,
        state: { case: 'page', value: { pageSize: 3, ...w } },
      },
    },
  });
}

function pageDelta(subId: string, seq: number, w: PageWindowInit) {
  server.send({ subId, seq, body: { case: 'pageWindow', value: { pageSize: 3, ...w } } });
}

const ids = (s: PageState) => s.rows.map((r) => r.id);

describe('PageSubscription (C-03)', () => {
  it('sends SetWindow and renders the snapshot', () => {
    const { page, last } = openPage({ page: 2 });
    expect(server.ofCase('setWindow')[0]).toMatchObject({
      viewRef: view.viewRef,
      windowRef: page.windowRef,
      page: 2,
      pageSize: 3,
    });
    pageSnapshot('p', 1, page.windowRef, {
      orderedIds: ['a', 'b', 'c'],
      rows: [row('a'), row('b'), row('c')],
      total: 9,
      pageCount: 3,
      page: 2,
      groupCounts: [{ groupPath: ['LY'], count: 9 }],
    });
    server.flush();
    expect(ids(last())).toEqual(['a', 'b', 'c']);
    expect(last()).toMatchObject({
      total: 9,
      pageCount: 3,
      page: 2,
      loading: false,
      stale: false,
      groupCounts: [{ groupPath: ['LY'], count: 9 }],
    });
    expect(last().rows[0]?.fields).toEqual({ callsign: 'A' });
  });

  it('row inserted at the top pushes the last row off the page and evicts it', () => {
    const { page, last } = openPage();
    pageSnapshot('p', 1, page.windowRef, {
      orderedIds: ['a', 'b', 'c'],
      rows: [row('a'), row('b'), row('c')],
    });
    pageDelta('p', 2, { orderedIds: ['x', 'a', 'b'], rows: [row('x')] });
    server.flush();
    expect(ids(last())).toEqual(['x', 'a', 'b']);
    expect(cache.has('c')).toBe(false);
    expect(cache.size).toBe(3);
  });

  it('removal: the gap is filled by the next row and changed rows update', () => {
    const { page, last } = openPage();
    pageSnapshot('p', 1, page.windowRef, {
      orderedIds: ['a', 'b', 'c'],
      rows: [row('a'), row('b'), row('c')],
    });
    pageDelta('p', 2, { orderedIds: ['a', 'c', 'd'], rows: [row('d'), row('c', 2, 'C2')] });
    server.flush();
    expect(ids(last())).toEqual(['a', 'c', 'd']);
    expect(last().rows[1]?.fields).toEqual({ callsign: 'C2' });
    expect(cache.has('b')).toBe(false);
  });

  it('moves across pages: an entity leaving page 0 shows on page 1, cache = both pages', () => {
    const p0 = openPage();
    const p1 = openPage({ page: 1 });
    pageSnapshot('p0', 1, p0.page.windowRef, {
      orderedIds: ['a', 'b', 'c'],
      rows: [row('a'), row('b'), row('c')],
    });
    pageSnapshot('p1', 1, p1.page.windowRef, {
      orderedIds: ['d', 'e', 'f'],
      rows: [row('d'), row('e'), row('f')],
      page: 1,
    });
    // b's sort key changed: it moves to page 1, d moves up to page 0.
    pageDelta('p0', 2, { orderedIds: ['a', 'c', 'd'], rows: [] });
    pageDelta('p1', 2, { orderedIds: ['b', 'e', 'f'], rows: [row('b', 2)], page: 1 });
    server.flush();
    expect(ids(p0.last())).toEqual(['a', 'c', 'd']);
    expect(ids(p1.last())).toEqual(['b', 'e', 'f']);
    expect(p0.last().rows[2]?.version).toBe(1); // d's row came from the shared cache
    expect(p1.last().rows[0]?.version).toBe(2);
    expect(cache.size).toBe(6);
    expect(server.ofCase('resync')).toHaveLength(0);
  });

  it('freeze keeps the order, updates rows in place and counts pending reorders', () => {
    const { page, last } = openPage();
    pageSnapshot('p', 1, page.windowRef, {
      orderedIds: ['a', 'b', 'c'],
      rows: [row('a'), row('b'), row('c')],
    });
    server.flush();
    page.setFreezeOrder(true);
    pageDelta('p', 2, { orderedIds: ['c', 'a', 'b'], rows: [row('a', 2, 'A2')] });
    pageDelta('p', 3, { orderedIds: ['c', 'a', 'x'], rows: [row('x')] });
    server.flush();
    expect(ids(last())).toEqual(['a', 'b', 'c']);
    expect(last().rows[0]?.fields).toEqual({ callsign: 'A2' });
    expect(last().frozen).toBe(true);
    expect(last().pendingReorder).toBe(3);
    // b is still shown, x is held for when the order is applied.
    expect(cache.has('b')).toBe(true);
    expect(cache.has('x')).toBe(true);

    page.setFreezeOrder(false);
    expect(ids(last())).toEqual(['c', 'a', 'x']);
    expect(last().pendingReorder).toBe(0);
    expect(cache.has('b')).toBe(false);
  });

  it('a snapshot of a lower page (the list shrank) replaces the frozen order', () => {
    const { page, last } = openPage({ page: 3 });
    pageSnapshot('p', 1, page.windowRef, { orderedIds: ['a'], rows: [row('a')], page: 3 });
    server.flush();
    page.setFreezeOrder(true);
    pageSnapshot('p', 5, page.windowRef, { orderedIds: ['z'], rows: [row('z')], page: 1 });
    server.flush();
    expect(ids(last())).toEqual(['z']);
    expect(last().page).toBe(1);
    expect(last().frozen).toBe(false);
  });

  it('prefetch: the next page is subscribed and shown instantly', () => {
    const { page, last } = openPage({ prefetch: true });
    const windows = server.ofCase('setWindow');
    expect(windows.map((w) => [w.windowRef, w.page])).toEqual([
      [page.windowRef, 0],
      [`${page.windowRef}-next`, 1],
    ]);
    pageSnapshot('p0', 1, page.windowRef, {
      orderedIds: ['a', 'b', 'c'],
      rows: [row('a'), row('b'), row('c')],
    });
    pageSnapshot('p1', 1, `${page.windowRef}-next`, {
      orderedIds: ['d', 'e', 'f'],
      rows: [row('d'), row('e'), row('f')],
      page: 1,
    });
    server.flush();
    expect(cache.size).toBe(6); // open page + prefetch, nothing else

    page.setPage(1);
    expect(ids(last())).toEqual(['d', 'e', 'f']);
    expect(last().rows.every((r) => r.version === 1)).toBe(true);
    server.flush();
    const moved = server.ofCase('setWindow').slice(2);
    expect(moved.map((w) => [w.windowRef, w.page])).toEqual([
      [page.windowRef, 1],
      [`${page.windowRef}-next`, 2],
    ]);
    // Page 0's rows are gone; page 1 is held by the main window.
    expect(cache.has('a')).toBe(false);
    expect(cache.has('d')).toBe(true);
  });

  it('memory: the cache holds only rows on open pages plus prefetch', () => {
    const p0 = openPage({ prefetch: true });
    for (let seq = 1; seq <= 50; seq++) {
      const base = seq * 10;
      const pageIds = [`r${base}`, `r${base + 1}`, `r${base + 2}`];
      if (seq === 1) {
        pageSnapshot('p', 1, p0.page.windowRef, {
          orderedIds: pageIds,
          rows: pageIds.map((i) => row(i)),
        });
      } else {
        pageDelta('p', seq, { orderedIds: pageIds, rows: pageIds.map((i) => row(i)) });
      }
    }
    server.flush();
    expect(cache.size).toBe(3);
    p0.page.close();
    expect(cache.size).toBe(0);
  });

  it('an id without a cached row triggers Resync', () => {
    const { page } = openPage();
    pageSnapshot('p', 1, page.windowRef, { orderedIds: ['a'], rows: [row('a')] });
    pageDelta('p', 2, { orderedIds: ['a', 'ghost'], rows: [] });
    server.flush();
    expect(server.ofCase('resync')).toEqual([expect.objectContaining({ subId: 'p' })]);
  });

  it('locate returns the page and can jump there', async () => {
    const { page, last } = openPage();
    const done = page.locate('k', { jump: true });
    server.flush();
    expect(server.ofCase('locate')[0]).toMatchObject({ id: 'k', pageSize: 3 });
    server.send({
      body: {
        case: 'locateResult',
        value: { viewRef: view.viewRef, id: 'k', found: true, page: 7 },
      },
    });
    server.flush();
    await expect(done).resolves.toEqual({ found: true, groupPath: [], page: 7 });
    expect(last().page).toBe(7);
    expect(last().loading).toBe(true);
    expect(server.ofCase('setWindow').at(-1)).toMatchObject({ page: 7 });
  });

  it('marks the page stale while disconnected and keeps the rows', () => {
    const { page, last } = openPage();
    pageSnapshot('p', 1, page.windowRef, { orderedIds: ['a'], rows: [row('a')] });
    server.flush();
    server.conn.close(1006);
    server.flush();
    expect(last().stale).toBe(true);
    expect(ids(last())).toEqual(['a']);
  });
});

describe('DetailSubscription (C-03)', () => {
  it('shows the live row, then removed', () => {
    const states: DetailState[] = [];
    const d = new DetailSubscription('airplanes', 'p1', (s) => states.push(s));
    d.core = core.openDetail('airplanes', 'p1', d);
    server.flush();
    expect(server.ofCase('openDetail')).toEqual([
      expect.objectContaining({ entityType: 'airplanes', id: 'p1' }),
    ]);
    server.send({
      subId: 'd',
      seq: 1,
      body: {
        case: 'snapshot',
        value: {
          kind: SubscriptionKind.DETAIL,
          state: {
            case: 'detail',
            value: { entityType: 'airplanes', id: 'p1', state: { case: 'row', value: row('p1') } },
          },
        },
      },
    });
    server.send({
      subId: 'd',
      seq: 2,
      body: {
        case: 'detailUpdate',
        value: {
          entityType: 'airplanes',
          id: 'p1',
          state: {
            case: 'row',
            value: { id: 'p1', version: 2n, fields: { crew: [{ name: 'Dana' }] } },
          },
        },
      },
    });
    server.flush();
    expect(states.at(-1)).toMatchObject({
      row: { id: 'p1', version: 2, fields: { crew: [{ name: 'Dana' }] } },
      removed: false,
      loading: false,
    });
    server.send({
      subId: 'd',
      seq: 3,
      body: {
        case: 'detailUpdate',
        value: { entityType: 'airplanes', id: 'p1', state: { case: 'removed', value: true } },
      },
    });
    server.flush();
    expect(states.at(-1)).toMatchObject({ row: null, removed: true });
    d.close();
    server.flush();
    expect(server.cases().at(-1)).toBe('closeDetail');
  });
});
