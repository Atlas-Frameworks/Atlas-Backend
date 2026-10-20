/**
 * One bidirectional binary channel to one view service. Implementations: the browser
 * WebSocket ({@link webSocketTransport}) and the in-memory pair used by tests
 * (testing/in-memory-transport.ts).
 */
export interface CloseInfo {
  code: number;
  reason: string;
}

export interface Transport {
  /** Sends one encoded ClientMessage. Dropped silently if the transport is not open. */
  send(data: Uint8Array): void;
  onOpen(cb: () => void): void;
  /** One encoded ServerMessage per call. */
  onMessage(cb: (data: Uint8Array) => void): void;
  /** Called once, whether the close was local, remote or a failed connect. */
  onClose(cb: (info: CloseInfo) => void): void;
  close(code?: number, reason?: string): void;
}

/** Opens a new transport to `url`. Called again for every reconnect. */
export type TransportFactory = (url: string) => Transport;

function noop(): void {}

/** WebSocket.send wants an ArrayBuffer-backed view (never a SharedArrayBuffer). */
function asArrayBufferView(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data.buffer instanceof ArrayBuffer
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data.slice();
}

/** Transport over the WHATWG WebSocket (browsers, Web Workers and Node 22+). */
export function webSocketTransport(url: string): Transport {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let onOpen: () => void = noop;
  let onMessage: (data: Uint8Array) => void = noop;
  let onClose: (info: CloseInfo) => void = noop;
  let closed = false;
  const fireClose = (info: CloseInfo): void => {
    if (closed) return;
    closed = true;
    onClose(info);
  };
  ws.addEventListener('open', () => onOpen());
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) onMessage(new Uint8Array(ev.data));
  });
  ws.addEventListener('close', (ev: CloseEvent) => fireClose({ code: ev.code, reason: ev.reason }));
  ws.addEventListener('error', () => fireClose({ code: 1006, reason: 'error' }));
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(asArrayBufferView(data));
    },
    onOpen(cb) {
      onOpen = cb;
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
    },
    close(code = 1000, reason = '') {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
      }
      fireClose({ code, reason });
    },
  };
}
