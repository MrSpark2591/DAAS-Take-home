import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { badInput } from './errors.js';

/**
 * Tenant scoping, applied to every query rather than written at each call site.
 *
 * The isolation model is a shared schema with a `tenant_id` column. The obvious
 * way to enforce that is `where: { tenantId }` in each query -- and that is
 * exactly the pattern that put unguarded reads into this codebase once already.
 * A cross-tenant leak is worse than an unguarded read: it shows one customer
 * another customer's costs and suppliers.
 *
 * So the filter is injected by a Prisma client extension, and the tenant for the
 * current request travels in `AsyncLocalStorage` rather than being threaded
 * through every function signature. A query written without a tenant filter
 * still gets one; a query issued with no tenant context at all throws rather
 * than silently reading everything.
 *
 * The honest limit: this is application-level enforcement. Raw SQL through
 * `$queryRaw` bypasses the extension, so those queries carry their own tenant
 * predicate (see `repository.ts`), and there is a test that fails if one does
 * not. Postgres row-level security would move the boundary into the database
 * and is the natural hardening step; it needs a session variable set per
 * transaction, which with Prisma's pooling means routing every call through a
 * transaction client. That is a larger change than this slice warrants, and the
 * README says so rather than implying the database is enforcing this.
 */

export interface TenantContext {
  tenantId: string;
  /** Slug, for logs. Never used as a key. */
  slug: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` with every Prisma query scoped to this tenant.
 *
 * The `await` inside is load-bearing. Prisma promises are lazy -- the query is
 * not dispatched until something awaits them -- so returning one from `fn`
 * without awaiting it here would hand the caller an unstarted query and exit
 * the store before it ran. The query would then execute with no tenant context
 * and throw. Awaiting inside keeps the dispatch within the store no matter how
 * the callback is written.
 */
export function withTenant<T>(context: TenantContext, fn: () => Promise<T> | T): Promise<T> {
  return storage.run(context, async () => await fn());
}

/**
 * Binds the tenant to the current async chain, for callers that cannot wrap a
 * callback around the work -- notably the GraphQL context function, which runs
 * per request but returns before the resolvers do.
 *
 * `enterWith` is the sharp tool in this file: it leaks the store to everything
 * downstream on the same chain. That is exactly the intent per request, and
 * each request has its own chain, but it is only safe because nothing shares a
 * chain across requests. `tenancy.test.ts` runs interleaved requests from two
 * tenants concurrently and fails if one ever sees the other's rows.
 */
export function enterTenant(context: TenantContext): void {
  storage.enterWith(context);
}

export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenant(): TenantContext {
  const tenant = storage.getStore();
  if (!tenant) {
    throw new Error(
      'No tenant context. Every request must run inside withTenant(); see shared/tenancy.ts.',
    );
  }
  return tenant;
}

/**
 * Models carrying a `tenant_id`.
 *
 * Kept as an explicit list rather than inferred, so adding a tenant-scoped model
 * is a deliberate act. `assertTenancyIsComplete` cross-checks it against the
 * Prisma schema at boot and refuses to start if the two disagree -- a new model
 * with a `tenantId` column that nobody added here would otherwise be unscoped.
 */
export const TENANT_SCOPED_MODELS = new Set([
  'User',
  'Role',
  'Vendor',
  'Product',
  'Location',
  'PurchaseOrder',
  'StockMovement',
  'StockOnHand',
]);

/**
 * Models that are deliberately global.
 *
 * `Permission` is the catalogue, identical for everyone. `Tenant` and
 * `TenantFeature` are the tenancy tables themselves. The join tables reach their
 * tenant through a scoped parent, so scoping them again would be redundant --
 * but they are listed so the boot check can tell "global on purpose" from
 * "forgotten".
 */
export const GLOBAL_MODELS = new Set([
  'Tenant',
  'TenantFeature',
  'Permission',
  'RolePermission',
  'UserRole',
  'RefreshToken',
  'PurchaseOrderLine',
]);

/** Operations whose `args.where` should gain the tenant filter. */
const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
  'update',
  'delete',
  'upsert',
]);

/** Operations whose `args.data` should gain the tenant id. */
const WRITE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

/**
 * The extension. Applied once where the client is built, so there is no way to
 * obtain an unscoped client by accident.
 */
export const tenantScopeExtension = Prisma.defineExtension({
  name: 'tenant-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_SCOPED_MODELS.has(model)) return await query(args);

        const { tenantId } = requireTenant();
        const next = { ...(args as Record<string, unknown>) };

        if (READ_OPERATIONS.has(operation)) {
          next.where = { ...((next.where as object | undefined) ?? {}), tenantId };
        }

        if (WRITE_OPERATIONS.has(operation)) {
          const data = next.data as Record<string, unknown> | Record<string, unknown>[] | undefined;
          if (Array.isArray(data)) {
            next.data = data.map((row) => ({ ...row, tenantId }));
          } else if (data) {
            next.data = { ...data, tenantId };
          }
          // `upsert` carries both; `create` inside it needs the id too.
          const create = next.create as Record<string, unknown> | undefined;
          if (create) next.create = { ...create, tenantId };
        }

        return await query(next);
      },
    },
  },
});

/**
 * Fails at boot if a model in the Prisma schema is neither scoped nor
 * deliberately global. Same idea as the authorisation policy check: the list
 * only stays correct if forgetting it is loud.
 */
export function assertTenancyIsComplete(modelNames: readonly string[]): void {
  const unclassified = modelNames.filter(
    (name) => !TENANT_SCOPED_MODELS.has(name) && !GLOBAL_MODELS.has(name),
  );

  if (unclassified.length > 0) {
    throw new Error(
      'Tenancy is undeclared for these models. Add each to TENANT_SCOPED_MODELS or ' +
        `GLOBAL_MODELS in src/shared/tenancy.ts:\n${unclassified.map((n) => `  - ${n}`).join('\n')}`,
    );
  }
}

/** Guards raw SQL, which the extension cannot reach. */
export function tenantFilter(): { tenantId: string } {
  return { tenantId: requireTenant().tenantId };
}

/** Rejects a client-supplied tenant id. Callers never choose their own tenant. */
export function rejectExplicitTenant(input: unknown): void {
  if (input && typeof input === 'object' && 'tenantId' in input) {
    throw badInput('tenantId is derived from your session and cannot be supplied.');
  }
}
