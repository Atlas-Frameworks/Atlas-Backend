// Bundles the benchmark page (page + SDK worker for live mode) into bench/dist with esbuild.
import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: {
    bench: 'bench/bench.ts',
    'sdk.worker': 'bench/sdk.worker.ts',
  },
  outdir: 'bench/dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  minify: true,
  conditions: ['@atlas/source'],
  logLevel: 'info',
});
await mkdir('bench/dist', { recursive: true });
await copyFile('../../node_modules/maplibre-gl/dist/maplibre-gl.css', 'bench/dist/maplibre-gl.css');
