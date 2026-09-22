import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './tests/database-url';

/**
 * Integration tests run against a real Postgres -- the same container from
 * docker-compose, but a separate `daas_test` database so they never touch
 * seeded dev data. `tests/global-setup.ts` creates and migrates it.
 */
export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    env: { DATABASE_URL: TEST_DATABASE_URL },
    // The concurrency test asserts that two receipts against one PO serialise.
    // Running files in parallel would add unrelated contention and make that
    // assertion ambiguous.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
  },
});
