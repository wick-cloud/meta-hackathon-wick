import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
