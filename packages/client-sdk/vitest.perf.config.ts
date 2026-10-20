import { defineConfig } from 'vitest/config';

// Benchmarks (`npm run bench`): timing-sensitive, so not part of `npm test`.
export default defineConfig({
  test: { include: ['bench/**/*.perf.ts'], testTimeout: 120_000 },
});
