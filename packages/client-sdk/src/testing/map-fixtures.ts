import {
  SubscriptionKind,
  decodeServer,
  encodeServer,
  packIcons,
  packPositions,
} from '@atlas/protocol';
import type { ServerMessage, Snapshot } from '@atlas/protocol';

/** A map entity for tests: id, lon, lat, alt, icon, label. */
export interface TestEntity {
  id: string;
  lon: number;
  lat: number;
  alt?: number;
  icon?: number;
  label?: string;
}

function packed(entities: TestEntity[]) {
  const pos = new Float64Array(entities.length * 3);
  const icons = new Uint16Array(entities.length);
  entities.forEach((e, i) => {
    pos[i * 3] = e.lon;
    pos[i * 3 + 1] = e.lat;
    pos[i * 3 + 2] = e.alt ?? 0;
    icons[i] = e.icon ?? 0;
  });
  return {
    upsertIds: entities.map((e) => e.id),
    positions: packPositions(pos),
    icons: packIcons(icons),
    labels: entities.some((e) => e.label !== undefined) ? entities.map((e) => e.label ?? '') : [],
  };
}

/** A decoded map snapshot frame (as the SDK receives it). */
export function mapSnapshot(
  entities: TestEntity[],
  seq = 1,
): { snap: Snapshot; msg: ServerMessage } {
  const msg = decodeServer(
    encodeServer({
      subId: 'm',
      seq,
      body: {
        case: 'snapshot',
        value: { kind: SubscriptionKind.MAP, state: { case: 'map', value: packed(entities) } },
      },
    }),
  );
  if (msg.body.case !== 'snapshot') throw new Error('unreachable');
  return { snap: msg.body.value, msg };
}

/** A decoded map delta frame. */
export function mapDelta(upserts: TestEntity[], removeIds: string[] = [], seq = 2): ServerMessage {
  return decodeServer(
    encodeServer({
      subId: 'm',
      seq,
      body: { case: 'mapDelta', value: { ...packed(upserts), removeIds } },
    }),
  );
}
