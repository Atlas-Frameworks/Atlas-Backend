import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true, conditions: ['@atlas/source'] },
  ssr: { resolve: { conditions: ['@atlas/source'] } },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
