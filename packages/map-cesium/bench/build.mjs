// Bundles the benchmark page (and the SDK worker for mock mode) into bench/dist with esbuild.
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
