/**
 * One drawable set of points per layer, indexed by slot. Three implementations behind the
 * same small interface so {@link CesiumAdapter} does the change detection once:
 *
 * - {@link BufferPointSet}: `BufferPointCollection` (experimental in Cesium 1.146). Points live in
 *   one ArrayBuffer; a single flyweight `BufferPoint` is rebound per write, so updates allocate
 *   nothing and Cesium re-packs only the points marked dirty.
 * - {@link PrimitivePointSet}: `PointPrimitiveCollection`, one `PointPrimitive` object per slot.
 * - {@link BillboardPointSet}: `BillboardCollection`, used when the layer style has icons.
 *
 * Slots are never removed from a collection: a freed slot is hidden (`show = false`) and reused
 * when the SDK hands the slot to another entity. Collections are destroyed by the layer's
 * `PrimitiveCollection` that holds them.
 */
import {
  type Billboard,
  BillboardCollection,
  BlendOption,
  BoundingSphere,
  BufferPoint,
  BufferPointCollection,
  BufferPointMaterial,
  Cartesian3,
  Color,
  Ellipsoid,
  type PointPrimitive,
  PointPrimitiveCollection,
} from 'cesium';

export interface PointSet {
  /** The Cesium primitive to add to the scene. Changes only when {@link ensureCapacity} returns true. */
  readonly primitive: BufferPointCollection | PointPrimitiveCollection | BillboardCollection;
  /** Number of slots that have a point (all hidden until shown). */
  readonly length: number;
  /**
   * Makes slots `0 .. count-1` exist. Returns true when the set had to rebuild its primitive (a
   * new {@link primitive}, every slot hidden and unpositioned again).
   */
  ensureCapacity(count: number): boolean;
  setPosition(slot: number, position: Cartesian3): void;
  setShow(slot: number, show: boolean): void;
  /** Icon index into the style's icon list (only {@link BillboardPointSet} draws icons). */
  setIcon(slot: number, icon: number): void;
  /** The slot a `scene.pick` result refers to, or -1 when it is not one of this set's points. */
  slotOf(picked: unknown): number;
}

export interface PointStyle {
  color: Color;
  pixelSize: number;
  outlineColor: Color;
  outlineWidth: number;
  icons: readonly string[];
  iconSize: number;
}

/** Reads a property of an untyped `scene.pick` result. */
export function prop(o: unknown, key: string): unknown {
  return typeof o === 'object' && o !== null ? (Reflect.get(o, key) as unknown) : undefined;
}

/**
 * The whole globe plus 1,000 km. BufferPointCollection otherwise recomputes its bounding sphere
 * over every point whenever any point moves, which is O(n) per frame.
 */
const GLOBE_BOUNDS = new BoundingSphere(Cartesian3.ZERO, Ellipsoid.WGS84.maximumRadius + 1_000_000);

const MIN_BUFFER_CAPACITY = 1024;

export class BufferPointSet implements PointSet {
  primitive: BufferPointCollection;
  length = 0;
  private readonly point = new BufferPoint();
  private readonly material: BufferPointMaterial;

  constructor(style: PointStyle) {
    this.material = new BufferPointMaterial({
      color: style.color,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      size: style.pixelSize,
    });
    this.primitive = this.create(MIN_BUFFER_CAPACITY);
  }

  private create(capacity: number): BufferPointCollection {
    return new BufferPointCollection({
      primitiveCountMax: capacity,
      allowPicking: true,
      blendOption: BlendOption.OPAQUE,
      boundingVolume: GLOBE_BOUNDS,
    });
  }

  ensureCapacity(count: number): boolean {
    let rebuilt = false;
    if (count > this.primitive.primitiveCountMax) {
      // Buffer collections cannot grow: build a bigger one (the adapter re-sends every slot).
      let capacity = this.primitive.primitiveCountMax;
      while (capacity < count) capacity *= 2;
      // The old collection is removed (and destroyed) by the adapter's layer group.
      this.primitive = this.create(capacity);
      this.length = 0;
      rebuilt = true;
    }
    const c = this.primitive;
    for (let slot = this.length; slot < count; slot++) {
      c.add({ show: false, material: this.material, position: Cartesian3.ZERO }, this.point);
    }
    if (count > this.length) this.length = count;
    return rebuilt;
  }

  setPosition(slot: number, position: Cartesian3): void {
    this.primitive.get(slot, this.point);
    this.point.setPosition(position);
  }

  setShow(slot: number, show: boolean): void {
    this.primitive.get(slot, this.point).show = show;
  }

  setIcon(): void {}

  slotOf(picked: unknown): number {
    if (prop(picked, 'collection') !== this.primitive) return -1;
    const index = prop(picked, 'index');
    return typeof index === 'number' ? index : -1;
  }
}

export class PrimitivePointSet implements PointSet {
  readonly primitive = new PointPrimitiveCollection({ blendOption: BlendOption.OPAQUE });
  private readonly points: PointPrimitive[] = [];

  constructor(private readonly style: PointStyle) {}

  get length(): number {
    return this.points.length;
  }

  ensureCapacity(count: number): boolean {
    const s = this.style;
    for (let slot = this.points.length; slot < count; slot++) {
      // The pick payload is the slot; pick() resolves it through the slot -> id table.
      this.points.push(
        this.primitive.add({
          show: false,
          id: slot,
          color: s.color,
          pixelSize: s.pixelSize,
          outlineColor: s.outlineColor,
          outlineWidth: s.outlineWidth,
        }),
      );
    }
    return false;
  }

  setPosition(slot: number, position: Cartesian3): void {
    // The setter copies into the point's own Cartesian3; `position` is the caller's scratch.
    this.points[slot]!.position = position;
  }

  setShow(slot: number, show: boolean): void {
    this.points[slot]!.show = show;
  }

  setIcon(): void {}

  slotOf(picked: unknown): number {
    if (prop(picked, 'collection') !== this.primitive) return -1;
    const id = prop(picked, 'id');
    return typeof id === 'number' ? id : -1;
  }
}

export class BillboardPointSet implements PointSet {
  readonly primitive = new BillboardCollection({
    // Icons usually have anti-aliased edges, which need the translucent pass.
    blendOption: BlendOption.OPAQUE_AND_TRANSLUCENT,
  });
  private readonly billboards: Billboard[] = [];

  constructor(private readonly style: PointStyle) {}

  get length(): number {
    return this.billboards.length;
  }

  ensureCapacity(count: number): boolean {
    const s = this.style;
    for (let slot = this.billboards.length; slot < count; slot++) {
      this.billboards.push(
        this.primitive.add({
          show: false,
          id: slot,
          position: Cartesian3.ZERO,
          // Every billboard refers to an icon by URL; the collection's texture atlas keys images
          // by that URL, so each icon is loaded and registered once per layer.
          image: s.icons[0] ?? '',
          width: s.iconSize,
          height: s.iconSize,
        }),
      );
    }
    return false;
  }

  setPosition(slot: number, position: Cartesian3): void {
    this.billboards[slot]!.position = position;
  }

  setShow(slot: number, show: boolean): void {
    this.billboards[slot]!.show = show;
  }

  setIcon(slot: number, icon: number): void {
    const url = this.style.icons[icon] ?? this.style.icons[0];
    if (url !== undefined) this.billboards[slot]!.image = url;
  }

  slotOf(picked: unknown): number {
    if (prop(picked, 'collection') !== this.primitive) return -1;
    const id = prop(picked, 'id');
    return typeof id === 'number' ? id : -1;
  }
}
