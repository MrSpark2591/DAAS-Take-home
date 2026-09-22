import type { Location, Product, StockMovement, User, Vendor } from '@prisma/client';
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
