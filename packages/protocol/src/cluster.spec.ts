// Round-trips the cluster messages and proves the chosen Node gRPC stack
// (@connectrpc/connect-node, gRPC protocol over HTTP/2) carries the ViewOwner
// bidirectional stream, in plaintext (local) and with mutual TLS (OpenShift).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, equals } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import type { ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter, createGrpcTransport } from '@connectrpc/connect-node';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodeOwnerEvent,
  decodeOwnerRequest,
  encodeOwnerEvent,
  encodeOwnerRequest,
  OwnerEventSchema,
  OwnerRequestSchema,
  ViewOwner,
} from './cluster.js';
import type { OwnerEvent, OwnerRequest } from './cluster.js';
import { decodeServer, encodeServer } from './codec.js';
import { SubscriptionKind } from './gen/atlas/client/v1/client_pb.js';
import { packPositions } from './positions.js';

const deltaPayload = encodeServer({
  subId: 'v:abc:map',
  seq: 5,
  body: {
    case: 'mapDelta',
    value: { upsertIds: ['a-1'], positions: packPositions(new Float64Array([34.8, 32.1, 900])) },
  },
});
const snapshotPayload = encodeServer({
  subId: 'v:abc:map',
  seq: 4,
  body: {
    case: 'snapshot',
    value: { kind: SubscriptionKind.MAP, state: { case: 'map', value: {} } },
  },
});

const requestSamples: OwnerRequest[] = [
  create(OwnerRequestSchema, {
    body: { case: 'hello', value: { workerName: 'view-service-2', epoch: 17 } },
  }),
  create(OwnerRequestSchema, {
    body: {
      case: 'sub',
      value: {
        subKey: 'v:abc:page::0:50',
        viewKey: 'abc',
        kind: SubscriptionKind.PAGE,
        pageSpec: { groupPath: [], page: 0, pageSize: 50 },
        view: {
          entityType: 'airplanes',
          filter: '{"field":"airline","op":"eq","value":"LY"}',
          scope: { case: 'countries', value: { countryIds: ['c-il'] } },
          groupBy: ['airline'],
          sort: { field: 'callsign' },
        },
        epoch: 17,
      },
    },
  }),
  create(OwnerRequestSchema, {
    body: {
      case: 'sub',
      value: {
        subKey: 'd:airplanes:a-1',
        kind: SubscriptionKind.DETAIL,
        detail: { entityType: 'airplanes', id: 'a-1' },
        epoch: 17,
      },
    },
  }),
  create(OwnerRequestSchema, {
    body: { case: 'unsub', value: { subKey: 'v:abc:map', epoch: 17 } },
  }),
];

const eventSamples: OwnerEvent[] = [
  create(OwnerEventSchema, {
    body: {
      case: 'snapshot',
      value: { subKey: 'v:abc:map', seq: 4, epoch: 17, payload: snapshotPayload },
    },
  }),
  create(OwnerEventSchema, {
    body: {
      case: 'delta',
      value: { subKey: 'v:abc:map', seq: 5, epoch: 17, payload: deltaPayload },
    },
  }),
  create(OwnerEventSchema, {
    body: { case: 'notOwner', value: { subKey: 'v:abc:map', epoch: 18 } },
  }),
];

describe('cluster messages', () => {
  it('covers every OwnerRequest and OwnerEvent case', () => {
    expect(new Set(requestSamples.map((r) => r.body.case))).toEqual(
      new Set(['hello', 'sub', 'unsub']),
    );
    expect(new Set(eventSamples.map((e) => e.body.case))).toEqual(
      new Set(['snapshot', 'delta', 'notOwner']),
    );
  });

  it.each(requestSamples.map((r, i) => [`${i}:${r.body.case}`, r] as const))(
    'round-trips request %s',
    (_c, msg) => {
      expect(equals(OwnerRequestSchema, decodeOwnerRequest(encodeOwnerRequest(msg)), msg)).toBe(
        true,
      );
    },
  );

  it.each(eventSamples.map((e) => [e.body.case, e] as const))('round-trips event %s', (_c, msg) => {
    expect(equals(OwnerEventSchema, decodeOwnerEvent(encodeOwnerEvent(msg)), msg)).toBe(true);
  });

  it('carries the encoded ServerMessage byte-for-byte, ready to forward', () => {
    const ev = decodeOwnerEvent(encodeOwnerEvent(eventSamples[1]!));
    if (ev.body.case !== 'delta') throw new Error('expected delta');
    expect(ev.body.value.payload).toEqual(deltaPayload);
    expect(decodeServer(ev.body.value.payload).seq).toBe(ev.body.value.seq);
  });
});

/** A tiny owner: answers Hello silently, Sub with snapshot + delta (or NotOwner on a stale epoch). */
function ownerRoutes(router: ConnectRouter): void {
  const ownerEpoch = 17;
  router.service(ViewOwner, {
    async *subscribe(requests) {
      for await (const req of requests) {
        if (req.body.case !== 'sub') continue;
        const { subKey, epoch } = req.body.value;
        if (epoch < ownerEpoch) {
          yield { body: { case: 'notOwner', value: { subKey, epoch: ownerEpoch } } };
          continue;
        }
        yield {
          body: {
            case: 'snapshot',
            value: { subKey, seq: 4, epoch: ownerEpoch, payload: snapshotPayload },
          },
        };
        yield {
          body: {
            case: 'delta',
            value: { subKey, seq: 5, epoch: ownerEpoch, payload: deltaPayload },
          },
        };
      }
    },
  });
}

type AnyHttp2Server = http2.Http2Server | http2.Http2SecureServer;

async function listen(server: AnyHttp2Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function trackSessions(server: AnyHttp2Server): () => Promise<void> {
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s: http2.ServerHttp2Session) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const s of sessions) s.destroy();
      server.close(() => resolve());
    });
}

/** Opens one stream: Hello, Sub(epoch), waits for `expect` events, then Unsub and half-close. */
async function runStream(
  baseUrl: string,
  nodeOptions: http2.SecureClientSessionOptions | undefined,
  epoch: number,
  expectEvents: number,
) {
  const transport = createGrpcTransport({
    baseUrl,
    // Explicit keepalives, as S-07 requires (10 s ping, 5 s timeout).
    pingIntervalMs: 10_000,
    pingTimeoutMs: 5_000,
    ...(nodeOptions ? { nodeOptions } : {}),
  });
  const client = createClient(ViewOwner, transport);
  let release: (() => void) | undefined;
  const done = new Promise<void>((r) => (release = r));
  async function* requests() {
    yield create(OwnerRequestSchema, {
      body: { case: 'hello', value: { workerName: 'view-service-1', epoch } },
    });
    yield create(OwnerRequestSchema, {
      body: {
        case: 'sub',
        value: { subKey: 'v:abc:map', viewKey: 'abc', kind: SubscriptionKind.MAP, epoch },
      },
    });
    await done;
    yield create(OwnerRequestSchema, {
      body: { case: 'unsub', value: { subKey: 'v:abc:map', epoch } },
    });
  }
  const received: OwnerEvent[] = [];
  for await (const ev of client.subscribe(requests())) {
    received.push(ev);
    if (received.length === expectEvents) release?.();
  }
  return received;
}

describe('ViewOwner over gRPC (@connectrpc/connect-node)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  it('streams snapshot then delta over plaintext HTTP/2 (local)', async () => {
    const server = http2.createServer(connectNodeAdapter({ routes: ownerRoutes }));
    cleanups.push(trackSessions(server));
    const port = await listen(server);

    const events = await runStream(`http://127.0.0.1:${port}`, undefined, 17, 2);
    expect(events.map((e) => e.body.case)).toEqual(['snapshot', 'delta']);
    const delta = events[1]!;
    if (delta.body.case !== 'delta') throw new Error('expected delta');
    expect(delta.body.value.payload).toEqual(deltaPayload);

    const stale = await runStream(`http://127.0.0.1:${port}`, undefined, 16, 1);
    expect(stale.map((e) => e.body.case)).toEqual(['notOwner']);
  });

  const pki = makeTestPki();
  it.skipIf(!pki)(
    'streams over mutual TLS and rejects a client without a certificate',
    async () => {
      const p = pki!;
      cleanups.push(async () => rmSync(p.dir, { recursive: true, force: true }));
      const server = http2.createSecureServer(
        {
          key: p.serverKey,
          cert: p.serverCert,
          ca: p.ca,
          requestCert: true,
          rejectUnauthorized: true,
        },
        connectNodeAdapter({ routes: ownerRoutes }),
      );
      cleanups.push(trackSessions(server));
      const port = await listen(server);
      const baseUrl = `https://127.0.0.1:${port}`;

      const events = await runStream(
        baseUrl,
        { ca: p.ca, key: p.clientKey, cert: p.clientCert },
        17,
        2,
      );
      expect(events.map((e) => e.body.case)).toEqual(['snapshot', 'delta']);

      await expect(runStream(baseUrl, { ca: p.ca }, 17, 2)).rejects.toThrow(/certificate required/);
    },
  );
});

interface TestPki {
  dir: string;
  ca: string;
  serverKey: string;
  serverCert: string;
  clientKey: string;
  clientCert: string;
}

/** Throwaway CA + server + client certificates via the openssl CLI; undefined if openssl is missing. */
function makeTestPki(): TestPki | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-mtls-'));
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  try {
    ssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-days',
      '1',
      '-subj',
      '/CN=atlas-test-ca',
    );
    writeFileSync(join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
    for (const name of ['server', 'client']) {
      ssl(
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=atlas-${name}`,
      );
      ssl(
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        `${name}.crt`,
        '-days',
        '1',
        ...(name === 'server' ? ['-extfile', 'server.ext'] : []),
      );
    }
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return {
    dir,
    ca: read('ca.crt'),
    serverKey: read('server.key'),
    serverCert: read('server.crt'),
    clientKey: read('client.key'),
    clientCert: read('client.crt'),
  };
}
