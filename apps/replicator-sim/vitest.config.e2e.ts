import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true, conditions: ['@atlas/source'] },
  ssr: { resolve: { conditions: ['@atlas/source'] } },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
