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
import { requireActor } from '../../shared/auth.js';
import { live } from '../../shared/prisma.js';
import {
  inIdOrder,
  listPurchaseOrderIds,
  listStockOnHandIds,
  type PurchaseOrderFilter,
  type StockOnHandFilter,
} from './repository.js';
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
    /**
     * Filters, ordering and the keyset window are one SQL statement (see
     * `repository.ts`); this only hydrates the ids it returns. Status is
     * derived, so filtering on it joins the `purchase_order_status` view rather
     * than reading a column -- but it is still one indexed query, not a fetch
     * of everything followed by narrowing in memory.
     */
    purchaseOrders: async (
      _p: unknown,
      args: { filter?: PurchaseOrderFilter | null; first?: number | null; after?: string | null },
      { db }: Ctx,
    ) => {
      const { ids, pageInfo, totalCount } = await listPurchaseOrderIds(args.filter ?? {}, args);
      if (ids.length === 0) return { nodes: [], pageInfo, totalCount };

      const rows = await db.purchaseOrder.findMany({ where: { id: { in: ids } } });
      // `in` does not preserve order, so the SQL ordering is reapplied here.
      return { nodes: inIdOrder(rows, ids), pageInfo, totalCount };
    },

    purchaseOrder: (_p: unknown, args: { id: string }, { db }: Ctx) =>
      db.purchaseOrder.findFirst({ where: { id: args.id, ...live } }),

    vendors: (_p: unknown, _a: unknown, { db }: Ctx) =>
      db.vendor.findMany({ where: live, orderBy: { name: 'asc' } }),

    products: (_p: unknown, _a: unknown, { db }: Ctx) =>
      db.product.findMany({ where: live, orderBy: { sku: 'asc' } }),

    locations: (_p: unknown, _a: unknown, { db }: Ctx) =>
      db.location.findMany({ where: live, orderBy: { code: 'asc' } }),

    stockOnHand: async (
      _p: unknown,
      args: { filter?: StockOnHandFilter | null; first?: number | null; after?: string | null },
      { db }: Ctx,
    ) => {
      const { ids, pageInfo, totalCount } = await listStockOnHandIds(args.filter ?? {}, args);
      if (ids.length === 0) return { nodes: [], pageInfo, totalCount };

      const rows = await db.stockOnHand.findMany({ where: { id: { in: ids } } });
      return { nodes: inIdOrder(rows, ids), pageInfo, totalCount };
    },
  },

  Mutation: {
    createPurchaseOrder: (_p: unknown, args: { input: unknown }, { actor }: Ctx) =>
      service.createPurchaseOrder(requireActor(actor), args.input),

    // The guarded mutation. Gated on the permission, not on a role: a bespoke
    // "goods-in" role granting stock:receive works here with no code change.
    receivePurchaseOrder: (_p: unknown, args: { input: unknown }, { actor }: Ctx) =>
      service.receivePurchaseOrder(requireActor(actor), args.input),

    voidPurchaseOrder: (_p: unknown, args: { id: string }) => {
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
