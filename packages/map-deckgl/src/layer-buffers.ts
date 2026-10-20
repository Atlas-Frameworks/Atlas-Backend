import type { MapFrame } from '@atlas/client-sdk';

/** lon, lat, alt per slot (contracts §7). */
const STRIDE = 3;

/**
 * deck.gl binary data: `length` instances, attributes read straight from typed arrays. deck.gl
 * compares the `data` object and each attribute `value` by reference, so a buffer set keeps the
 * same objects for as long as it lives and the sets alternate (see {@link LayerBuffers}).
 */
export interface BinaryData {
  length: number;
  attributes: {
    getPosition: { value: Float64Array; size: 3 };
  };
}

/** One generation of the GPU-bound arrays for a layer. Only `0 .. data.length-1` is valid. */
export interface BufferSet {
  /** Compacted positions of the visible slots, lon/lat/alt in double precision (deck.gl fp64). */
  positions: Float64Array;
  /** instance index -> slot, for picking. */
  slotOf: Uint32Array;
  /** instance index -> icon code. */
  icons: Uint16Array;
  data: BinaryData;
}

/** Labelled subset, same alternation as the points. */
export interface LabelSet {
  positions: Float64Array;
  texts: string[];
  data: { length: number };
}

/**
 * Turns {@link MapFrame}s into the arrays deck.gl uploads. Hidden slots are left out (so they are
 * neither drawn nor pickable) and the rest are packed densely, with `slotOf` mapping an instance
 * back to its slot. Two buffer sets alternate: the one the layer on screen still references is
 * never overwritten, and handing deck.gl the other set (a different `data` object and attribute
 * array) is what tells it to re-upload. A frame allocates nothing unless the layer grew.
 *
 * The frame's own buffers go back to the worker when `applyFrame` returns, so everything is copied.
 */
export class LayerBuffers {
  private readonly sets: [BufferSet, BufferSet];
  private readonly labelSets: [LabelSet, LabelSet];
  private front: 0 | 1 = 0;
  private frameIds: readonly string[] = [];
  /** Bumped on every applied frame; used as the deck.gl update trigger. */
  version = 0;

  constructor(initialCapacity = 1024) {
    this.sets = [allocSet(initialCapacity), allocSet(initialCapacity)];
    this.labelSets = [allocLabels(64), allocLabels(64)];
  }

  /** The set produced by the last {@link apply}. */
  get current(): BufferSet {
    return this.sets[this.front];
  }

  get currentLabels(): LabelSet {
    return this.labelSets[this.front];
  }

  /** Visible instances in the current set. */
  get length(): number {
    return this.current.data.length;
  }

  apply(frame: MapFrame): void {
    const next = this.front === 0 ? 1 : 0;
    const count = frame.count;
    let set = this.sets[next];
    if (set.slotOf.length < count) {
      set = allocSet(grow(set.slotOf.length, count));
      this.sets[next] = set;
    }
    const src = frame.positions;
    const visible = frame.visible;
    const icons = frame.icons;
    const dst = set.positions;
    const slotOf = set.slotOf;
    const iconsOut = set.icons;
    let n = 0;
    for (let slot = 0; slot < count; slot++) {
      if (visible[slot] === 0) continue;
      const s = slot * STRIDE;
      const d = n * STRIDE;
      dst[d] = src[s]!;
      dst[d + 1] = src[s + 1]!;
      dst[d + 2] = src[s + 2]!;
      slotOf[n] = slot;
      iconsOut[n] = icons[slot]!;
      n++;
    }
    set.data.length = n;

    let labels = this.labelSets[next];
    const labelCount = frame.labels.size;
    if (labels.texts.length < labelCount) {
      labels = allocLabels(grow(labels.texts.length, labelCount));
      this.labelSets[next] = labels;
    }
    let l = 0;
    for (const [slot, text] of frame.labels) {
      if (slot >= count || visible[slot] === 0) continue;
      const s = slot * STRIDE;
      const d = l * STRIDE;
      labels.positions[d] = src[s]!;
      labels.positions[d + 1] = src[s + 1]!;
      labels.positions[d + 2] = src[s + 2]!;
      labels.texts[l++] = text;
    }
    labels.data.length = l;

    // The SDK keeps one slot -> id table per layer and updates it in place; slots are reused only
    // after the next frame is sent, so the table always resolves the instances on screen.
    this.frameIds = frame.ids;
    this.front = next;
    this.version++;
  }

  /**
   * Entity id for instance `index` of the layer whose `data` prop is `data` (deck.gl reports the
   * layer it actually picked from, which may still be the previous set). Null when unknown.
   */
  idAt(data: unknown, index: number): string | null {
    const set =
      this.sets[0].data === data ? this.sets[0] : this.sets[1].data === data ? this.sets[1] : null;
    if (!set || index < 0 || index >= set.data.length) return null;
    const id = this.frameIds[set.slotOf[index]!];
    return id ? id : null;
  }
}

function grow(current: number, needed: number): number {
  let cap = Math.max(current, 1);
  while (cap < needed) cap *= 2;
  return cap;
}

function allocSet(capacity: number): BufferSet {
  const positions = new Float64Array(capacity * STRIDE);
  return {
    positions,
    slotOf: new Uint32Array(capacity),
    icons: new Uint16Array(capacity),
    data: { length: 0, attributes: { getPosition: { value: positions, size: 3 } } },
  };
}

function allocLabels(capacity: number): LabelSet {
  return {
    positions: new Float64Array(capacity * STRIDE),
    texts: Array.from({ length: capacity }, () => ''),
    data: { length: 0 },
  };
}
