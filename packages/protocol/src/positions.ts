/**
 * Packing helpers for the `bytes` fields of MapDelta (P-01).
 *
 * Wire format: little-endian. `positions` is float64 lon, lat, alt per entity
 * (24 bytes each); `icons` is uint16 per entity (2 bytes each).
 *
 * On little-endian hosts (every browser and Node platform in use) packing is a
 * zero-copy view, and unpacking is a zero-copy view whenever the bytes are
 * suitably aligned. Bytes decoded by protobuf-es are a subarray of the frame,
 * so they are often not 8-byte aligned; then one copy is made. Big-endian
 * hosts fall back to DataView (positions-portable.ts).
 */
import {
  packFloat64LE,
  packUint16LE,
  unpackFloat64LE,
  unpackUint16LE,
} from './positions-portable.js';

/** Values per entity in a positions array: lon, lat, alt. */
export const POSITION_STRIDE = 3;
const POSITION_BYTES = 8 * POSITION_STRIDE;

/** True when this host stores typed arrays little-endian (checked once). */
export const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Float64Array of lon, lat, alt triples → bytes for `MapDelta.positions`.
 * Zero-copy on little-endian hosts: the result shares memory with `positions`,
 * so do not mutate `positions` until the message is encoded.
 */
export function packPositions(positions: Float64Array): Uint8Array {
  if (positions.length % POSITION_STRIDE !== 0) {
    throw new RangeError(
      `positions length ${positions.length} is not a multiple of ${POSITION_STRIDE}`,
    );
  }
  if (!HOST_IS_LITTLE_ENDIAN) return packFloat64LE(positions);
  return new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
}

/**
 * Bytes from `MapDelta.positions` → Float64Array of lon, lat, alt triples.
 * Zero-copy (a view on the same memory) when the bytes are 8-byte aligned on a
 * little-endian host; otherwise copies once.
 */
export function unpackPositions(bytes: Uint8Array): Float64Array {
  if (bytes.byteLength % POSITION_BYTES !== 0) {
    throw new RangeError(
      `positions byte length ${bytes.byteLength} is not a multiple of ${POSITION_BYTES}`,
    );
  }
  if (!HOST_IS_LITTLE_ENDIAN) return unpackFloat64LE(bytes);
  if (bytes.byteOffset % 8 === 0) {
    return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
  }
  // Unaligned (typical for a subarray of a decoded frame): copy once into a fresh buffer.
  return new Float64Array(bytes.slice().buffer);
}

/** Uint16Array of icon indexes → bytes for `MapDelta.icons`. Zero-copy on little-endian hosts. */
export function packIcons(icons: Uint16Array): Uint8Array {
  if (!HOST_IS_LITTLE_ENDIAN) return packUint16LE(icons);
  return new Uint8Array(icons.buffer, icons.byteOffset, icons.byteLength);
}

/** Bytes from `MapDelta.icons` → Uint16Array. Zero-copy when 2-byte aligned on a little-endian host. */
export function unpackIcons(bytes: Uint8Array): Uint16Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new RangeError(`icons byte length ${bytes.byteLength} is not a multiple of 2`);
  }
  if (!HOST_IS_LITTLE_ENDIAN) return unpackUint16LE(bytes);
  if (bytes.byteOffset % 2 === 0) {
    return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }
  return new Uint16Array(bytes.slice().buffer);
}
