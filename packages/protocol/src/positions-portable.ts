/**
 * Endian-independent (DataView) packing, used by positions.ts on big-endian
 * hosts. Kept separate so the fallback is unit-tested on little-endian CI.
 */

export function packFloat64LE(values: Float64Array): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat64(i * 8, values[i] ?? 0, true);
  }
  return out;
}

export function unpackFloat64LE(bytes: Uint8Array): Float64Array {
  const count = bytes.byteLength >>> 3;
  const out = new Float64Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat64(i * 8, true);
  }
  return out;
}

export function packUint16LE(values: Uint16Array): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setUint16(i * 2, values[i] ?? 0, true);
  }
  return out;
}

export function unpackUint16LE(bytes: Uint8Array): Uint16Array {
  const count = bytes.byteLength >>> 1;
  const out = new Uint16Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    out[i] = view.getUint16(i * 2, true);
  }
  return out;
}
