/**
 * C-07 load: 30,000 entities at 6,000 updates per second, sustained, with an SDK client
 * subscribed to the whole map and a live page. `npm run bench -w @atlas/mock-server`.
 */
import { AtlasCore, MapLayerStore, PageSubscription, RowCache } from '@atlas/client-sdk';
import { describe, expect, it } from 'vitest';
import { MockServer } from '../src/server.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mock server load (C-07)', () => {
  it('sustains 30,000 entities at 6,000 updates/s', async () => {
    const server = new MockServer({
      port: 0,
      airplanes: 30_000,
      airports: 4_000,
      countries: 250,
      updatesPerSecond: 6_000,
      ticksPerSecond: 10,
      paused: true,
    });
    const port = await server.listen();
    const core = new AtlasCore({ services: { '*': `ws://127.0.0.1:${port}/ws` }, token: 't' });
    const view = core.openView({ entityType: 'airplanes', scope: { countries: [] } });
    const store = new MapLayerStore('all');
    let applyMs = 0;
    let deltas = 0;
    const timed = {
      applySnapshot: store.applySnapshot.bind(store),
      applyDelta: (m: Parameters<MapLayerStore['applyDelta']>[0]) => {
        const t0 = performance.now();
        store.applyDelta(m);
        applyMs += performance.now() - t0;
        deltas++;
      },
    };
    view.subscribeMap(timed);
    let pageUpdates = 0;
    const page = new PageSubscription(view, new RowCache(), { pageSize: 50 }, () => pageUpdates++);
    while (store.size < 30_000) await sleep(50);

    const DURATION_S = 15;
    const before = server.stats();
    server.setPaused(false);
    const t0 = Date.now();
    await sleep(DURATION_S * 1_000);
    server.setPaused(true);
    const elapsed = (Date.now() - t0) / 1_000;
    const after = server.stats();
    await sleep(300);

    const updates = after.updatesApplied - before.updatesApplied;
    const ups = updates / elapsed;
    const session = after.sessions[0]!;
    const st = core.getStatus();
    console.log(
      `${elapsed.toFixed(1)} s: ${updates} updates (${ups.toFixed(0)}/s), ${after.steps - before.steps} steps, ` +
        `avg step ${after.avgStepMs.toFixed(1)} ms; client: ${deltas} map deltas, ` +
        `apply avg ${(applyMs / Math.max(1, deltas)).toFixed(2)} ms, ${pageUpdates} page updates, ` +
        `${(session.bytesSent / 1e6 / elapsed).toFixed(2)} MB/s, resyncs ${session.resyncs}, stale ${st.staleSince !== null}`,
    );
    expect(ups).toBeGreaterThan(6_000 * 0.95);
    expect(after.avgStepMs).toBeLessThan(50);
    expect(session.resyncs).toBe(0);
    expect(store.size).toBe(server.world.airplanes.size);
    page.close();
    core.close();
    await server.close();
  });
});
