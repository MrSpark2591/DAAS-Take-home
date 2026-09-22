import { loadEnvFile } from 'node:process';

/**
 * Loads `.env` explicitly.
 *
 * It used to arrive as a side effect of importing Prisma, which meant anything
 * reading `process.env` at module-load time could win or lose a race depending
 * on import order -- and silently fall back to its default when it lost. Doing
 * it here makes the dependency visible, and `readInt` below removes the timing
 * question entirely by reading at call time.
 *
 * Real environment variables always win, so container and CI config override
 * the file rather than fighting it.
 */
try {
  loadEnvFile('.env');
} catch {
  // No .env is normal in CI and in production, where the environment is set
  // by the platform.
}

/** Reads an integer setting at call time, falling back when unset or invalid. */
export function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
