import { Prisma, PrismaClient } from '@prisma/client';
import { assertTenancyIsComplete, tenantScopeExtension } from './tenancy.js';

const base = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
});

// Refuse to start if a model is neither tenant-scoped nor deliberately global.
// Prisma exposes the model list at runtime, so this cannot drift from the schema.
assertTenancyIsComplete(Prisma.dmmf.datamodel.models.map((model) => model.name));

/**
 * The only client the application uses.
 *
 * It is extended at construction, so there is no unextended client to reach for
 * by accident -- every model query is scoped to the tenant on the current
 * request. See `tenancy.ts` for why that is enforced here rather than written
 * at each call site.
 */
export const prisma = base.$extends(tenantScopeExtension);

/**
 * The transaction-scoped client Prisma hands to `$transaction(fn)`. Service
 * functions accept this type so they can be composed inside a caller's
 * transaction instead of opening one of their own.
 */
export type Tx = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Excludes soft-deleted rows. Spread into any `where` that reads live data. */
export const live = { deletedAt: null } as const;

/**
 * The unscoped client, for the two jobs that legitimately span tenants: the
 * seed, and resolving which tenant a sign-in belongs to before a context exists.
 *
 * Named so it is obvious in review. Nothing else should import it.
 */
export const prismaUnscoped = base;
