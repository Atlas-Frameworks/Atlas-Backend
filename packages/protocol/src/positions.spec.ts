import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { decodeServer, encodeServer } from './codec.js';
import {
  packFloat64LE,
  packUint16LE,
  unpackFloat64LE,
  unpackUint16LE,
} from './positions-portable.js';
import {
  HOST_IS_LITTLE_ENDIAN,
  packIcons,
  packPositions,
  unpackIcons,
  unpackPositions,
} from './positions.js';

const ENTITIES = 30_000;

function median(xs: number[]): number {
  return xs.toSorted((a, b) => a - b)[xs.length >> 1] ?? 0;
}

function samplePositions(n: number): Float64Array {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = -180 + ((i * 7.3) % 360);
    out[i * 3 + 1] = -90 + ((i * 3.1) % 180);
    out[i * 3 + 2] = (i * 13) % 12_000;
  }
  return out;
}

function sampleIcons(n: number): Uint16Array {
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 65_536;
  return out;
}

describe('positions', () => {
  it('runs on a little-endian host (wire format matches memory layout)', () => {
    expect(HOST_IS_LITTLE_ENDIAN).toBe(true);
  });

  it('packs zero-copy and unpacks aligned bytes zero-copy', () => {
    const p = samplePositions(10);
    const bytes = packPositions(p);
    expect(bytes.buffer).toBe(p.buffer);
    expect(bytes.byteLength).toBe(10 * 24);
    const back = unpackPositions(bytes);
    expect(back.buffer).toBe(p.buffer);
    expect(back).toEqual(p);
  });

  it('copies once when the bytes are not 8-byte aligned', () => {
    const p = samplePositions(4);
    const padded = new Uint8Array(p.byteLength + 3);
    padded.set(packPositions(p), 3);
    const unaligned = padded.subarray(3);
    const back = unpackPositions(unaligned);
    expect(back.buffer).not.toBe(padded.buffer);
    expect(back).toEqual(p);
  });

  it('handles a subarray of a Float64Array (non-zero byteOffset)', () => {
    const all = samplePositions(6);
    const tail = all.subarray(9); // entities 3..5
    expect(unpackPositions(packPositions(tail))).toEqual(tail);
  });

  it('rejects lengths that are not whole entities', () => {
    expect(() => packPositions(new Float64Array(4))).toThrow(RangeError);
    expect(() => unpackPositions(new Uint8Array(30))).toThrow(RangeError);
    expect(() => unpackIcons(new Uint8Array(3))).toThrow(RangeError);
  });

  it('round-trips positions and icons through an encoded MapDelta frame', () => {
    const p = samplePositions(ENTITIES);
    const ic = sampleIcons(ENTITIES);
    const frame = encodeServer({
      subId: 'v:x:map',
      seq: 1,
      body: { case: 'mapDelta', value: { positions: packPositions(p), icons: packIcons(ic) } },
    });
    const msg = decodeServer(frame);
    if (msg.body.case !== 'mapDelta') throw new Error('expected mapDelta');
    expect(unpackPositions(msg.body.value.positions)).toEqual(p);
    expect(unpackIcons(msg.body.value.icons)).toEqual(ic);
  });

  it('icons: zero-copy pack, unaligned unpack copies', () => {
    const ic = sampleIcons(5);
    const bytes = packIcons(ic);
    expect(bytes.buffer).toBe(ic.buffer);
    expect(unpackIcons(bytes).buffer).toBe(ic.buffer);
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes, 1);
    expect(unpackIcons(padded.subarray(1))).toEqual(ic);
  });

  it('portable (DataView) fallback writes the same little-endian bytes', () => {
    const p = samplePositions(100);
    const ic = sampleIcons(100);
    expect(packFloat64LE(p)).toEqual(new Uint8Array(p.buffer.slice(0)));
    expect(packUint16LE(ic)).toEqual(new Uint8Array(ic.buffer.slice(0)));
    const padded = new Uint8Array(p.byteLength + 1);
    padded.set(packFloat64LE(p), 1);
    expect(unpackFloat64LE(padded.subarray(1))).toEqual(p);
    expect(unpackUint16LE(packUint16LE(ic))).toEqual(ic);
  });

  it(`packs and unpacks ${ENTITIES} positions in under 5 ms`, () => {
    const p = samplePositions(ENTITIES);
    const ids = Array.from({ length: ENTITIES }, (_, i) => `a-${i}`);
    // A copy of the packed bytes at an odd offset: the realistic (copying) unpack path.
    const unalignedHost = new Uint8Array(p.byteLength + 1);
    unalignedHost.set(packPositions(p), 1);
    const unaligned = unalignedHost.subarray(1);

    const runs = 50;
    const t = {
      aligned: [] as number[],
      copy: [] as number[],
      portable: [] as number[],
      frame: [] as number[],
    };
    let checksum = 0;
    for (let r = 0; r < runs; r++) {
      let t0 = performance.now();
      const back = unpackPositions(packPositions(p));
      t.aligned.push(performance.now() - t0);
      checksum += back[back.length - 1] ?? 0;

      t0 = performance.now();
      const copy = unpackPositions(unaligned);
      t.copy.push(performance.now() - t0);
      checksum += copy[copy.length - 1] ?? 0;

      t0 = performance.now();
      const portable = unpackFloat64LE(packFloat64LE(p));
      t.portable.push(performance.now() - t0);
      checksum += portable[portable.length - 1] ?? 0;

      // Whole map snapshot frame: encode with 30k ids, decode, unpack.
      t0 = performance.now();
      const frame = encodeServer({
        subId: 'v:x:map',
        seq: r + 1,
        body: { case: 'mapDelta', value: { upsertIds: ids, positions: packPositions(p) } },
      });
      const msg = decodeServer(frame);
      if (msg.body.case === 'mapDelta')
        checksum += unpackPositions(msg.body.value.positions)[0] ?? 0;
      t.frame.push(performance.now() - t0);
    }
    const fmt = (xs: number[]) =>
      `median ${median(xs).toFixed(4)} ms, max ${Math.max(...xs).toFixed(4)} ms`;
    console.info(
      `[bench] ${ENTITIES} positions (${p.byteLength} bytes), ${runs} runs:\n` +
        `  pack+unpack, aligned (zero-copy):   ${fmt(t.aligned)}\n` +
        `  unpack, unaligned (one copy):       ${fmt(t.copy)}\n` +
        `  pack+unpack, DataView fallback:     ${fmt(t.portable)}\n` +
        `  encode+decode+unpack full frame:    ${fmt(t.frame)} (info only)`,
    );
    expect(checksum).not.toBeNaN();
    expect(median(t.aligned)).toBeLessThan(5);
    expect(median(t.copy)).toBeLessThan(5);
    expect(median(t.portable)).toBeLessThan(5);
  });
});
