import { type Location, PrismaClient, type Product, type User, type Vendor } from '@prisma/client';
import type { Actor } from '../src/shared/auth.js';
import { hashPassword } from '../src/shared/password.js';

/**
 * Test fixtures against the real Postgres from docker-compose.
 *
 * These are integration tests on purpose. The behaviour worth testing here --
 * transaction rollback, `FOR UPDATE` serialisation, check constraints, and the
 * SQL views that derive status -- lives in the database. A mocked Prisma client
 * would assert that we called the functions we wrote, not that receiving is
 * correct.
 */

export const prisma = new PrismaClient();

export interface Fixtures {
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

export async function seedFixtures(): Promise<Fixtures> {
  const [admin, warehouse, viewer] = await Promise.all([
    prisma.user.create({
      data: {
        email: `${unique('admin')}@test.local`,
        name: 'Admin',
        role: 'ADMIN',
        passwordHash: fixturePasswordHash,
      },
    }),
    prisma.user.create({
      data: {
        email: `${unique('wh')}@test.local`,
        name: 'Warehouse',
        role: 'WAREHOUSE',
        passwordHash: fixturePasswordHash,
      },
    }),
    prisma.user.create({
      data: {
        email: `${unique('viewer')}@test.local`,
        name: 'Viewer',
        role: 'VIEWER',
        passwordHash: fixturePasswordHash,
      },
    }),
  ]);

  const [vendor, mainLocation, overflowLocation, widget, gadget] = await Promise.all([
    prisma.vendor.create({ data: { code: unique('V'), name: 'Test Vendor' } }),
    prisma.location.create({ data: { code: unique('MAIN'), name: 'Main' } }),
    prisma.location.create({ data: { code: unique('OVER'), name: 'Overflow' } }),
    prisma.product.create({ data: { sku: unique('WIDGET'), name: 'Widget' } }),
    prisma.product.create({ data: { sku: unique('GADGET'), name: 'Gadget' } }),
  ]);

  return { admin, warehouse, viewer, vendor, mainLocation, overflowLocation, widget, gadget };
}

export const actorFor = (user: User): Actor => ({ id: user.id, role: user.role });

/** Creates a PO directly, bypassing the service, so tests set up state without asserting on it. */
export async function givenPurchaseOrder(
  fx: Fixtures,
  lines: { productId: string; quantityOrdered: number; unitCostCents?: number }[],
) {
  return await prisma.purchaseOrder.create({
    data: {
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
