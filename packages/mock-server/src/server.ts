import { createHmac } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ErrorCode } from '@atlas/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { registryMetadata } from './registry.js';
import { MockSession } from './session.js';
import type { MockConnection } from './session.js';
import { World } from './world.js';
import type { WorldOptions } from './world.js';

export interface MockServerOptions extends WorldOptions {
  /** HTTP and WebSocket port (default 8090; 0 = any free port). */
  port?: number;
  host?: string;
  /** World steps per second (default 10). */
  ticksPerSecond?: number;
  /** Airplane position updates per second (default 2 000). */
  updatesPerSecond?: number;
  /** Start paused (steps only through `step()` or `POST /control/step`). */
  paused?: boolean;
  /** Append every frame (both directions) to this JSONL file. */
  record?: string;
  /** Serve the frames of a recording instead of the simulated world. */
  replay?: string;
  /** Replay speed factor (default 1). */
  replaySpeed?: number;
  /** Forward every connection to this upstream WebSocket URL (a real worker), e.g. for recording. */
  proxy?: string;
  /** HS256 key for `POST /dev/token` (default `atlas-dev-key`, or env DEV_JWT_SECRET). */
  devJwtSecret?: string;
  /** Time source for fault windows (tests). */
  clock?: () => number;
  log?: (line: string) => void;
}

export type Fault =
  | { type: 'drop'; count?: number; session?: string }
  | { type: 'duplicate'; count?: number; session?: string }
  | { type: 'delay'; ms: number; session?: string }
  | { type: 'disconnect'; code?: number; session?: string }
  | { type: 'reconnect'; afterMs?: number; closeAfterMs?: number; session?: string }
  | { type: 'slow'; ms: number; maxQueued?: number; session?: string }
  | {
      type: 'error';
      code: 'INVALID_FILTER' | 'LIMIT' | 'AUTH' | 'RETRY';
      message?: string;
      session?: string;
    };

const FAULT_TYPES = ['drop', 'duplicate', 'delay', 'disconnect', 'reconnect', 'slow', 'error'];

interface Attached {
  session: MockSession;
  /** Abrupt close (no close frame), for the disconnect fault. */
  terminate: (code: number) => void;
}

/** A recorded frame (one JSONL line). */
export interface RecordedFrame {
  /** Milliseconds since the recording started. */
  t: number;
  /** Session (connection) id. */
  s: string;
  d: 'in' | 'out';
  /** Frame bytes, base64. */
  b: string;
}

/**
 * The mock view service (C-07): HTTP dev and control endpoints plus a WebSocket endpoint that
 * speaks the real client protocol, over a simulated world. See README for the endpoints.
 */
export class MockServer {
  readonly world: World;
  private readonly sessions = new Map<string, Attached>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused: boolean;
  private ticksPerSecond: number;
  private updatesPerSecond: number;
  private recorder: WriteStream | null = null;
  private readonly startedAt = Date.now();
  private readonly clock: () => number;
  private readonly secret: string;
  private readonly log: (line: string) => void;
  private stepCount = 0;
  private updatesApplied = 0;
  private stepTimeMs = 0;

  constructor(private readonly options: MockServerOptions = {}) {
    this.world = new World(options);
    this.paused = options.paused ?? false;
    this.ticksPerSecond = options.ticksPerSecond ?? 10;
    this.updatesPerSecond = options.updatesPerSecond ?? 2_000;
    this.clock = options.clock ?? Date.now;
    this.secret = options.devJwtSecret ?? process.env['DEV_JWT_SECRET'] ?? 'atlas-dev-key';
    this.log = options.log ?? (() => {});
  }

  /** Starts HTTP + WebSocket on `port` and the world loop. Resolves with the bound port. */
  async listen(): Promise<number> {
    if (this.options.record) this.recorder = createWriteStream(this.options.record, { flags: 'a' });
    this.http = createServer((req, res) => {
      this.onHttp(req, res).catch((e: unknown) => sendJson(res, 500, { error: String(e) }));
    });
    this.wss = new WebSocketServer({ server: this.http, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.onSocket(ws, req));
    await new Promise<void>((resolve) => {
      this.http?.listen(this.options.port ?? 8090, this.options.host ?? '127.0.0.1', resolve);
    });
    this.startLoop();
    const addr: string | AddressInfo | null = this.http.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    this.log(`mock server on http://${this.options.host ?? '127.0.0.1'}:${port} (ws path /ws)`);
    return port;
  }

  async close(): Promise<void> {
    this.stopLoop();
    for (const a of this.sessions.values()) a.session.close(1001, 'server stopping');
    this.sessions.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) =>
      this.http ? this.http.close(() => resolve()) : resolve(),
    );
    await new Promise<void>((resolve) => (this.recorder ? this.recorder.end(resolve) : resolve()));
  }

  /**
   * Attaches a connection that is not a ws socket (in-process tests). Returns the callbacks the
   * caller wires to its transport.
   */
  attach(conn: MockConnection): {
    onMessage: (d: Uint8Array) => void;
    onClose: () => void;
    session: MockSession;
  } {
    const session = this.newSession(conn, () => conn.close(1006, 'terminated'));
    return {
      session,
      onMessage: (d) => {
        this.record(session.id, 'in', d);
        session.onMessage(d);
      },
      onClose: () => this.detach(session),
    };
  }

  /** One world step: moves airplanes and sends every client its changes. */
  step(
    dtMs = 1_000 / this.ticksPerSecond,
    moves = Math.round(this.updatesPerSecond / this.ticksPerSecond),
  ): void {
    const t0 = performance.now();
    const changes = this.world.step(dtMs, moves);
    for (const a of this.sessions.values()) a.session.onStep(changes);
    this.stepTimeMs += performance.now() - t0;
    this.stepCount++;
    this.updatesApplied += changes.moved.size;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setRate(updatesPerSecond?: number, ticksPerSecond?: number): void {
    if (updatesPerSecond !== undefined) this.updatesPerSecond = updatesPerSecond;
    if (ticksPerSecond !== undefined && ticksPerSecond !== this.ticksPerSecond) {
      this.ticksPerSecond = ticksPerSecond;
      this.stopLoop();
      this.startLoop();
    }
  }

  /** Applies a fault to one session (`fault.session`) or to all of them. */
  fault(fault: Fault): number {
    const targets = [...this.sessions.values()].filter(
      (a) => !fault.session || a.session.id === fault.session,
    );
    const now = this.clock();
    for (const { session, terminate } of targets) {
      switch (fault.type) {
        case 'drop':
          session.faults.drop += fault.count ?? 1;
          break;
        case 'duplicate':
          session.faults.duplicate += fault.count ?? 1;
          break;
        case 'delay':
          session.faults.delayUntil = now + fault.ms;
          setTimeout(() => session.flushHeld(), fault.ms + 1).unref();
          break;
        case 'slow':
          session.faults.slowUntil = now + fault.ms;
          session.faults.slowMax = fault.maxQueued ?? 200;
          setTimeout(() => session.flushHeld(), fault.ms + 1).unref();
          break;
        case 'disconnect':
          terminate(fault.code ?? 1006);
          break;
        case 'reconnect': {
          const afterMs = fault.afterMs ?? Math.floor(Math.random() * 15_000);
          session.sendReconnect(afterMs);
          const closeAfter = fault.closeAfterMs ?? afterMs + 2_000;
          setTimeout(() => session.close(1001, 'planned shutdown'), closeAfter).unref();
          break;
        }
        case 'error':
          session.error(ErrorCode[fault.code], fault.message ?? `injected ${fault.code}`);
          break;
      }
    }
    return targets.length;
  }

  stats() {
    const elapsedS = (Date.now() - this.startedAt) / 1_000;
    return {
      entities: { airplanes: this.world.airplanes.size, airports: this.world.airports.size },
      paused: this.paused,
      ticksPerSecond: this.ticksPerSecond,
      updatesPerSecond: this.updatesPerSecond,
      steps: this.stepCount,
      updatesApplied: this.updatesApplied,
      avgStepMs: this.stepCount ? this.stepTimeMs / this.stepCount : 0,
      uptimeS: elapsedS,
      sessions: [...this.sessions.values()].map(({ session }) => ({
        id: session.id,
        userId: session.userId,
        views: session.viewCount,
        subscriptions: session.subscriptionCount,
        ...session.stats,
      })),
    };
  }

  /** Session ids currently connected. */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // ---------------------------------------------------------------------------

  private startLoop(): void {
    if (this.options.replay || this.options.proxy) return;
    // Time-based: each tick moves `updatesPerSecond * elapsed` airplanes (with a fractional
    // carry), so timer drift does not lower the update rate.
    let last = performance.now();
    let carry = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(1_000, now - last);
      last = now;
      if (this.paused) {
        carry = 0;
        for (const a of this.sessions.values()) a.session.flushHeld();
        return;
      }
      const exact = (this.updatesPerSecond * dt) / 1_000 + carry;
      const moves = Math.floor(exact);
      carry = exact - moves;
      this.step(dt, moves);
    }, 1_000 / this.ticksPerSecond);
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private newSession(conn: MockConnection, terminate: (code: number) => void): MockSession {
    let session: MockSession;
    const recordingConn: MockConnection = {
      send: (d) => {
        this.record(session.id, 'out', d);
        conn.send(d);
      },
      close: (c, r) => conn.close(c, r),
    };
    session = new MockSession(recordingConn, this.world, this.clock);
    this.sessions.set(session.id, { session, terminate });
    this.log(`session ${session.id} connected`);
    return session;
  }

  private detach(session: MockSession): void {
    session.markClosed();
    this.sessions.delete(session.id);
    this.log(`session ${session.id} closed`);
  }

  private onSocket(ws: WebSocket, req: IncomingMessage): void {
    if (this.options.replay) {
      this.replayTo(ws);
      return;
    }
    if (this.options.proxy) {
      this.proxyTo(ws, req);
      return;
    }
    const session = this.newSession(
      {
        send: (d) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(d);
        },
        close: (code, reason) => ws.close(code ?? 1000, reason),
      },
      () => ws.terminate(),
    );
    ws.on('message', (data: RawData) => {
      const bytes = toBytes(data);
      this.record(session.id, 'in', bytes);
      session.onMessage(bytes);
    });
    ws.on('close', () => this.detach(session));
    ws.on('error', () => this.detach(session));
  }

  private replayTo(ws: WebSocket): void {
    const frames = readRecording(this.options.replay ?? '');
    const first = frames.find((f) => f.d === 'out');
    const out = frames.filter((f) => f.d === 'out' && f.s === first?.s);
    const t0 = out[0]?.t ?? 0;
    const speed = this.options.replaySpeed ?? 1;
    const timers = out.map((f) =>
      setTimeout(
        () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(f.b, 'base64'));
        },
        (f.t - t0) / speed,
      ),
    );
    ws.on('close', () => timers.forEach(clearTimeout));
    this.log(`replaying ${out.length} frames of session ${first?.s ?? '-'}`);
  }

  private proxyTo(ws: WebSocket, req: IncomingMessage): void {
    const id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const upstream = new WebSocket(new URL(req.url ?? '/', this.options.proxy).toString());
    const pending: Uint8Array[] = [];
    upstream.on('open', () => {
      for (const d of pending) upstream.send(d);
      pending.length = 0;
    });
    upstream.on('message', (data: RawData) => {
      const bytes = toBytes(data);
      if (ws.readyState !== WebSocket.OPEN) return;
      // Record only what the client was actually sent.
      this.record(id, 'out', bytes);
      ws.send(bytes);
    });
    ws.on('message', (data: RawData) => {
      const bytes = toBytes(data);
      this.record(id, 'in', bytes);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes);
      else pending.push(bytes);
    });
    upstream.on('close', (code, reason) => ws.close(code === 1005 ? 1000 : code, reason));
    upstream.on('error', () => ws.close(1011, 'upstream error'));
    ws.on('close', () => upstream.close());
  }

  private record(session: string, d: 'in' | 'out', bytes: Uint8Array): void {
    if (!this.recorder) return;
    const line: RecordedFrame = {
      t: Date.now() - this.startedAt,
      s: session,
      d,
      b: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    };
    this.recorder.write(`${JSON.stringify(line)}\n`);
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://mock');
    const route = `${req.method} ${url.pathname}`;
    const body = req.method === 'POST' ? await readJson(req) : {};
    switch (route) {
      case 'GET /health':
        return sendJson(res, 200, { ok: true });
      case 'GET /dev/scopes':
        return sendJson(res, 200, {
          countries: [...this.world.countries.values()]
            .map(({ id, code, name, region }) => ({ id, code, name, region }))
            .toSorted((a, b) => a.code.localeCompare(b.code)),
          connections: [...this.world.connections.values()].map(
            ({ id, name, countryIds, criteria }) => ({
              id,
              name,
              countryIds,
              criteria,
            }),
          ),
        });
      case 'POST /dev/token': {
        const countries = Array.isArray(body['countries']) ? body['countries'].map(String) : [];
        const connectionId = typeof body['connectionId'] === 'string' ? body['connectionId'] : null;
        const userId = typeof body['userId'] === 'string' ? body['userId'] : 'dev-user';
        const exp = Math.floor(Date.now() / 1_000) + 8 * 3_600;
        const token = signJwt(
          {
            sub: userId,
            userId,
            allowedCountries: countries,
            allowedConnections: connectionId ? [connectionId] : [],
            exp,
          },
          this.secret,
        );
        return sendJson(res, 200, { token, expiresAt: new Date(exp * 1_000).toISOString() });
      }
      case 'GET /meta/registry':
        return sendJson(res, 200, registryMetadata());
      case 'GET /control/state':
        return sendJson(res, 200, this.stats());
      case 'POST /control/fault': {
        const fault = toFault(body);
        if (!fault) {
          return sendJson(res, 400, { error: `type must be one of ${FAULT_TYPES.join(', ')}` });
        }
        const sessions = this.fault(fault);
        return sendJson(res, 200, { applied: sessions });
      }
      case 'POST /control/pause':
        this.setPaused(true);
        return sendJson(res, 200, { paused: true });
      case 'POST /control/resume':
        this.setPaused(false);
        return sendJson(res, 200, { paused: false });
      case 'POST /control/step': {
        const count = Math.max(1, Math.min(1_000, Number(body['count'] ?? 1)));
        for (let i = 0; i < count; i++) this.step();
        return sendJson(res, 200, { steps: count });
      }
      case 'POST /control/rate': {
        const ups = body['updatesPerSecond'];
        const tps = body['ticksPerSecond'];
        this.setRate(
          typeof ups === 'number' ? ups : undefined,
          typeof tps === 'number' ? tps : undefined,
        );
        return sendJson(res, 200, {
          updatesPerSecond: this.updatesPerSecond,
          ticksPerSecond: this.ticksPerSecond,
        });
      }
      default:
        return sendJson(res, 404, { error: `no route ${route}` });
    }
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) if (Buffer.isBuffer(c)) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
}

const ERROR_CODES = ['INVALID_FILTER', 'LIMIT', 'AUTH', 'RETRY'] as const;

/** Validates a `POST /control/fault` body. */
export function toFault(body: Record<string, unknown>): Fault | null {
  const num = (k: string): number | undefined => {
    const v = body[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const opt = (k: string): Record<string, number> => {
    const v = num(k);
    return v === undefined ? {} : { [k]: v };
  };
  const session = typeof body['session'] === 'string' ? { session: body['session'] } : {};
  switch (body['type']) {
    case 'drop':
      return { type: 'drop', ...opt('count'), ...session };
    case 'duplicate':
      return { type: 'duplicate', ...opt('count'), ...session };
    case 'delay':
      return { type: 'delay', ms: num('ms') ?? 1_000, ...session };
    case 'slow':
      return { type: 'slow', ms: num('ms') ?? 2_000, ...opt('maxQueued'), ...session };
    case 'disconnect':
      return { type: 'disconnect', ...opt('code'), ...session };
    case 'reconnect':
      return { type: 'reconnect', ...opt('afterMs'), ...opt('closeAfterMs'), ...session };
    case 'error': {
      const code = ERROR_CODES.find((c) => c === body['code']) ?? 'RETRY';
      const message = typeof body['message'] === 'string' ? { message: body['message'] } : {};
      return { type: 'error', code, ...message, ...session };
    }
    default:
      return null;
  }
}

function base64urlJson(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

/** HS256 JWT (dev only). */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const head = `${base64urlJson({ alg: 'HS256', typ: 'JWT' })}.${base64urlJson(claims)}`;
  const sig = createHmac('sha256', secret).update(head).digest('base64url');
  return `${head}.${sig}`;
}

/** Reads a JSONL recording written with `record`. */
export function readRecording(path: string): RecordedFrame[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      const f: unknown = JSON.parse(l);
      return isRecordedFrame(f) ? [f] : [];
    });
}

function isRecordedFrame(f: unknown): f is RecordedFrame {
  return (
    typeof f === 'object' &&
    f !== null &&
    't' in f &&
    typeof f.t === 'number' &&
    's' in f &&
    typeof f.s === 'string' &&
    'd' in f &&
    (f.d === 'in' || f.d === 'out') &&
    'b' in f &&
    typeof f.b === 'string'
  );
}
