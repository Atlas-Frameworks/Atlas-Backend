# @atlas/mock-server

A mock view service (task C-07) that speaks the real client protocol ([contracts.md §3](../../docs/contracts.md),
`@atlas/protocol`) over a simulated world, so the SDK and the Angular app never wait for the real
backend. Pointing the app at a real worker later is a config change.

```bash
npm run mock -w @atlas/mock-server                       # dev profile: 3,000 airplanes, 2,000 updates/s, port 8090
npm run mock -w @atlas/mock-server -- --profile load     # 30,000 airplanes, 6,000 updates/s
```

Options: `--port`, `--profile dev|load`, `--airplanes N`, `--ups N` (updates per second), `--tps N`
(world steps per second, default 10), `--seed N`, `--paused`, `--record FILE`, `--replay FILE`,
`--replay-speed X`, `--proxy URL`. Environment: `MOCK_PORT`, `MOCK_PROFILE`, `MOCK_AIRPLANES`,
`MOCK_UPS`, `DEV_JWT_SECRET`.

## Endpoints

WebSocket: `ws://127.0.0.1:8090/ws` (any path). One binary Protobuf frame per message.

| Method and path | What |
| --- | --- |
| `GET /dev/scopes` | Countries and connections for the login stub (same shape W-03 will serve) |
| `POST /dev/token` | `{countries?: string[], connectionId?: string, userId?: string}` → `{token, expiresAt}`: an HS256 dev JWT with `userId`, `allowedCountries`, `allowedConnections` |
| `GET /meta/registry` | Field registry metadata per entity type: `{types: [{type, label, map, defaultSort, fields: [{name, label, type, ops, groupable, sortable, values?}]}]}` |
| `GET /control/state` | Entities, rates, average step time, sessions with frames/bytes sent, frames dropped and resyncs |
| `POST /control/fault` | Fault injection, see below |
| `POST /control/pause`, `/control/resume` | Stop or restart the world (frames held by faults still flush) |
| `POST /control/step` | `{count}`: advance a paused world |
| `POST /control/rate` | `{updatesPerSecond?, ticksPerSecond?}` |

## Faults (`POST /control/fault`)

Every fault applies to all sessions, or to one with `"session": "s3"` (ids from `/control/state`).

| Body | Effect |
| --- | --- |
| `{"type":"drop","count":3}` | The next 3 sequenced deltas are not sent; their `seq` is used, so the client sees a gap and must `Resync` |
| `{"type":"duplicate","count":3}` | The next 3 sequenced frames are sent twice |
| `{"type":"delay","ms":2000}` | Every frame is held for 2 s, then sent in order |
| `{"type":"disconnect"}` | The socket is terminated without a close frame |
| `{"type":"reconnect","afterMs":5000,"closeAfterMs":7000}` | Sends `Reconnect{afterMs}` (random 0–15,000 when omitted), then closes the socket after `closeAfterMs` (default `afterMs + 2 s`), like a planned shutdown |
| `{"type":"slow","ms":3000,"maxQueued":200}` | Slow consumer: frames queue for 3 s; past `maxQueued` the queued deltas are dropped and those subscriptions get a fresh snapshot once the queue drains (the plan's send-buffer rule) |
| `{"type":"error","code":"RETRY","message":"..."}` | Sends a connection-level `Error` |

## Recorder and replayer

- `--record FILE` appends every frame, both directions, as JSON lines: `{"t": ms since start, "s":
  session, "d": "in"|"out", "b": base64}`.
- `--proxy ws://real-worker:8080 --record FILE` sits between the client and a real worker and records
  that real session.
- `--replay FILE [--replay-speed 4]` serves the recorded server frames of the first session in the
  file, with their original timing, to every client that connects (client messages are ignored).

## What the mock simulates

- Entity types `airplanes` (on the map) and `airports` (on the map, static), plus countries and
  connections for scopes. Data is deterministic per `--seed`.
- Each step moves `updatesPerSecond / ticksPerSecond` airplanes (time-based, so timer drift does not
  lower the rate) and adds occasional airline, aircraft and crew changes, deletes and creations.
- Views: scope (countries, or a connection's countries and criteria) plus a contracts §5 filter,
  validated like the real service (`INVALID_FILTER`, limits). `SetLayout` groups by up to 2 fields
  and sorts by any sortable field (ties by id).
- Map: `Snapshot` then a `MapDelta` per step with moved, entered and left entities.
- Pages: `PageWindow` per step when the ids, rows (new or changed version), total, page or group
  counts changed. A page past the end is served as the last page. `Locate` answers `LocateResult`.
- Detail: a row on every version change (including crew changes), `removed` on delete.
- Every frame of a subscription has the next `seq`; `Resync` answers with a fresh snapshot. Unlike
  the real service, `sub_id`s are per connection (nothing is shared between clients).

## Tests

- `src/mock.spec.ts`: world determinism, filter validation, map, pages, locate, detail, faults.
- `test/e2e.spec.ts`: the real SDK (core, map store, pages, detail) over a real WebSocket, through
  every fault type, then a check that the client matches the server's world exactly.
- `test/recorder.spec.ts`: proxy-record a session, replay it, compare frames byte for byte.
- `npm run bench -w @atlas/mock-server` (`test/load.perf.ts`): 30,000 airplanes at 6,000 updates/s for
  15 s with an SDK client on the whole map and a live page.

Load result (Node 24, Apple Silicon laptop): 5,983 updates/s sustained over 15 s, average world
step 16.6 ms at 10 steps/s, client map-delta apply 0.33 ms, 0.59 MB/s to the client, 0 resyncs, not
stale.
