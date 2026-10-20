#!/usr/bin/env node
/**
 * `npm run mock -w @atlas/mock-server -- [options]`
 *
 *   --port 8090            HTTP + WebSocket port (env MOCK_PORT)
 *   --profile dev|load     dev: 3,000 airplanes, 2,000 updates/s (default); load: 30,000 and 6,000/s
 *   --airplanes N          override the airplane count
 *   --ups N                position updates per second
 *   --tps N                world steps per second (default 10)
 *   --seed N               world seed (default 42)
 *   --paused               start paused (POST /control/step to advance)
 *   --record FILE          append every frame to FILE (JSONL)
 *   --replay FILE          serve a recording instead of the simulated world
 *   --replay-speed X       replay speed factor
 *   --proxy URL            forward each connection to a real worker (combine with --record)
 */
import { MockServer } from './server.js';

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), 'true');
    else {
      out.set(a.slice(2), next);
      i++;
    }
  }
  return out;
}

const a = args(process.argv.slice(2));
const num = (key: string, env?: string): number | undefined => {
  const v = a.get(key) ?? (env ? process.env[env] : undefined);
  return v === undefined ? undefined : Number(v);
};
const profile = a.get('profile') ?? process.env['MOCK_PROFILE'] ?? 'dev';
const load = profile === 'load';

const server = new MockServer({
  port: num('port', 'MOCK_PORT') ?? 8090,
  host: a.get('host') ?? process.env['MOCK_HOST'] ?? '127.0.0.1',
  seed: num('seed') ?? 42,
  airplanes: num('airplanes', 'MOCK_AIRPLANES') ?? (load ? 30_000 : 3_000),
  airports: load ? 4_000 : 400,
  countries: load ? 250 : 60,
  connections: load ? 200 : 20,
  updatesPerSecond: num('ups', 'MOCK_UPS') ?? (load ? 6_000 : 2_000),
  ticksPerSecond: num('tps') ?? 10,
  paused: a.has('paused'),
  ...(a.get('record') ? { record: a.get('record') } : {}),
  ...(a.get('replay') ? { replay: a.get('replay') } : {}),
  ...(a.get('replay-speed') ? { replaySpeed: Number(a.get('replay-speed')) } : {}),
  ...(a.get('proxy') ? { proxy: a.get('proxy') } : {}),
  log: (line) => console.log(`[mock] ${line}`),
});

await server.listen();
const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
