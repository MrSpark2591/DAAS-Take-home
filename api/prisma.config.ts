import { loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * This replaces the `prisma` key in package.json, which is deprecated and goes
 * away in Prisma 7. Unlike the package.json block, this file is not loaded by
 * the Prisma Client at runtime -- it only configures the CLI.
 *
 * Having this file switches off Prisma's automatic .env loading, so DATABASE_URL
 * has to be loaded here. `loadEnvFile` is Node's own, so this needs no dotenv
 * dependency. Anything already in the environment wins, which is what lets the
 * test global-setup point the CLI at daas_test.
 */
if (!process.env.DATABASE_URL) {
  try {
    loadEnvFile('.env');
  } catch {
    // No .env (CI, or DATABASE_URL exported directly) -- not an error.
  }
}
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
