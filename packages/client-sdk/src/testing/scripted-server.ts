import { SubscriptionKind, decodeClient, encodeServer } from '@atlas/protocol';
import type { ClientMessage, ServerMessageInit } from '@atlas/protocol';
import { InMemoryNetwork } from '../core/in-memory-transport.js';
import type { InMemoryServerEnd } from '../core/in-memory-transport.js';

type ClientCase = NonNullable<ClientMessage['body']['case']>;
type ClientValue<C extends ClientCase> = Extract<ClientMessage['body'], { case: C }>['value'];

/**
 * A hand-driven server over {@link InMemoryNetwork} for deterministic SDK tests: inspect what
 * the client sent, then push exactly the frames the test needs.
 */
export class ScriptedServer {
  readonly net: InMemoryNetwork;

  constructor(options: { autoAccept?: boolean } = { autoAccept: true }) {
    this.net = new InMemoryNetwork({ autoAccept: options.autoAccept ?? true });
  }

  get factory() {
    return this.net.factory;
  }

  get conn(): InMemoryServerEnd {
    const c = this.net.last;
    if (!c) throw new Error('no connection yet');
    return c;
  }

  flush(): void {
    this.net.flush();
  }

  /** Decoded client messages on a connection (default: the latest). */
  received(conn: InMemoryServerEnd = this.conn): ClientMessage[] {
    return conn.received.map((b) => decodeClient(b));
  }

  /** The `case` of each received client message. */
  cases(conn: InMemoryServerEnd = this.conn): ClientCase[] {
    return this.received(conn).map((m) => m.body.case as ClientCase);
  }

  /** Received messages of one kind, unwrapped. */
  ofCase<C extends ClientCase>(c: C, conn: InMemoryServerEnd = this.conn): ClientValue<C>[] {
    return this.received(conn)
      .filter((m) => m.body.case === c)
      .map((m) => m.body.value as ClientValue<C>);
  }

  send(msg: ServerMessageInit, conn: InMemoryServerEnd = this.conn): void {
    conn.send(encodeServer(msg));
  }

  /** Sends a map snapshot binding `subId` to the client's `viewRef`. */
  mapSnapshot(
    subId: string,
    seq: number,
    viewRef: string,
    map: {
      upsertIds?: string[];
      positions?: Uint8Array;
      icons?: Uint8Array;
      labels?: string[];
    } = {},
  ): void {
    this.send({
      subId,
      seq,
      body: {
        case: 'snapshot',
        value: {
          kind: SubscriptionKind.MAP,
          viewRef,
          state: { case: 'map', value: map },
        },
      },
    });
  }

  mapDelta(
    subId: string,
    seq: number,
    delta: {
      upsertIds?: string[];
      positions?: Uint8Array;
      icons?: Uint8Array;
      removeIds?: string[];
      labels?: string[];
    } = {},
  ): void {
    this.send({ subId, seq, body: { case: 'mapDelta', value: delta } });
  }
}
