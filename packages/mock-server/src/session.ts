import {
  ErrorCode,
  PROTOCOL_VERSION,
  SortDirection,
  SubscriptionKind,
  decodeClient,
  encodeServer,
  packIcons,
  packPositions,
} from '@atlas/protocol';
import type { ClientMessage, OpenView, ServerMessageInit } from '@atlas/protocol';
import { FilterError, TYPES, matches, parseFilter, rowFields } from './registry.js';
import type { AnyType, FilterNode, Value } from './registry.js';
import type { ChangeSet, World } from './world.js';

/** One client connection as the session sees it (a ws socket or an in-memory end). */
export interface MockConnection {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Fault state of one session (see faults in server.ts). */
export interface SessionFaults {
  /** Sequenced frames still to drop (each one leaves a sequence gap). */
  drop: number;
  /** Sequenced frames still to send twice. */
  duplicate: number;
  /** Hold every frame until this time (then send in order). */
  delayUntil: number;
  /** Slow consumer: queue frames until this time; past `slowMax` queued, drop and re-snapshot. */
  slowUntil: number;
  slowMax: number;
}

interface View {
  viewRef: string;
  type: AnyType;
  filter: FilterNode | null;
  countries: Set<string> | null;
  criteria: { minAltitude?: number; airlines?: string[] };
  members: Set<string>;
  groupBy: string[];
  sortField: string;
  sortDir: 1 | -1;
  /** Sorted ids (by group values, then sort value, then id), rebuilt when `dirty`. */
  sorted: string[];
  /** Cached sort key per member. */
  keys: Map<string, Value[]>;
  dirty: boolean;
  counts: { groupPath: string[]; count: number }[];
}

interface BaseSub {
  subId: string;
  seq: number;
  needSnapshot: boolean;
}

interface MapSub extends BaseSub {
  kind: 'map';
  viewRef: string;
}

interface PageSub extends BaseSub {
  kind: 'page';
  viewRef: string;
  windowRef: string;
  groupPath: string[];
  page: number;
  pageSize: number;
  lastIds: string[];
  lastTotal: number;
  lastPage: number;
  lastCounts: string;
  sent: Map<string, number>;
}

interface DetailSub extends BaseSub {
  kind: 'detail';
  type: AnyType;
  id: string;
  lastVersion: number;
  removed: boolean;
}

type Sub = MapSub | PageSub | DetailSub;

export interface SessionStats {
  framesSent: number;
  bytesSent: number;
  framesDropped: number;
  /** `Resync` requests received. */
  resyncs: number;
}

const MAX_VIEWS = 50;

let sessionCounter = 0;

/**
 * One client connection: decodes ClientMessages, keeps that client's views and subscriptions,
 * and turns each world step into MapDelta / PageWindow / DetailUpdate frames with per-
 * subscription sequence numbers. Faults (drop, duplicate, delay, slow consumer) apply at send.
 */
export class MockSession {
  readonly id = `s${++sessionCounter}`;
  readonly faults: SessionFaults = {
    drop: 0,
    duplicate: 0,
    delayUntil: 0,
    slowUntil: 0,
    slowMax: 200,
  };
  readonly stats: SessionStats = { framesSent: 0, bytesSent: 0, framesDropped: 0, resyncs: 0 };
  authed = false;
  userId = '';
  private readonly views = new Map<string, View>();
  private readonly subs = new Map<string, Sub>();
  private readonly mapSubs = new Map<string, MapSub>();
  private readonly pageSubs = new Map<string, PageSub>();
  private readonly detailSubs = new Map<string, DetailSub>();
  private nextSub = 1;
  private held: Uint8Array[] = [];
  private closed = false;

  constructor(
    private readonly conn: MockConnection,
    private readonly world: World,
    private readonly clock: () => number,
    private readonly onIncoming?: (msg: ClientMessage) => void,
  ) {}

  get viewCount(): number {
    return this.views.size;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  // ---------------------------------------------------------------------------
  // Client -> server
  // ---------------------------------------------------------------------------

  onMessage(data: Uint8Array): void {
    let msg: ClientMessage;
    try {
      msg = decodeClient(data);
    } catch {
      this.error(ErrorCode.RETRY, 'undecodable frame');
      return;
    }
    this.onIncoming?.(msg);
    const b = msg.body;
    if (b.case !== 'auth' && !this.authed) {
      this.error(ErrorCode.AUTH, 'send Auth first');
      return;
    }
    switch (b.case) {
      case 'auth': {
        const v = b.value.protocolVersion;
        if (v !== PROTOCOL_VERSION && v !== PROTOCOL_VERSION - 1) {
          this.error(ErrorCode.AUTH, `unsupported protocol version ${v}`);
          this.conn.close(4001, 'protocol version');
          return;
        }
        if (!b.value.token) {
          this.error(ErrorCode.AUTH, 'missing token');
          return;
        }
        this.userId = tokenSubject(b.value.token);
        this.authed = true;
        return;
      }
      case 'openView':
        this.openView(b.value.viewRef, b.value.entityType, b.value.filter, b.value.scope);
        return;
      case 'closeView':
        this.closeView(b.value.viewRef);
        return;
      case 'setLayout': {
        const view = this.views.get(b.value.viewRef);
        if (!view) return;
        const groupable = new Set(view.type.fields.filter((f) => f.groupable).map((f) => f.name));
        const sortable = new Set(view.type.fields.filter((f) => f.sortable).map((f) => f.name));
        const groupBy = b.value.groupBy.slice(0, 2);
        const bad = groupBy.find((g) => !groupable.has(g));
        if (bad) {
          this.error(ErrorCode.INVALID_FILTER, `cannot group by "${bad}"`, view.viewRef);
          return;
        }
        view.groupBy = groupBy;
        const sortField = b.value.sort?.field || view.type.defaultSort;
        if (!sortable.has(sortField)) {
          this.error(ErrorCode.INVALID_FILTER, `cannot sort by "${sortField}"`, view.viewRef);
          return;
        }
        view.sortField = sortField;
        view.sortDir = b.value.sort?.dir === SortDirection.DESC ? -1 : 1;
        view.keys.clear();
        for (const id of view.members) view.keys.set(id, this.keyOf(view, id));
        view.dirty = true;
        return;
      }
      case 'subscribeMap': {
        const view = this.views.get(b.value.viewRef);
        if (!view) return;
        const prev = this.mapSubs.get(view.viewRef);
        if (prev) this.dropSub(prev);
        const sub: MapSub = {
          kind: 'map',
          subId: this.newSubId(),
          seq: 0,
          needSnapshot: false,
          viewRef: view.viewRef,
        };
        this.addSub(sub);
        this.mapSubs.set(view.viewRef, sub);
        this.sendSnapshot(sub);
        return;
      }
      case 'unsubscribeMap': {
        const sub = this.mapSubs.get(b.value.viewRef);
        if (sub) this.dropSub(sub);
        return;
      }
      case 'setWindow': {
        const { viewRef, windowRef, groupPath, page, pageSize } = b.value;
        const view = this.views.get(viewRef);
        if (!view) return;
        const key = `${viewRef}|${windowRef}`;
        const prev = this.pageSubs.get(key);
        if (prev) this.dropSub(prev);
        if (pageSize === 0) return;
        const sub: PageSub = {
          kind: 'page',
          subId: this.newSubId(),
          seq: 0,
          needSnapshot: false,
          viewRef,
          windowRef,
          groupPath: [...groupPath],
          page,
          pageSize: Math.min(pageSize, 500),
          lastIds: [],
          lastTotal: -1,
          lastPage: -1,
          lastCounts: '',
          sent: new Map(),
        };
        this.addSub(sub);
        this.pageSubs.set(key, sub);
        this.sendSnapshot(sub);
        return;
      }
      case 'openDetail': {
        const type = TYPES[b.value.entityType];
        if (!type) {
          this.error(ErrorCode.INVALID_FILTER, `unknown entity type "${b.value.entityType}"`);
          return;
        }
        const key = `${type.type}|${b.value.id}`;
        const prev = this.detailSubs.get(key);
        if (prev) this.dropSub(prev);
        const sub: DetailSub = {
          kind: 'detail',
          subId: this.newSubId(),
          seq: 0,
          needSnapshot: false,
          type,
          id: b.value.id,
          lastVersion: -1,
          removed: false,
        };
        this.addSub(sub);
        this.detailSubs.set(key, sub);
        this.sendSnapshot(sub);
        return;
      }
      case 'closeDetail': {
        const sub = this.detailSubs.get(`${b.value.entityType}|${b.value.id}`);
        if (sub) this.dropSub(sub);
        return;
      }
      case 'locate':
        this.locate(b.value.viewRef, b.value.id, b.value.pageSize);
        return;
      case 'resync': {
        this.stats.resyncs++;
        const sub = this.subs.get(b.value.subId);
        if (sub) this.sendSnapshot(sub);
        return;
      }
      default:
        return;
    }
  }

  private openView(
    viewRef: string,
    entityType: string,
    filterText: string,
    scope: OpenView['scope'],
  ): void {
    const type = TYPES[entityType];
    if (!type) {
      this.error(ErrorCode.INVALID_FILTER, `unknown entity type "${entityType}"`, viewRef);
      return;
    }
    if (!this.views.has(viewRef) && this.views.size >= MAX_VIEWS) {
      this.error(ErrorCode.LIMIT, `at most ${MAX_VIEWS} views per connection`, viewRef);
      return;
    }
    let filter: FilterNode | null;
    try {
      filter = parseFilter(type, filterText);
    } catch (e) {
      this.error(
        ErrorCode.INVALID_FILTER,
        e instanceof FilterError ? e.message : 'invalid filter',
        viewRef,
      );
      return;
    }
    this.closeView(viewRef);
    let countries: Set<string> | null = null;
    let criteria: View['criteria'] = {};
    if (scope.case === 'countries') {
      countries = new Set<string>(scope.value.countryIds);
    } else if (scope.case === 'connectionId') {
      const conn = this.world.connections.get(scope.value);
      if (!conn) {
        this.error(ErrorCode.AUTH, `unknown connection ${scope.value}`, viewRef);
        return;
      }
      countries = new Set(conn.countryIds);
      criteria = conn.criteria;
    }
    const view: View = {
      viewRef,
      type,
      filter,
      countries: countries && countries.size > 0 ? countries : null,
      criteria,
      members: new Set(),
      groupBy: [],
      sortField: type.defaultSort,
      sortDir: 1,
      sorted: [],
      keys: new Map(),
      dirty: true,
      counts: [],
    };
    for (const e of type.all(this.world)) {
      const id = type.id(e);
      if (this.isMember(view, e)) {
        view.members.add(id);
        view.keys.set(id, this.keyOf(view, id));
      }
    }
    this.views.set(viewRef, view);
  }

  private closeView(viewRef: string): void {
    if (!this.views.delete(viewRef)) return;
    const map = this.mapSubs.get(viewRef);
    if (map) this.dropSub(map);
    for (const sub of this.pageSubs.values()) if (sub.viewRef === viewRef) this.dropSub(sub);
  }

  private locate(viewRef: string, id: string, pageSize: number): void {
    const view = this.views.get(viewRef);
    if (!view) return;
    let size = pageSize;
    if (size === 0) {
      for (const s of this.pageSubs.values()) if (s.viewRef === viewRef) size = s.pageSize;
    }
    if (size === 0) size = 50;
    this.sortIfDirty(view);
    const found = view.members.has(id);
    let groupPath: string[] = [];
    let page = 0;
    if (found) {
      const key = view.keys.get(id) ?? [];
      groupPath = view.groupBy.map((_, i) => String(key[i] ?? ''));
      const list = this.idsInGroup(view, groupPath);
      page = Math.floor(list.indexOf(id) / size);
    }
    this.send({ body: { case: 'locateResult', value: { viewRef, id, found, groupPath, page } } });
  }

  // ---------------------------------------------------------------------------
  // World step -> frames
  // ---------------------------------------------------------------------------

  /** Sends what changed for this client's subscriptions. */
  onStep(changes: ChangeSet): void {
    if (this.closed) return;
    for (const view of this.views.values()) this.stepView(view, changes);
    for (const sub of this.detailSubs.values()) this.stepDetail(sub, changes);
    this.flushHeld();
  }

  private stepView(view: View, changes: ChangeSet): void {
    const t = view.type.type;
    const upserted = changes.upserted.get(t);
    const deleted = changes.deleted.get(t);
    const mapUpserts: string[] = [];
    const mapRemoves: string[] = [];
    if (upserted) {
      for (const id of upserted) {
        const e = view.type.get(this.world, id);
        const was = view.members.has(id);
        const is = e !== undefined && this.isMember(view, e);
        if (is) {
          if (!was) view.members.add(id);
          if (!was || changes.moved.has(id)) mapUpserts.push(id);
          const key = this.keyOf(view, id);
          const old = view.keys.get(id);
          if (!old || !sameKey(old, key)) {
            view.keys.set(id, key);
            view.dirty = true;
          }
          if (!was) view.dirty = true;
        } else if (was) {
          view.members.delete(id);
          view.keys.delete(id);
          mapRemoves.push(id);
          view.dirty = true;
        }
      }
    }
    if (deleted) {
      for (const id of deleted) {
        if (!view.members.delete(id)) continue;
        view.keys.delete(id);
        mapRemoves.push(id);
        view.dirty = true;
      }
    }
    const map = this.mapSubs.get(view.viewRef);
    if (map && (mapUpserts.length > 0 || mapRemoves.length > 0)) {
      this.sendSub(map, {
        case: 'mapDelta',
        value: { ...this.mapShapes(view.type, mapUpserts), removeIds: mapRemoves },
      });
    }
    for (const sub of this.pageSubs.values()) {
      if (sub.viewRef !== view.viewRef) continue;
      this.stepPage(view, sub, upserted);
    }
  }

  private stepPage(view: View, sub: PageSub, upserted: Set<string> | undefined): void {
    const w = this.pageWindow(view, sub);
    const idsChanged = !sameIds(w.orderedIds, sub.lastIds);
    const rows = [];
    for (const id of w.orderedIds) {
      const e = view.type.get(this.world, id);
      if (!e) continue;
      const v = view.type.version(e);
      if (sub.sent.get(id) !== v || (upserted?.has(id) && sub.sent.get(id) !== v)) {
        rows.push(this.row(view.type, e));
        sub.sent.set(id, v);
      }
    }
    const counts = JSON.stringify(w.groupCounts);
    if (
      !idsChanged &&
      rows.length === 0 &&
      w.total === sub.lastTotal &&
      w.page === sub.lastPage &&
      counts === sub.lastCounts
    ) {
      return;
    }
    // Forget rows that left the page, so they are sent again if they come back.
    const onPage = new Set(w.orderedIds);
    for (const id of sub.sent.keys()) if (!onPage.has(id)) sub.sent.delete(id);
    sub.lastIds = w.orderedIds;
    sub.lastTotal = w.total;
    sub.lastPage = w.page;
    sub.lastCounts = counts;
    this.sendSub(sub, { case: 'pageWindow', value: { ...w, rows } });
  }

  private stepDetail(sub: DetailSub, changes: ChangeSet): void {
    const t = sub.type.type;
    if (changes.deleted.get(t)?.has(sub.id)) {
      if (sub.removed) return;
      sub.removed = true;
      this.sendSub(sub, {
        case: 'detailUpdate',
        value: { entityType: t, id: sub.id, state: { case: 'removed', value: true } },
      });
      return;
    }
    if (!changes.upserted.get(t)?.has(sub.id)) return;
    const e = sub.type.get(this.world, sub.id);
    if (!e || sub.type.version(e) === sub.lastVersion) return;
    sub.lastVersion = sub.type.version(e);
    sub.removed = false;
    this.sendSub(sub, {
      case: 'detailUpdate',
      value: {
        entityType: t,
        id: sub.id,
        state: { case: 'row', value: this.detailRow(sub.type, e) },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Snapshots and frame building
  // ---------------------------------------------------------------------------

  /** Sends the full state of a subscription; it resets the client's seq baseline. */
  sendSnapshot(sub: Sub): void {
    sub.needSnapshot = false;
    if (sub.kind === 'map') {
      const view = this.views.get(sub.viewRef);
      if (!view) return;
      this.sendSub(
        sub,
        {
          case: 'snapshot',
          value: {
            kind: SubscriptionKind.MAP,
            viewRef: sub.viewRef,
            state: { case: 'map', value: this.mapShapes(view.type, [...view.members]) },
          },
        },
        true,
      );
    } else if (sub.kind === 'page') {
      const view = this.views.get(sub.viewRef);
      if (!view) return;
      const w = this.pageWindow(view, sub);
      sub.sent.clear();
      const rows = [];
      for (const id of w.orderedIds) {
        const e = view.type.get(this.world, id);
        if (!e) continue;
        rows.push(this.row(view.type, e));
        sub.sent.set(id, view.type.version(e));
      }
      sub.lastIds = w.orderedIds;
      sub.lastTotal = w.total;
      sub.lastPage = w.page;
      sub.lastCounts = JSON.stringify(w.groupCounts);
      this.sendSub(
        sub,
        {
          case: 'snapshot',
          value: {
            kind: SubscriptionKind.PAGE,
            viewRef: sub.viewRef,
            windowRef: sub.windowRef,
            state: { case: 'page', value: { ...w, rows } },
          },
        },
        true,
      );
    } else {
      const e = sub.type.get(this.world, sub.id);
      sub.removed = e === undefined;
      sub.lastVersion = e ? sub.type.version(e) : -1;
      this.sendSub(
        sub,
        {
          case: 'snapshot',
          value: {
            kind: SubscriptionKind.DETAIL,
            state: {
              case: 'detail',
              value: {
                entityType: sub.type.type,
                id: sub.id,
                state: e
                  ? { case: 'row', value: this.detailRow(sub.type, e) }
                  : { case: 'removed', value: true },
              },
            },
          },
        },
        true,
      );
    }
  }

  private mapShapes(type: AnyType, ids: string[]) {
    const positions = new Float64Array(ids.length * 3);
    const icons = new Uint16Array(ids.length);
    const labels: string[] = [];
    const out: string[] = [];
    let n = 0;
    for (const id of ids) {
      const e = type.get(this.world, id);
      if (!e || !type.mapShape) continue;
      const s = type.mapShape(e);
      positions[n * 3] = s.lon;
      positions[n * 3 + 1] = s.lat;
      positions[n * 3 + 2] = s.alt;
      icons[n] = s.icon;
      labels.push(s.label);
      out.push(id);
      n++;
    }
    return {
      upsertIds: out,
      positions: packPositions(positions.subarray(0, n * 3)),
      icons: packIcons(icons.subarray(0, n)),
      labels,
    };
  }

  private pageWindow(view: View, sub: PageSub) {
    this.sortIfDirty(view);
    const list = this.idsInGroup(view, sub.groupPath);
    const total = list.length;
    const pageCount = Math.ceil(total / sub.pageSize);
    const page = pageCount === 0 ? 0 : Math.min(sub.page, pageCount - 1);
    return {
      orderedIds: list.slice(page * sub.pageSize, (page + 1) * sub.pageSize),
      total,
      pageCount,
      groupCounts: view.counts,
      groupPath: sub.groupPath,
      page,
      pageSize: sub.pageSize,
    };
  }

  private idsInGroup(view: View, groupPath: string[]): string[] {
    if (groupPath.length === 0) return view.sorted;
    return view.sorted.filter((id) => {
      const key = view.keys.get(id);
      return key !== undefined && groupPath.every((g, i) => String(key[i] ?? '') === g);
    });
  }

  private sortIfDirty(view: View): void {
    if (!view.dirty) return;
    const g = view.groupBy.length;
    const dir = view.sortDir;
    view.sorted = [...view.members].toSorted((a, b) => {
      const ka = view.keys.get(a) ?? [];
      const kb = view.keys.get(b) ?? [];
      for (let i = 0; i <= g; i++) {
        const c = compare(ka[i] ?? null, kb[i] ?? null);
        if (c !== 0) return i === g ? c * dir : c;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    });
    // Group counts for every level of grouping.
    const counts = new Map<string, { groupPath: string[]; count: number }>();
    for (const id of view.sorted) {
      const key = view.keys.get(id) ?? [];
      for (let depth = 1; depth <= g; depth++) {
        const path = key.slice(0, depth).map((v) => String(v ?? ''));
        const k = path.join('\u0000');
        const c = counts.get(k);
        if (c) c.count++;
        else counts.set(k, { groupPath: path, count: 1 });
      }
    }
    view.counts = [...counts.values()];
    view.dirty = false;
  }

  private keyOf(view: View, id: string): Value[] {
    const e = view.type.get(this.world, id);
    if (!e) return [];
    const fields = [...view.groupBy, view.sortField];
    return fields.map(
      (name) => view.type.fields.find((f) => f.name === name)?.get(e, this.world) ?? null,
    );
  }

  private isMember(view: View, e: unknown): boolean {
    const t = view.type;
    if (view.countries && !view.countries.has(t.countryId(e))) return false;
    if (t.inCriteria && !t.inCriteria(e, view.criteria)) return false;
    return matches(t, view.filter, e, this.world);
  }

  private row(type: AnyType, e: unknown) {
    return {
      id: type.id(e),
      version: BigInt(type.version(e)),
      fields: rowFields(type, e, this.world),
    };
  }

  private detailRow(type: AnyType, e: unknown) {
    return {
      id: type.id(e),
      version: BigInt(type.version(e)),
      fields: { ...rowFields(type, e, this.world), ...type.detail(e, this.world) } as Record<
        string,
        any
      >,
    };
  }

  // ---------------------------------------------------------------------------
  // Sending, with faults
  // ---------------------------------------------------------------------------

  private sendSub(sub: Sub, body: NonNullable<ServerMessageInit['body']>, snapshot = false): void {
    if (!this.subs.has(sub.subId)) return;
    sub.seq++;
    const bytes = encodeServer({ subId: sub.subId, seq: sub.seq, body });
    if (!snapshot && this.faults.drop > 0) {
      this.faults.drop--;
      this.stats.framesDropped++;
      return;
    }
    this.emit(bytes, sub);
    if (this.faults.duplicate > 0) {
      this.faults.duplicate--;
      this.emit(bytes, sub);
    }
  }

  private send(msg: ServerMessageInit): void {
    this.emit(encodeServer(msg), null);
  }

  /** Sends an Error frame (connection-level, or about a view). */
  error(code: ErrorCode, message: string, viewRef = '', subId = ''): void {
    this.send({ subId, body: { case: 'error', value: { code, message, viewRef } } });
  }

  /** Planned shutdown: tells the client to reconnect after `afterMs`. */
  sendReconnect(afterMs: number): void {
    this.send({ body: { case: 'reconnect', value: { afterMs } } });
  }

  private readonly queuedSubs = new Set<Sub>();

  private emit(bytes: Uint8Array, sub: Sub | null): void {
    if (this.closed) return;
    const now = this.clock();
    if (now < this.faults.slowUntil) {
      this.held.push(bytes);
      if (sub) this.queuedSubs.add(sub);
      if (this.held.length > this.faults.slowMax) {
        // Past the send-buffer cap: drop queued deltas, re-snapshot once the buffer drains.
        this.stats.framesDropped += this.held.length;
        this.held = [];
        for (const s of this.queuedSubs) s.needSnapshot = true;
        this.queuedSubs.clear();
      }
      return;
    }
    if (now < this.faults.delayUntil || this.held.length > 0) {
      this.held.push(bytes);
      return;
    }
    this.write(bytes);
  }

  /** Sends frames held by a delay or slow-consumer fault once it is over. */
  flushHeld(): void {
    const now = this.clock();
    if (now < this.faults.slowUntil || now < this.faults.delayUntil) return;
    const held = this.held;
    this.held = [];
    this.queuedSubs.clear();
    for (const b of held) this.write(b);
    for (const sub of this.subs.values()) if (sub.needSnapshot) this.sendSnapshot(sub);
  }

  private write(bytes: Uint8Array): void {
    this.stats.framesSent++;
    this.stats.bytesSent += bytes.byteLength;
    this.conn.send(bytes);
  }

  // ---------------------------------------------------------------------------

  private newSubId(): string {
    return `${this.id}:${this.nextSub++}`;
  }

  private addSub(sub: Sub): void {
    this.subs.set(sub.subId, sub);
  }

  private dropSub(sub: Sub): void {
    this.subs.delete(sub.subId);
    if (sub.kind === 'map') this.mapSubs.delete(sub.viewRef);
    else if (sub.kind === 'page') this.pageSubs.delete(`${sub.viewRef}|${sub.windowRef}`);
    else this.detailSubs.delete(`${sub.type.type}|${sub.id}`);
  }

  /** The connection closed (from either side). */
  markClosed(): void {
    this.closed = true;
  }

  close(code = 1000, reason = ''): void {
    this.closed = true;
    this.conn.close(code, reason);
  }
}

function compare(a: Value, b: Value): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sameKey(a: Value[], b: Value[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The `sub` (or `userId`) claim of a dev JWT, without verifying it (the mock trusts dev tokens). */
function tokenSubject(token: string): string {
  const part = token.split('.')[1];
  if (!part) return 'anonymous';
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) return 'anonymous';
    const id = 'userId' in claims ? claims.userId : 'sub' in claims ? claims.sub : null;
    return typeof id === 'string' ? id : 'anonymous';
  } catch {
    return 'anonymous';
  }
}
