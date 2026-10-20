import { create, equals } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { bindSnapshot, decodeClient, decodeServer, encodeClient, encodeServer } from './codec.js';
import type { ClientMessageInit, ServerMessageInit } from './codec.js';
import {
  ClientMessageSchema,
  ErrorCode,
  ServerMessageSchema,
  SortDirection,
  SubscriptionKind,
} from './gen/atlas/client/v1/client_pb.js';
import type { ClientMessage, ServerMessage } from './gen/atlas/client/v1/client_pb.js';
import { packIcons, packPositions, unpackIcons, unpackPositions } from './positions.js';

const filter = JSON.stringify({
  and: [
    { field: 'airline', op: 'eq', value: 'LY' },
    { or: [{ field: 'aircraftKind', op: 'in', value: ['B738', 'B789'] }] },
  ],
});

/** One populated sample per ClientMessage body case (plus scope variants). */
const clientSamples: ClientMessageInit[] = [
  { body: { case: 'auth', value: { token: 'jwt.token.sig', protocolVersion: 1 } } },
  {
    body: {
      case: 'openView',
      value: {
        viewRef: 'v1',
        entityType: 'airplanes',
        filter,
        scope: { case: 'countries', value: { countryIds: ['c-fr', 'c-il'] } },
      },
    },
  },
  {
    body: {
      case: 'openView',
      value: {
        viewRef: 'v2',
        entityType: 'airports',
        filter: '',
        scope: { case: 'connectionId', value: 'conn-1' },
      },
    },
  },
  { body: { case: 'closeView', value: { viewRef: 'v1' } } },
  {
    body: {
      case: 'setLayout',
      value: {
        viewRef: 'v1',
        groupBy: ['airline', 'country'],
        sort: { field: 'callsign', dir: SortDirection.DESC },
      },
    },
  },
  { body: { case: 'subscribeMap', value: { viewRef: 'v1' } } },
  { body: { case: 'unsubscribeMap', value: { viewRef: 'v1' } } },
  {
    body: {
      case: 'setWindow',
      value: { viewRef: 'v1', groupPath: ['LY'], page: 3, pageSize: 50, windowRef: 'main' },
    },
  },
  { body: { case: 'openDetail', value: { entityType: 'airplanes', id: 'a-1' } } },
  { body: { case: 'closeDetail', value: { entityType: 'airplanes', id: 'a-1' } } },
  { body: { case: 'locate', value: { viewRef: 'v1', id: 'a-1', pageSize: 50 } } },
  { body: { case: 'resync', value: { subId: 'v:abc:map' } } },
];

const positions = new Float64Array([34.78, 32.08, 1200.5, 2.35, 48.85, 0, -0.45, 51.47, 10_000]);
const icons = new Uint16Array([1, 7, 65_535]);

const mapDelta = {
  upsertIds: ['a-1', 'a-2', 'a-3'],
  positions: packPositions(positions),
  icons: packIcons(icons),
  removeIds: ['a-9'],
  labels: ['LY001', '', 'BA2'],
};

const row = {
  id: 'a-1',
  version: 42n,
  fields: {
    callsign: 'LY001',
    altitude: 11_000.5,
    onGround: false,
    airportId: null,
    crew: ['p1', 'p2'],
    airport: { name: 'TLV', runwayCount: 3 },
  },
};

const pageWindow = {
  orderedIds: ['a-1', 'a-2'],
  rows: [row],
  total: 120,
  pageCount: 3,
  groupCounts: [
    { groupPath: ['LY'], count: 80 },
    { groupPath: ['BA'], count: 40 },
  ],
  groupPath: ['LY'],
  page: 2,
  pageSize: 50,
};

/** One populated sample per ServerMessage body case (plus every Snapshot state and DetailUpdate state). */
const serverSamples: ServerMessageInit[] = [
  {
    subId: 'v:abc:map',
    seq: 1,
    body: {
      case: 'snapshot',
      value: { kind: SubscriptionKind.MAP, viewRef: 'v1', state: { case: 'map', value: mapDelta } },
    },
  },
  {
    subId: 'v:abc:page:LY:2:50',
    seq: 7,
    body: {
      case: 'snapshot',
      value: {
        kind: SubscriptionKind.PAGE,
        viewRef: 'v1',
        windowRef: 'main',
        state: { case: 'page', value: pageWindow },
      },
    },
  },
  {
    subId: 'd:airplanes:a-1',
    seq: 1,
    body: {
      case: 'snapshot',
      value: {
        kind: SubscriptionKind.DETAIL,
        state: {
          case: 'detail',
          value: { entityType: 'airplanes', id: 'a-1', state: { case: 'row', value: row } },
        },
      },
    },
  },
  { subId: 'v:abc:map', seq: 2, body: { case: 'mapDelta', value: mapDelta } },
  { subId: 'v:abc:page:LY:2:50', seq: 8, body: { case: 'pageWindow', value: pageWindow } },
  {
    subId: 'd:airplanes:a-1',
    seq: 2,
    body: {
      case: 'detailUpdate',
      value: { entityType: 'airplanes', id: 'a-1', state: { case: 'row', value: row } },
    },
  },
  {
    subId: 'd:airplanes:a-1',
    seq: 3,
    body: {
      case: 'detailUpdate',
      value: { entityType: 'airplanes', id: 'a-1', state: { case: 'removed', value: true } },
    },
  },
  {
    body: {
      case: 'locateResult',
      value: { viewRef: 'v1', id: 'a-1', found: true, groupPath: ['LY'], page: 4 },
    },
  },
  { body: { case: 'reconnect', value: { afterMs: 12_345 } } },
  {
    body: {
      case: 'error',
      value: { code: ErrorCode.INVALID_FILTER, message: 'unknown field "foo"', viewRef: 'v1' },
    },
  },
  {
    subId: 'v:abc:map',
    body: { case: 'error', value: { code: ErrorCode.AUTH, message: 'access revoked' } },
  },
  { body: { case: 'error', value: { code: ErrorCode.LIMIT, message: 'too many views' } } },
  { body: { case: 'error', value: { code: ErrorCode.RETRY, message: 'owner moving' } } },
];

describe('client messages', () => {
  it('has a sample for every ClientMessage body case', () => {
    const cases = ClientMessageSchema.oneofs[0]?.fields.map((f) => f.localName) ?? [];
    expect(cases.length).toBe(11);
    expect(new Set(clientSamples.map((s) => s.body?.case))).toEqual(new Set(cases));
  });

  it.each(clientSamples.map((s) => [s.body?.case, s] as const))('round-trips %s', (_case, init) => {
    const msg = create(ClientMessageSchema, init);
    const bytes = encodeClient(msg);
    const decoded: ClientMessage = decodeClient(bytes);
    expect(equals(ClientMessageSchema, decoded, msg)).toBe(true);
    // Init objects encode the same as created messages.
    expect(encodeClient(init)).toEqual(bytes);
    // ArrayBuffer input (WebSocket binaryType = 'arraybuffer').
    const copy = bytes.slice();
    expect(equals(ClientMessageSchema, decodeClient(copy.buffer), msg)).toBe(true);
  });

  it('keeps the filter tree as JSON text', () => {
    const decoded = decodeClient(encodeClient(clientSamples[1]!));
    expect(decoded.body.case).toBe('openView');
    if (decoded.body.case !== 'openView') return;
    expect(JSON.parse(decoded.body.value.filter)).toEqual(JSON.parse(filter));
    expect(decoded.body.value.scope).toEqual({
      case: 'countries',
      value: expect.objectContaining({ countryIds: ['c-fr', 'c-il'] }),
    });
  });
});

describe('server messages', () => {
  it('has a sample for every ServerMessage body case', () => {
    const cases = ServerMessageSchema.oneofs[0]?.fields.map((f) => f.localName) ?? [];
    expect(cases.length).toBe(7);
    expect(new Set(serverSamples.map((s) => s.body?.case))).toEqual(new Set(cases));
  });

  it.each(serverSamples.map((s, i) => [`${i}:${s.body?.case}`, s] as const))(
    'round-trips %s',
    (_case, init) => {
      const msg = create(ServerMessageSchema, init);
      const bytes = encodeServer(msg);
      const decoded: ServerMessage = decodeServer(bytes);
      expect(equals(ServerMessageSchema, decoded, msg)).toBe(true);
      expect(decoded.subId).toBe(init.subId ?? '');
      expect(decoded.seq).toBe(init.seq ?? 0);
    },
  );

  it('decodes MapDelta bytes back into typed arrays', () => {
    const decoded = decodeServer(encodeServer(serverSamples[3]!));
    if (decoded.body.case !== 'mapDelta') throw new Error('expected mapDelta');
    const d = decoded.body.value;
    expect(unpackPositions(d.positions)).toEqual(positions);
    expect(unpackIcons(d.icons)).toEqual(icons);
    expect(d.labels).toEqual(['LY001', '', 'BA2']);
  });

  it('exposes Row.fields (google.protobuf.Struct) as a plain JSON object', () => {
    const decoded = decodeServer(encodeServer(serverSamples[5]!));
    if (decoded.body.case !== 'detailUpdate' || decoded.body.value.state.case !== 'row')
      throw new Error('expected row');
    expect(decoded.body.value.state.value.fields).toEqual(row.fields);
    expect(decoded.body.value.state.value.version).toBe(42n);
  });
});

describe('bindSnapshot', () => {
  it('adds viewRef and windowRef to an encoded owner snapshot without changing the rest', () => {
    const ownerInit: ServerMessageInit = {
      subId: 'v:abc:page:LY:2:50',
      seq: 9,
      body: {
        case: 'snapshot',
        value: { kind: SubscriptionKind.PAGE, state: { case: 'page', value: pageWindow } },
      },
    };
    const ownerBytes = encodeServer(ownerInit);
    const bound = decodeServer(bindSnapshot(ownerBytes, { viewRef: 'v7', windowRef: 'prefetch' }));

    const expected = create(ServerMessageSchema, ownerInit);
    if (expected.body.case !== 'snapshot') throw new Error('unreachable');
    expected.body.value.viewRef = 'v7';
    expected.body.value.windowRef = 'prefetch';
    expect(equals(ServerMessageSchema, bound, expected)).toBe(true);
  });
});
