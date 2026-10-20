/**
 * C-04 example: the SDK from plain JS. Map frame counts and a live page list update together.
 * Build and serve: `npm run example -w @atlas/client-sdk` (with `npm run dev:mock` running).
 */
import { createAtlasClient } from '@atlas/client-sdk';

const mock = new URLSearchParams(location.search).get('mock') ?? 'http://127.0.0.1:8090';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
$('mock').textContent = mock;

const { token } = (await (
  await fetch(`${mock}/dev/token`, { method: 'POST', body: '{}' })
).json()) as {
  token: string;
};

const client = createAtlasClient({
  services: { '*': `${mock.replace(/^http/, 'ws')}/ws` },
  token,
  worker: () => new Worker(new URL('./sdk.worker.js', import.meta.url), { type: 'module' }),
});

client.status.subscribe((s) => {
  const el = $('status');
  el.textContent =
    s.connection === 'open' && s.staleSince === null
      ? 'Live'
      : s.connection === 'open'
        ? `Stale since ${new Date(s.staleSince ?? 0).toLocaleTimeString()}`
        : s.connection === 'reconnecting'
          ? 'Reconnecting…'
          : s.connection;
  el.className = s.connection === 'open' && s.staleSince === null ? 'live' : 'bad';
});

const view = client.openView({ entityType: 'airplanes', scope: { countries: [] } });
view.setLayout({ groupBy: [], sort: { field: 'callsign', dir: 'asc' } });
view.subscribeMap();

let frames = 0;
client.onFrame((frame) => {
  frames++;
  let visible = 0;
  for (let i = 0; i < frame.count; i++) visible += frame.visible[i] ?? 0;
  $('frames').textContent = String(frames);
  $('entities').textContent = String(visible);
});

let pageUpdates = 0;
const page = view.subscribePage({ pageSize: 20 });
page.subscribe((state) => {
  if (!state) return;
  pageUpdates++;
  $('pageUpdates').textContent = String(pageUpdates);
  $('total').textContent = String(state.total);
  $('rows').innerHTML = state.rows
    .map((r) => {
      const f = r.fields;
      return `<tr data-id="${r.id}"><td>${String(f['callsign'])}</td><td>${String(f['airline'])}</td><td>${String(f['aircraftKind'])}</td><td>${String(f['altitude'])}</td><td>${r.version}</td></tr>`;
    })
    .join('');
});
