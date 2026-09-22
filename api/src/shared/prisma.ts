import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
});

/**
 * The transaction-scoped client Prisma hands to `$transaction(fn)`. Service
 * functions accept this type so they can be composed inside a caller's
 * transaction instead of opening one of their own.
 */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Excludes soft-deleted rows. Spread into any `where` that reads live data. */
export const live = { deletedAt: null } as const;
