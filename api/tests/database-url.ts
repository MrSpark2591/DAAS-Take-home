/**
 * The one place the test database URL is decided.
 *
 * It matters that this is shared: Vitest loads `api/.env` into `process.env`,
 * so anything reading `process.env.DATABASE_URL` during setup would silently
 * get the *development* database and migrate the wrong one. Both the Vitest
 * config and the global setup import this constant instead.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://daas:daas@localhost:5432/daas_test?schema=public';
