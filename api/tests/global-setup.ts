import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from './database-url.js';

/**
 * Creates the test database if it is not there, then applies the checked-in
 * migrations to it. Running the real migrations (rather than `db push`) means
 * the tests exercise the same check constraints, partial indexes and views
 * that production would get.
 */
export default async function setup() {
  const databaseName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');

  // Connect to the `postgres` maintenance database: you cannot create a
  // database from inside the one being created.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    // Postgres has no CREATE DATABASE IF NOT EXISTS, so check the catalogue.
    const existing = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT COUNT(*)::bigint AS count FROM pg_database WHERE datname = $1',
      databaseName,
    );
    if ((existing[0]?.count ?? 0n) === 0n) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
      console.log(`[tests] created database ${databaseName}`);
    }
  } finally {
    await admin.$disconnect();
  }

  // DATABASE_URL is passed explicitly rather than inherited: the Prisma CLI
  // reads api/.env, and letting it win here would migrate the development
  // database instead of the test one.
  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
