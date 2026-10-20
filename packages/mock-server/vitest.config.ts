import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources (no build needed for tests).
  resolve: { conditions: ['@atlas/source'] },
  ssr: { resolve: { conditions: ['@atlas/source'] } },
  test: { include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'], testTimeout: 60_000 },
});
