import { defineConfig } from 'vitest/config';

// Load test (`npm run bench -w @atlas/mock-server`): timing-sensitive, so not part of `npm test`.
export default defineConfig({
  resolve: { conditions: ['@atlas/source'] },
  ssr: { resolve: { conditions: ['@atlas/source'] } },
  test: { include: ['test/**/*.perf.ts'], testTimeout: 180_000 },
});
