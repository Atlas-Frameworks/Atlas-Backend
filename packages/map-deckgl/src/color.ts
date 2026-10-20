export type Rgba = [number, number, number, number];

/**
 * Parses the CSS colors `LayerStyle` uses (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`,
 * `rgba()`) into deck.gl's 0–255 RGBA. Anything else returns `fallback`.
 */
export function parseColor(css: string | undefined, fallback: Rgba): Rgba {
  if (!css) return fallback;
  const s = css.trim().toLowerCase();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return fallback;
    if (hex.length === 3 || hex.length === 4) {
      const c = hex.split('').map((h) => parseInt(h + h, 16));
      return [c[0]!, c[1]!, c[2]!, c[3] ?? 255];
    }
    if (hex.length === 6 || hex.length === 8) {
      const c = [0, 2, 4, 6].map((i) => (i < hex.length ? parseInt(hex.slice(i, i + 2), 16) : 255));
      return [c[0]!, c[1]!, c[2]!, c[3]!];
    }
    return fallback;
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (!m) return fallback;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return fallback;
  const rgb = parts.slice(0, 3).map(Number);
  if (rgb.some((v) => !Number.isFinite(v))) return fallback;
  const alphaPart = parts[3];
  const alpha =
    alphaPart === undefined
      ? 1
      : alphaPart.endsWith('%')
        ? Number(alphaPart.slice(0, -1)) / 100
        : Number(alphaPart);
  if (!Number.isFinite(alpha)) return fallback;
  return [clamp(rgb[0]!), clamp(rgb[1]!), clamp(rgb[2]!), clamp(alpha * 255)];
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
