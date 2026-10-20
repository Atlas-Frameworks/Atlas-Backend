import { POSITION_STRIDE, unpackIcons, unpackPositions } from '@atlas/protocol';
import type { MapDelta, ServerMessage, Snapshot } from '@atlas/protocol';
import type { SubscriptionHandler, SubscriptionState } from '../core/subscription.js';

export interface LayerStoreOptions {
  /** Initial slot capacity (default 1 024); grows by doubling. */
  initialCapacity?: number;
  /** Called after every applied snapshot or delta. */
  onChange?: () => void;
  onStateChange?: (state: SubscriptionState, staleSince: number | null) => void;
}

/**
 * The map data of one map subscription, in typed arrays indexed by a stable slot.
 *
 * - entity id <-> slot; a slot keeps its entity for as long as the entity exists;
 * - `positions` (lon, lat, alt), `icons`, `visible`, plus labels by slot;
 * - a removed entity's slot is hidden at once but reused only after the next frame has been
 *   sent ({@link frameSent}), so a pick against the previous frame never returns a wrong id.
 *
 * Applying a delta allocates nothing per entity.
 */
export class MapLayerStore implements SubscriptionHandler {
  capacity: number;
  /** High-water mark: slots `0 .. count-1` have been used. */
  count = 0;
  positions: Float64Array;
  icons: Uint16Array;
  visible: Uint8Array;
  /** slot -> entity id (`''` when free). */
  readonly ids: string[] = [];
  readonly labels = new Map<number, string>();
  /** Bumped on every change; the frame scheduler compares it. */
  version = 0;
  /** Live entities. */
  size = 0;

  private readonly slotOf = new Map<string, number>();
  private freeSlots: number[] = [];
  private pendingFree: number[] = [];
  /** Slots whose id changed since the last frame (may repeat). */
  private changedSlots: number[] = [];
  /** Snapshot marking: slots seen in the current snapshot. */
  private seenEpoch = 1;
  private seen: Uint32Array;
  private reported: Uint8Array;

  constructor(
    readonly layerId: string,
    private readonly options: LayerStoreOptions = {},
  ) {
    this.capacity = Math.max(16, options.initialCapacity ?? 1_024);
    this.positions = new Float64Array(this.capacity * POSITION_STRIDE);
    this.icons = new Uint16Array(this.capacity);
    this.visible = new Uint8Array(this.capacity);
    this.seen = new Uint32Array(this.capacity);
    this.reported = new Uint8Array(this.capacity);
  }

  // ---------------------------------------------------------------------------
  // SubscriptionHandler
  // ---------------------------------------------------------------------------

  applySnapshot(snapshot: Snapshot): void {
    if (snapshot.state.case !== 'map') return;
    const map = snapshot.state.value;
    // Keep the slots of entities that are still present (stable picking across resyncs).
    const epoch = ++this.seenEpoch;
    this.upsert(map, epoch);
    for (let slot = 0; slot < this.count; slot++) {
      const id = this.ids[slot];
      if (id && this.seen[slot] !== epoch) this.removeSlot(slot, id);
    }
    this.touch();
  }

  applyDelta(msg: ServerMessage): void {
    if (msg.body.case !== 'mapDelta') return;
    const delta = msg.body.value;
    this.upsert(delta, 0);
    const removes = delta.removeIds;
    for (let i = 0; i < removes.length; i++) {
      const id = removes[i]!;
      const slot = this.slotOf.get(id);
      if (slot !== undefined) this.removeSlot(slot, id);
    }
    this.touch();
  }

  onStateChange(state: SubscriptionState, staleSince: number | null): void {
    this.options.onStateChange?.(state, staleSince);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  slotOfId(id: string): number | undefined {
    return this.slotOf.get(id);
  }

  idAt(slot: number): string | null {
    return this.ids[slot] || null;
  }

  /**
   * Hands the slots whose id changed since the last call to `fn` and clears the list. Each slot
   * is reported at most once.
   */
  drainIdChanges(fn: (slot: number, id: string) => void): number {
    const list = this.changedSlots;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const slot = list[i]!;
      if (this.reported[slot] === 1) continue; // already reported in this drain
      this.reported[slot] = 1;
      fn(slot, this.ids[slot] ?? '');
      n++;
    }
    for (let i = 0; i < list.length; i++) this.reported[list[i]!] = 0;
    list.length = 0;
    return n;
  }

  /** A frame including every change so far was sent: freed slots may now be reused. */
  frameSent(): void {
    if (this.pendingFree.length === 0) return;
    for (let i = 0; i < this.pendingFree.length; i++) {
      this.freeSlots.push(this.pendingFree[i]!);
    }
    this.pendingFree.length = 0;
  }

  /** Drops everything (subscription closed). */
  clear(): void {
    for (let slot = 0; slot < this.count; slot++) {
      const id = this.ids[slot];
      if (id) this.removeSlot(slot, id);
    }
    this.touch();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private upsert(delta: MapDelta, epoch: number): void {
    const ids = delta.upsertIds;
    const n = ids.length;
    if (n === 0) return;
    const pos = unpackPositions(delta.positions);
    const icons = delta.icons.byteLength > 0 ? unpackIcons(delta.icons) : null;
    const labels = delta.labels.length === n ? delta.labels : null;
    if (pos.length !== n * POSITION_STRIDE) {
      throw new RangeError(`map delta has ${n} ids but ${pos.length / POSITION_STRIDE} positions`);
    }
    for (let i = 0; i < n; i++) {
      const id = ids[i]!;
      let slot = this.slotOf.get(id);
      if (slot === undefined) slot = this.allocate(id);
      const p = slot * POSITION_STRIDE;
      const q = i * POSITION_STRIDE;
      this.positions[p] = pos[q]!;
      this.positions[p + 1] = pos[q + 1]!;
      this.positions[p + 2] = pos[q + 2]!;
      if (icons) this.icons[slot] = icons[i]!;
      this.visible[slot] = 1;
      if (labels) {
        const label = labels[i]!;
        if (label) this.labels.set(slot, label);
        else this.labels.delete(slot);
      }
      if (epoch !== 0) this.seen[slot] = epoch;
    }
  }

  private allocate(id: string): number {
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      if (this.count === this.capacity) this.grow();
      slot = this.count++;
    }
    this.ids[slot] = id;
    this.slotOf.set(id, slot);
    this.changedSlots.push(slot);
    this.size++;
    return slot;
  }

  private removeSlot(slot: number, id: string): void {
    this.slotOf.delete(id);
    this.ids[slot] = '';
    this.visible[slot] = 0;
    this.labels.delete(slot);
    this.pendingFree.push(slot);
    this.changedSlots.push(slot);
    this.size--;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const positions = new Float64Array(cap * POSITION_STRIDE);
    positions.set(this.positions);
    const icons = new Uint16Array(cap);
    icons.set(this.icons);
    const visible = new Uint8Array(cap);
    visible.set(this.visible);
    const seen = new Uint32Array(cap);
    seen.set(this.seen);
    this.positions = positions;
    this.icons = icons;
    this.visible = visible;
    this.seen = seen;
    this.reported = new Uint8Array(cap);
    this.capacity = cap;
  }

  private touch(): void {
    this.version++;
    this.options.onChange?.();
  }
}
