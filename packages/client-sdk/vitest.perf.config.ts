import { defineConfig } from 'vitest/config';

// Benchmarks (`npm run bench`): timing-sensitive, so not part of `npm test`.
export default defineConfig({
  resolve: { conditions: ['@atlas/source'] },
  ssr: { resolve: { conditions: ['@atlas/source'] } },
  test: { include: ['bench/**/*.perf.ts'], testTimeout: 120_000 },
});
