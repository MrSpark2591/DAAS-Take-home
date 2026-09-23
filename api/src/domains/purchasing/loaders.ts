import type {
  Location,
  Permission,
  Product,
  Role,
  StockMovement,
  Tenant,
  User,
  Vendor,
} from '@prisma/client';
import DataLoader from 'dataloader';
import { live, type Tx } from '../../shared/prisma.js';

/**
 * Per-request batching for every relation a PurchaseOrder can fan out to.
 *
 * Without these, a list of 50 POs resolving `vendor`, `location` and each
 * line's `product` is a few hundred round trips. With them it is a fixed
 * handful regardless of list size. Loaders are built per request so the cache
 * never leaks between users.
 */

/** Groups rows by a key, preserving the order DataLoader asked for. */
function byId<T extends { id: string }>(rows: T[], ids: readonly string[]): (T | null)[] {
  const map = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => map.get(id) ?? null);
}

export interface LineTotals {
  purchaseOrderLineId: string;
  quantityOrdered: number;
  quantityReceived: number;
  quantityOutstanding: number;
}

export interface OrderTotals {
  purchaseOrderId: string;
  status: 'OPEN' | 'PARTIAL' | 'RECEIVED';
  totalOrdered: number;
  totalReceived: number;
}

export function createLoaders(db: Tx) {
  return {
    vendorById: new DataLoader<string, Vendor | null>(async (ids) => {
      const rows = await db.vendor.findMany({ where: { id: { in: [...ids] } } });
      return byId(rows, ids);
    }),

    locationById: new DataLoader<string, Location | null>(async (ids) => {
      const rows = await db.location.findMany({ where: { id: { in: [...ids] } } });
      return byId(rows, ids);
    }),

    productById: new DataLoader<string, Product | null>(async (ids) => {
      const rows = await db.product.findMany({ where: { id: { in: [...ids] } } });
      return byId(rows, ids);
    }),

    userById: new DataLoader<string, User | null>(async (ids) => {
      const rows = await db.user.findMany({ where: { id: { in: [...ids] } } });
      return byId(rows, ids);
    }),

    linesByOrderId: new DataLoader<string, Awaited<ReturnType<typeof loadLines>>[number][]>(
      async (orderIds) => {
        const rows = await loadLines(db, [...orderIds]);
        const grouped = new Map<string, typeof rows>();
        for (const row of rows) {
          const bucket = grouped.get(row.purchaseOrderId);
          if (bucket) bucket.push(row);
          else grouped.set(row.purchaseOrderId, [row]);
        }
        return orderIds.map((id) => grouped.get(id) ?? []);
      },
    ),

    /** Received/outstanding per line, straight from the `purchase_order_line_totals` view. */
    totalsByLineId: new DataLoader<string, LineTotals | null>(async (lineIds) => {
      const rows = await db.$queryRaw<LineTotals[]>`
        SELECT
          "purchase_order_line_id" AS "purchaseOrderLineId",
          "quantity_ordered"       AS "quantityOrdered",
          "quantity_received"      AS "quantityReceived",
          "quantity_outstanding"   AS "quantityOutstanding"
        FROM "purchase_order_line_totals"
        WHERE "purchase_order_line_id" = ANY(${[...lineIds]}::uuid[])
      `;
      const map = new Map(rows.map((row) => [row.purchaseOrderLineId, row]));
      return lineIds.map((id) => map.get(id) ?? null);
    }),

    /** Status and order-level totals, straight from the `purchase_order_status` view. */
    totalsByOrderId: new DataLoader<string, OrderTotals | null>(async (orderIds) => {
      const rows = await db.$queryRaw<OrderTotals[]>`
        SELECT
          "purchase_order_id" AS "purchaseOrderId",
          "status"            AS "status",
          "total_ordered"     AS "totalOrdered",
          "total_received"    AS "totalReceived"
        FROM "purchase_order_status"
        WHERE "purchase_order_id" = ANY(${[...orderIds]}::uuid[])
      `;
      const map = new Map(rows.map((row) => [row.purchaseOrderId, row]));
      return orderIds.map((id) => map.get(id) ?? null);
    }),

    /** Receipt history per line, newest first. */
    receiptsByLineId: new DataLoader<string, StockMovement[]>(async (lineIds) => {
      const rows = await db.stockMovement.findMany({
        where: { purchaseOrderLineId: { in: [...lineIds] }, type: 'RECEIPT' },
        orderBy: { createdAt: 'desc' },
      });
      const grouped = new Map<string, StockMovement[]>();
      for (const row of rows) {
        if (!row.purchaseOrderLineId) continue;
        const bucket = grouped.get(row.purchaseOrderLineId);
        if (bucket) bucket.push(row);
        else grouped.set(row.purchaseOrderLineId, [row]);
      }
      return lineIds.map((id) => grouped.get(id) ?? []);
    }),

    /**
     * Roles per user. Without this, rendering a list of users with their roles
     * is one query per user, and `User.permissions` makes it two.
     */
    rolesByUserId: new DataLoader<string, Role[]>(async (userIds) => {
      const rows = await db.userRole.findMany({
        where: { userId: { in: [...userIds] }, role: { ...live } },
        select: { userId: true, role: true },
      });

      const grouped = new Map<string, Role[]>();
      for (const row of rows) {
        const bucket = grouped.get(row.userId);
        if (bucket) bucket.push(row.role);
        else grouped.set(row.userId, [row.role]);
      }
      return userIds.map((id) => grouped.get(id) ?? []);
    }),

    /** Permissions granted by a role. */
    permissionsByRoleId: new DataLoader<string, Permission[]>(async (roleIds) => {
      const rows = await db.rolePermission.findMany({
        where: { roleId: { in: [...roleIds] } },
        select: { roleId: true, permission: true },
      });

      const grouped = new Map<string, Permission[]>();
      for (const row of rows) {
        const bucket = grouped.get(row.roleId);
        if (bucket) bucket.push(row.permission);
        else grouped.set(row.roleId, [row.permission]);
      }
      return roleIds.map((id) =>
        (grouped.get(id) ?? []).sort((a, b) => a.key.localeCompare(b.key)),
      );
    }),

    /**
     * Tenants and their features are global tables, so the scope extension
     * leaves them alone and these resolve for any request -- including a login,
     * which has no tenant context yet.
     */
    tenantById: new DataLoader<string, Tenant | null>(async (ids) => {
      const rows = await db.tenant.findMany({ where: { id: { in: [...ids] } } });
      return byId(rows, ids);
    }),

    featuresByTenantId: new DataLoader<string, string[]>(async (tenantIds) => {
      const rows = await db.tenantFeature.findMany({
        where: { tenantId: { in: [...tenantIds] }, enabled: true },
        select: { tenantId: true, featureKey: true },
      });

      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        const bucket = grouped.get(row.tenantId);
        if (bucket) bucket.push(row.featureKey);
        else grouped.set(row.tenantId, [row.featureKey]);
      }
      return tenantIds.map((id) => (grouped.get(id) ?? []).sort());
    }),

    stockOnHandByProductId: new DataLoader(async (productIds: readonly string[]) => {
      const rows = await db.stockOnHand.findMany({
        where: { productId: { in: [...productIds] } },
        orderBy: { quantity: 'desc' },
      });
      const grouped = new Map<string, typeof rows>();
      for (const row of rows) {
        const bucket = grouped.get(row.productId);
        if (bucket) bucket.push(row);
        else grouped.set(row.productId, [row]);
      }
      return productIds.map((id) => grouped.get(id) ?? []);
    }),
  };
}

function loadLines(db: Tx, purchaseOrderIds: string[]) {
  return db.purchaseOrderLine.findMany({
    where: { purchaseOrderId: { in: purchaseOrderIds }, ...live },
    orderBy: { createdAt: 'asc' },
  });
}

export type Loaders = ReturnType<typeof createLoaders>;
