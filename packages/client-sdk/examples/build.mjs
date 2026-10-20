// Bundles the plain-JS example (page + SDK worker) into examples/dist with esbuild.
import { build } from 'esbuild';

await build({
  entryPoints: {
    plain: 'examples/plain.ts',
    'sdk.worker': 'examples/sdk.worker.ts',
  },
  outdir: 'examples/dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  conditions: ['@atlas/source'],
  logLevel: 'info',
});
