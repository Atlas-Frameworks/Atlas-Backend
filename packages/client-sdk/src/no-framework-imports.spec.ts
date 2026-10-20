import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN =
  /^(@angular\/|react($|\/|-dom)|cesium$|@cesium\/|deck\.gl$|@deck\.gl\/|maplibre-gl$|mapbox-gl$)/;
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

describe('package boundary', () => {
  it('imports no UI framework or map library (AGENTS.md)', () => {
    const offenders: string[] = [];
    for (const file of sources(import.meta.dirname)) {
      if (file === import.meta.filename) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? '';
        if (FORBIDDEN.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner catches a forbidden import', () => {
    const sample = "import { Viewer } from 'cesium';\nimport type { Signal } from '@angular/core';";
    const specs = [...sample.matchAll(IMPORT)].map((m) => m[1]);
    expect(specs.filter((s) => FORBIDDEN.test(s ?? ''))).toEqual(['cesium', '@angular/core']);
  });
});
