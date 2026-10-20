import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeClient } from '@atlas/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { MockServer, readRecording } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'atlas-rec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const frame = (...args: Parameters<typeof encodeClient>) => encodeClient(...args).slice();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connects, opens a map view and collects every server frame. */
async function session(url: string, ms: number, onOpen?: () => void): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = [];
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (e) => frames.push(new Uint8Array(e.data as ArrayBuffer)));
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(frame({ body: { case: 'auth', value: { token: 't', protocolVersion: 1 } } }));
  ws.send(
    frame({
      body: {
        case: 'openView',
        value: {
          viewRef: 'v',
          entityType: 'airplanes',
          filter: '',
          scope: { case: 'countries', value: { countryIds: [] } },
        },
      },
    }),
  );
  ws.send(frame({ body: { case: 'subscribeMap', value: { viewRef: 'v' } } }));
  onOpen?.();
  await sleep(ms);
  ws.close();
  return frames;
}

describe('recorder and replayer (C-07)', () => {
  it('records a session through the proxy and replays the same frames', async () => {
    const real = new MockServer({
      port: 0,
      airplanes: 200,
      ticksPerSecond: 20,
      updatesPerSecond: 400,
    });
    const realPort = await real.listen();
    const file = join(dir, 'session.jsonl');
    const proxy = new MockServer({ port: 0, proxy: `ws://127.0.0.1:${realPort}`, record: file });
    const proxyPort = await proxy.listen();
    // Stop the world before the client disconnects, so no frame is in flight while it closes.
    const live = await session(`ws://127.0.0.1:${proxyPort}/ws`, 500, () => {
      setTimeout(() => real.setPaused(true), 350);
    });
    await proxy.close();
    await real.close();

    const rec = readRecording(file);
    expect(rec.filter((f) => f.d === 'in')).toHaveLength(3);
    const out = rec.filter((f) => f.d === 'out');
    expect(out.length).toBe(live.length);
    expect(out.length).toBeGreaterThan(5);

    const replay = new MockServer({ port: 0, replay: file, replaySpeed: 4 });
    const replayPort = await replay.listen();
    const replayed = await session(`ws://127.0.0.1:${replayPort}/ws`, 400);
    await replay.close();
    expect(replayed.map((b) => Buffer.from(b).toString('base64'))).toEqual(
      live.map((b) => Buffer.from(b).toString('base64')),
    );
  });
});
