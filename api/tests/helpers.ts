import {
  type Location,
  PrismaClient,
  type Product,
  type Tenant,
  type User,
  type Vendor,
} from '@prisma/client';
import { loadEffectiveAccess } from '../src/domains/auth/service.js';
import type { Actor } from '../src/shared/auth.js';
import { hashPassword } from '../src/shared/password.js';
import { SYSTEM_ROLES } from '../src/shared/permissions.js';
import { withTenant } from '../src/shared/tenancy.js';

/**
 * Test fixtures against the real Postgres from docker-compose.
 *
 * These are integration tests on purpose. The behaviour worth testing here --
 * transaction rollback, `FOR UPDATE` serialisation, check constraints, and the
 * SQL views that derive status -- lives in the database. A mocked Prisma client
 * would assert that we called the functions we wrote, not that receiving is
 * correct.
 */

/**
 * Raw, unscoped client. Fixtures build tenants and must write across them, so
 * they set `tenantId` explicitly rather than relying on the scope extension.
 */
export const prisma = new PrismaClient();

/** Runs `fn` as a request inside this fixture's tenant would. */
export function asTenant<T>(fx: Fixtures, fn: () => Promise<T> | T): Promise<T> {
  return withTenant({ tenantId: fx.tenant.id, slug: fx.tenant.slug }, fn);
}

export interface Fixtures {
  tenant: Tenant;
  admin: User;
  warehouse: User;
  viewer: User;
  vendor: Vendor;
  mainLocation: Location;
  overflowLocation: Location;
  widget: Product;
  gadget: Product;
}

let counter = 0;
/** Unique per call so parallel test files never collide on a partial index. */
const unique = (prefix: string) => `${prefix}-${process.pid}-${counter++}`;

/**
 * The password every fixture user gets. Hashed once for the whole run: scrypt
 * is deliberately slow, and paying that per user per test would dominate the
 * suite's runtime for no added coverage.
 */
export const FIXTURE_PASSWORD = 'fixture-password';
const fixturePasswordHash = await hashPassword(FIXTURE_PASSWORD);

/**
 * System roles come from the migration, so they exist before any test runs.
 * Cached because every fixture set needs them and they never change.
 */
let systemRoleIds = new Map<string, string>();

/**
 * Roles are per-tenant, so each fixture tenant gets its own copy of the system
 * roles built from the shared catalogue.
 */
async function loadSystemRoles(tenantId: string): Promise<void> {
  const permissions = await prisma.permission.findMany();
  const permissionId = (key: string) => {
    const row = permissions.find((p) => p.key === key);
    if (!row) throw new Error(`Permission "${key}" is missing; did the migration run?`);
    return row.id;
  };

  systemRoleIds = new Map();
  for (const definition of SYSTEM_ROLES) {
    const role = await prisma.role.create({
      data: {
        tenantId,
        key: definition.key,
        name: definition.name,
        isSystem: true,
        permissions: {
          create: definition.permissions.map((key) => ({ permissionId: permissionId(key) })),
        },
      },
    });
    systemRoleIds.set(definition.key, role.id);
  }
}

function roleId(key: string): string {
  const id = systemRoleIds.get(key);
  if (!id) throw new Error(`System role "${key}" is missing for this tenant.`);
  return id;
}

/**
 * Creates an isolated tenant with its own roles, users and reference data.
 *
 * Every fixture set gets its own tenant, so tests cannot see each other's rows
 * even when they run against the same database -- which is also a small, free
 * demonstration that the scoping works.
 *
 * Writes go through the raw client with explicit tenant ids, because the
 * fixture is building the tenant it is about to scope to.
 */
export async function seedFixtures(): Promise<Fixtures> {
  const tenant = await prisma.tenant.create({
    data: { slug: unique('t'), name: 'Fixture Tenant' },
  });
  await loadSystemRoles(tenant.id);

  const [admin, warehouse, viewer] = await Promise.all([
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `${unique('admin')}@test.local`,
        name: 'Admin',
        passwordHash: fixturePasswordHash,
        roles: { create: { role: { connect: { id: roleId('admin') } } } },
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `${unique('wh')}@test.local`,
        name: 'Warehouse',
        passwordHash: fixturePasswordHash,
        roles: { create: { role: { connect: { id: roleId('warehouse') } } } },
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `${unique('viewer')}@test.local`,
        name: 'Viewer',
        passwordHash: fixturePasswordHash,
        roles: { create: { role: { connect: { id: roleId('viewer') } } } },
      },
    }),
  ]);

  const [vendor, mainLocation, overflowLocation, widget, gadget] = await Promise.all([
    prisma.vendor.create({ data: { tenantId: tenant.id, code: unique('V'), name: 'Test Vendor' } }),
    prisma.location.create({ data: { tenantId: tenant.id, code: unique('MAIN'), name: 'Main' } }),
    prisma.location.create({
      data: { tenantId: tenant.id, code: unique('OVER'), name: 'Overflow' },
    }),
    prisma.product.create({ data: { tenantId: tenant.id, sku: unique('WIDGET'), name: 'Widget' } }),
    prisma.product.create({ data: { tenantId: tenant.id, sku: unique('GADGET'), name: 'Gadget' } }),
  ]);

  return {
    tenant,
    admin,
    warehouse,
    viewer,
    vendor,
    mainLocation,
    overflowLocation,
    widget,
    gadget,
  };
}

/**
 * Builds the actor a resolver would see, resolving the user's effective
 * permissions the same way a real sign-in does -- so a test cannot accidentally
 * grant itself access the login path would not.
 */
export async function actorFor(user: User): Promise<Actor> {
  const access = await withTenant({ tenantId: user.tenantId, slug: '' }, () =>
    loadEffectiveAccess(user.id),
  );
  return {
    id: user.id,
    tenantId: user.tenantId,
    permissions: new Set(access.permissions),
    roles: access.roles,
  };
}

/** Creates a PO directly, bypassing the service, so tests set up state without asserting on it. */
export async function givenPurchaseOrder(
  fx: Fixtures,
  lines: { productId: string; quantityOrdered: number; unitCostCents?: number }[],
) {
  return await prisma.purchaseOrder.create({
    data: {
      tenantId: fx.tenant.id,
      poNumber: unique('PO'),
      vendorId: fx.vendor.id,
      locationId: fx.mainLocation.id,
      createdById: fx.admin.id,
      lines: {
        create: lines.map((line) => ({
          productId: line.productId,
          quantityOrdered: line.quantityOrdered,
          unitCostCents: line.unitCostCents ?? 1000,
        })),
      },
    },
    include: { lines: { orderBy: { createdAt: 'asc' } } },
  });
}

/**
 * Puts stock on a shelf the way the application does: a ledger movement plus
 * the matching projection, in one transaction.
 *
 * Inserting into `stock_on_hand` alone would be faster to write and would break
 * the invariant the whole design rests on -- `ledgerMatchesProjection` asserts
 * it globally, so one careless fixture fails unrelated tests. That is the check
 * working, not a nuisance.
 */
export async function givenStock(
  fx: Fixtures,
  productId: string,
  locationId: string,
  quantity: number,
): Promise<void> {
  if (quantity === 0) {
    // A zero row is legitimate -- a product received and later fully consumed.
    // No movement is needed: SUM(no rows) is 0, which matches the projection.
    await prisma.stockOnHand.create({
      data: { tenantId: fx.tenant.id, productId, locationId, quantity: 0 },
    });
    return;
  }

  await prisma.$transaction([
    prisma.stockMovement.create({
      data: {
        tenantId: fx.tenant.id,
        productId,
        locationId,
        quantity,
        type: 'ADJUSTMENT',
        reason: 'Test fixture opening balance',
        createdById: fx.admin.id,
      },
    }),
    prisma.stockOnHand.upsert({
      where: { productId_locationId: { productId, locationId } },
      create: { tenantId: fx.tenant.id, productId, locationId, quantity },
      update: { quantity: { increment: quantity } },
    }),
  ]);
}

export async function statusOf(purchaseOrderId: string) {
  const [row] = await prisma.$queryRaw<
    { status: string; totalOrdered: number; totalReceived: number }[]
  >`
    SELECT "status", "total_ordered" AS "totalOrdered", "total_received" AS "totalReceived"
    FROM "purchase_order_status" WHERE "purchase_order_id" = ${purchaseOrderId}::uuid
  `;
  return row;
}

export async function onHand(productId: string, locationId: string): Promise<number> {
  const row = await prisma.stockOnHand.findUnique({
    where: { productId_locationId: { productId, locationId } },
  });
  return row?.quantity ?? 0;
}

export function movementsFor(purchaseOrderLineId: string) {
  return prisma.stockMovement.findMany({ where: { purchaseOrderLineId } });
}

/** The invariant `scripts/check-ledger.ts` enforces, asserted inline. */
export async function ledgerMatchesProjection(): Promise<boolean> {
  const drift = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count" FROM (
      SELECT COALESCE(m."ledger", 0) AS l, COALESCE(s."quantity", 0) AS p
      FROM (
        SELECT "product_id", "location_id", SUM("quantity") AS "ledger"
        FROM "stock_movements" GROUP BY "product_id", "location_id"
      ) m
      FULL OUTER JOIN "stock_on_hand" s
        ON s."product_id" = m."product_id" AND s."location_id" = m."location_id"
    ) x WHERE x.l <> x.p
  `;
  return (drift[0]?.count ?? 0n) === 0n;
}
