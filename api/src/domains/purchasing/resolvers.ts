import type {
  Location,
  Product,
  PurchaseOrder,
  PurchaseOrderLine,
  StockMovement,
  StockOnHand,
  User,
  Vendor,
} from '@prisma/client';
import { DateTimeResolver } from 'graphql-scalars';
import type { GraphQLContext } from '../../context.js';
import { CAN_MANAGE_PURCHASE_ORDERS, CAN_RECEIVE_STOCK, requireRole } from '../../shared/auth.js';
import { live } from '../../shared/prisma.js';
import * as service from './service.js';

/**
 * Resolvers stay thin on purpose: check the role, hand off to the service,
 * resolve relations through loaders. Any logic worth testing lives in
 * `service.ts`, which has no GraphQL types in its signature.
 */

type Ctx = GraphQLContext;

export const resolvers = {
  DateTime: DateTimeResolver,

  Query: {
    /**
     * Status is derived, so filtering by it happens in the
     * `purchase_order_status` view rather than in application memory -- the
     * list stays a single indexed query as the table grows.
     */
    purchaseOrders: async (
      _p: unknown,
      args: {
        filter?: {
          status?: 'OPEN' | 'PARTIAL' | 'RECEIVED' | null;
          vendorId?: string | null;
        } | null;
      },
      { db }: Ctx,
    ) => {
      const { status, vendorId } = args.filter ?? {};

      if (status) {
        const rows = await db.$queryRaw<{ purchaseOrderId: string }[]>`
          SELECT "purchase_order_id" AS "purchaseOrderId"
          FROM "purchase_order_status"
          WHERE "status" = ${status}
        `;
        const ids = rows.map((r) => r.purchaseOrderId);
        if (ids.length === 0) return [];

        return db.purchaseOrder.findMany({
          where: { id: { in: ids }, ...(vendorId ? { vendorId } : {}), ...live },
          orderBy: { createdAt: 'desc' },
        });
      }

      return db.purchaseOrder.findMany({
        where: { ...(vendorId ? { vendorId } : {}), ...live },
        orderBy: { createdAt: 'desc' },
      });
    },

    purchaseOrder: (_p: unknown, args: { id: string }, { db }: Ctx) =>
      db.purchaseOrder.findFirst({ where: { id: args.id, ...live } }),

    vendors: (_p: unknown, _a: unknown, { db }: Ctx) =>
      db.vendor.findMany({ where: live, orderBy: { name: 'asc' } }),

    products: (_p: unknown, _a: unknown, { db }: Ctx) =>
      db.product.findMany({ where: live, orderBy: { sku: 'asc' } }),

    locations: (_p: unknown, _a: unknown, { db }: Ctx) =>
      db.location.findMany({ where: live, orderBy: { code: 'asc' } }),

    stockOnHand: (
      _p: unknown,
      args: { locationId?: string | null; productId?: string | null },
      { db }: Ctx,
    ) =>
      db.stockOnHand.findMany({
        where: {
          ...(args.locationId ? { locationId: args.locationId } : {}),
          ...(args.productId ? { productId: args.productId } : {}),
        },
        orderBy: [{ quantity: 'desc' }],
      }),
  },

  Mutation: {
    createPurchaseOrder: (_p: unknown, args: { input: unknown }, { actor }: Ctx) =>
      service.createPurchaseOrder(requireRole(actor, CAN_MANAGE_PURCHASE_ORDERS), args.input),

    // The guarded mutation: a VIEWER token gets FORBIDDEN before any row is
    // touched, and the UI mirrors the same rule by disabling the button.
    receivePurchaseOrder: (_p: unknown, args: { input: unknown }, { actor }: Ctx) =>
      service.receivePurchaseOrder(requireRole(actor, CAN_RECEIVE_STOCK), args.input),

    voidPurchaseOrder: (_p: unknown, args: { id: string }, { actor }: Ctx) => {
      requireRole(actor, CAN_MANAGE_PURCHASE_ORDERS);
      return service.voidPurchaseOrder(args.id);
    },
  },

  PurchaseOrder: {
    vendor: (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) =>
      loaders.vendorById.load(po.vendorId),

    location: (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) =>
      loaders.locationById.load(po.locationId),

    createdBy: (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) =>
      loaders.userById.load(po.createdById),

    lines: (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) => loaders.linesByOrderId.load(po.id),

    status: async (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) =>
      (await loaders.totalsByOrderId.load(po.id))?.status ?? 'OPEN',

    totalOrdered: async (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) =>
      (await loaders.totalsByOrderId.load(po.id))?.totalOrdered ?? 0,

    totalReceived: async (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) =>
      (await loaders.totalsByOrderId.load(po.id))?.totalReceived ?? 0,

    totalCostCents: async (po: PurchaseOrder, _a: unknown, { loaders }: Ctx) => {
      const lines = await loaders.linesByOrderId.load(po.id);
      return lines.reduce((sum, line) => sum + line.unitCostCents * line.quantityOrdered, 0);
    },
  },

  PurchaseOrderLine: {
    product: (line: PurchaseOrderLine, _a: unknown, { loaders }: Ctx) =>
      loaders.productById.load(line.productId),

    quantityReceived: async (line: PurchaseOrderLine, _a: unknown, { loaders }: Ctx) =>
      (await loaders.totalsByLineId.load(line.id))?.quantityReceived ?? 0,

    quantityOutstanding: async (line: PurchaseOrderLine, _a: unknown, { loaders }: Ctx) =>
      (await loaders.totalsByLineId.load(line.id))?.quantityOutstanding ?? line.quantityOrdered,

    lineTotalCents: (line: PurchaseOrderLine) => line.unitCostCents * line.quantityOrdered,

    receipts: (line: PurchaseOrderLine, _a: unknown, { loaders }: Ctx) =>
      loaders.receiptsByLineId.load(line.id),
  },

  Product: {
    stockOnHand: (product: Product, _a: unknown, { loaders }: Ctx) =>
      loaders.stockOnHandByProductId.load(product.id),
  },

  StockMovement: {
    product: (m: StockMovement, _a: unknown, { loaders }: Ctx) =>
      loaders.productById.load(m.productId),
    location: (m: StockMovement, _a: unknown, { loaders }: Ctx) =>
      loaders.locationById.load(m.locationId),
    createdBy: (m: StockMovement, _a: unknown, { loaders }: Ctx) =>
      loaders.userById.load(m.createdById),
  },

  StockOnHand: {
    product: (s: StockOnHand, _a: unknown, { loaders }: Ctx) =>
      loaders.productById.load(s.productId),
    location: (s: StockOnHand, _a: unknown, { loaders }: Ctx) =>
      loaders.locationById.load(s.locationId),
  },
};

// Re-exported so the schema assembly file stays declarative about what a
// domain contributes.
export type { Location, Product, User, Vendor };
