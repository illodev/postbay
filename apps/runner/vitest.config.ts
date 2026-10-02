import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    // The integration tests share one PostgreSQL server and spawn real processes: one file at a time keeps them honest.
    fileParallelism: false,
  },
});
