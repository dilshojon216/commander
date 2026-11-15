import { defineConfig } from 'vitest/config';

// Repository darajasidagi testlar: haqiqiy TimescaleDB kerak (TEST_DATABASE_URL).
// Ishga tushirish: docs/infra/mac-center.md "Sxema testlari".
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/db/**/*.db-spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
