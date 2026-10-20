import type { CloseInfo, Transport, TransportFactory } from './transport.js';

/**
 * The server side of an in-memory connection. Tests (and the mock server's in-process mode)
 * script the server through it.
 */
export interface InMemoryServerEnd {
  readonly url: string;
  /** Frames the client sent, in order (encoded ClientMessages). */
  readonly received: Uint8Array[];
  /** Completes the connect: the client's `onOpen` fires on the next flush. */
  accept(): void;
  /** Queues one encoded ServerMessage for the client. */
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: (info: CloseInfo) => void): void;
  /** Closes from the server side (the client sees `onClose`). */
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
}

type Delivery = () => void;

function noop(): void {}

/**
 * Creates in-memory transports. Every delivery is queued and runs on {@link flush} (or on a
 * microtask with `autoFlush`), so callbacks never re-enter each other and tests control
 * exactly when frames arrive.
 */
export class InMemoryNetwork {
  /** Every connection made, oldest first. */
  readonly connections: InMemoryServerEnd[] = [];
  private readonly queue: Delivery[] = [];
  private flushScheduled = false;
  private onConnectCb: ((end: InMemoryServerEnd) => void) | undefined;

  constructor(private readonly options: { autoFlush?: boolean; autoAccept?: boolean } = {}) {}

  /** Called for every new connection (before it is accepted). */
  onConnect(cb: (end: InMemoryServerEnd) => void): void {
    this.onConnectCb = cb;
  }

  readonly factory: TransportFactory = (url) => this.connect(url);

  /** The most recent connection, if any. */
  get last(): InMemoryServerEnd | undefined {
    return this.connections[this.connections.length - 1];
  }

  /** Delivers every queued callback, including ones queued while flushing. */
  flush(): void {
    let guard = 0;
    while (this.queue.length > 0) {
      if (++guard > 1_000_000) throw new Error('InMemoryNetwork.flush: delivery loop');
      this.queue.shift()?.();
    }
  }

  private enqueue(d: Delivery): void {
    this.queue.push(d);
    if (this.options.autoFlush && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }

  private connect(url: string): Transport {
    let state: 'connecting' | 'open' | 'closed' = 'connecting';
    let clientOpen: () => void = noop;
    let clientMessage: (d: Uint8Array) => void = noop;
    let clientClose: (i: CloseInfo) => void = noop;
    let serverMessage: (d: Uint8Array) => void = noop;
    let serverClose: (i: CloseInfo) => void = noop;
    const received: Uint8Array[] = [];

    const closeBoth = (info: CloseInfo): void => {
      if (state === 'closed') return;
      state = 'closed';
      this.enqueue(() => clientClose(info));
      this.enqueue(() => serverClose(info));
    };

    const end: InMemoryServerEnd = {
      url,
      received,
      accept: () => {
        if (state !== 'connecting') return;
        state = 'open';
        this.enqueue(() => clientOpen());
      },
      send: (data) => {
        if (state !== 'open') return;
        const copy = data.slice();
        this.enqueue(() => {
          if (state === 'open') clientMessage(copy);
        });
      },
      onMessage: (cb) => {
        serverMessage = cb;
      },
      onClose: (cb) => {
        serverClose = cb;
      },
      close: (code = 1000, reason = '') => closeBoth({ code, reason }),
      get isOpen() {
        return state === 'open';
      },
    };

    const transport: Transport = {
      send: (data) => {
        if (state !== 'open') return;
        const copy = data.slice();
        received.push(copy);
        this.enqueue(() => {
          if (state === 'open') serverMessage(copy);
        });
      },
      onOpen: (cb) => {
        clientOpen = cb;
      },
      onMessage: (cb) => {
        clientMessage = cb;
      },
      onClose: (cb) => {
        clientClose = cb;
      },
      close: (code = 1000, reason = '') => closeBoth({ code, reason }),
    };

    this.connections.push(end);
    this.onConnectCb?.(end);
    if (this.options.autoAccept) end.accept();
    return transport;
  }
}
