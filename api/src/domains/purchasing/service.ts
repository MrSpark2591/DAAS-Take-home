import { Prisma, type PurchaseOrder, type StockMovement } from '@prisma/client';
import { z } from 'zod';
import type { Actor } from '../../shared/auth.js';
import { badInput, conflict, notFound, overReceipt } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/id.js';
import { live, prisma, type Tx } from '../../shared/prisma.js';

/**
 * All purchasing writes live here. Resolvers do auth and shape translation;
 * this module owns the domain rules and the transaction boundaries, so the
 * same logic is reachable from a future worker, CLI or import job without
 * going through GraphQL.
 */

// ---------------------------------------------------------------------------
// Input validation
//
// GraphQL already enforces types and nullability. Zod covers what it cannot:
// ranges, integer-ness, non-empty lists and duplicate keys. Doing it here
// rather than in the resolver means non-GraphQL callers get the same checks.
// ---------------------------------------------------------------------------

const quantity = z
  .number()
  .int('Quantities must be whole units.')
  .positive('Quantity must be greater than zero.');

const createPurchaseOrderSchema = z.object({
  poNumber: z.string().trim().min(1, 'PO number is required.').max(32),
  vendorId: z.string().uuid(),
  locationId: z.string().uuid(),
  notes: z.string().trim().max(2000).optional().nullable(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantityOrdered: quantity,
        unitCostCents: z
          .number()
          .int('Unit cost is in whole cents.')
          .min(0, 'Unit cost cannot be negative.'),
      }),
    )
    .min(1, 'A purchase order needs at least one line.'),
});

const receiveSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  locationId: z.string().uuid().optional().nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
  lines: z
    .array(z.object({ purchaseOrderLineId: z.string().uuid(), quantity }))
    .min(1, 'Select at least one line to receive.'),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type ReceivePurchaseOrderInput = z.infer<typeof receiveSchema>;

/** Turns a Zod failure into a BAD_USER_INPUT the UI can map back onto a field. */
function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  throw badInput(issue?.message ?? 'Invalid input.', {
    field: issue?.path.join('.'),
    issues: result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(actor: Actor, rawInput: unknown): Promise<PurchaseOrder> {
  const input = parseOrThrow(createPurchaseOrderSchema, rawInput);

  // The partial unique index enforces this too; checking here lets us name the
  // duplicate product instead of surfacing a raw constraint violation.
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.productId)) {
      throw badInput('The same product appears on two lines. Combine them into one line instead.', {
        productId: line.productId,
      });
    }
    seen.add(line.productId);
  }

  // Header and lines are one atomic write: a PO with no lines is not a thing
  // the rest of the system should ever observe.
  return await prisma.$transaction(async (tx) => {
    await assertExists(tx, 'Vendor', input.vendorId);
    await assertExists(tx, 'Location', input.locationId);

    const products = await tx.product.findMany({
      where: { id: { in: input.lines.map((l) => l.productId) }, ...live },
      select: { id: true },
    });
    if (products.length !== seen.size) {
      const found = new Set(products.map((p) => p.id));
      const missing = [...seen].filter((id) => !found.has(id));
      throw notFound('Product', missing[0] ?? 'unknown');
    }

    try {
      return await tx.purchaseOrder.create({
        data: {
          poNumber: input.poNumber,
          vendorId: input.vendorId,
          locationId: input.locationId,
          notes: input.notes ?? null,
          createdById: actor.id,
          lines: {
            create: input.lines.map((line) => ({
              productId: line.productId,
              quantityOrdered: line.quantityOrdered,
              unitCostCents: line.unitCostCents,
            })),
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict(`PO number "${input.poNumber}" is already in use.`, {
          field: 'poNumber',
        });
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Receive -- the guarded, transactional path this slice is really about.
// ---------------------------------------------------------------------------

export async function receivePurchaseOrder(
  actor: Actor,
  rawInput: unknown,
): Promise<{ purchaseOrder: PurchaseOrder; movements: StockMovement[] }> {
  const input = parseOrThrow(receiveSchema, rawInput);

  // Collapse duplicate line ids up front. Receiving "3 then 2" of the same
  // line in one call should behave exactly like receiving 5, including for the
  // over-receipt check.
  const requested = new Map<string, number>();
  for (const line of input.lines) {
    requested.set(
      line.purchaseOrderLineId,
      (requested.get(line.purchaseOrderLineId) ?? 0) + line.quantity,
    );
  }

  return await prisma.$transaction(
    async (tx) => {
      // Serialise receipts against this PO. Two warehouse staff receiving the
      // last item at the same moment would otherwise both read "1 outstanding"
      // and both pass the check below. The lock makes the read-check-write
      // sequence atomic per order; receipts against *different* POs stay
      // concurrent.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "purchase_orders"
        WHERE "id" = ${input.purchaseOrderId}::uuid AND "deleted_at" IS NULL
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw notFound('Purchase order', input.purchaseOrderId);
      }

      const order = await tx.purchaseOrder.findFirstOrThrow({
        where: { id: input.purchaseOrderId, ...live },
      });

      // A receipt can land somewhere other than the PO's default location
      // (overflow bay, a different yard), so the location is resolved per
      // receipt rather than read off the header.
      const locationId = input.locationId ?? order.locationId;
      if (input.locationId) await assertExists(tx, 'Location', input.locationId);

      const lines = await tx.purchaseOrderLine.findMany({
        where: { id: { in: [...requested.keys()] }, purchaseOrderId: order.id, ...live },
      });
      if (lines.length !== requested.size) {
        const found = new Set(lines.map((l) => l.id));
        const missing = [...requested.keys()].filter((id) => !found.has(id));
        throw badInput(`Line ${missing[0]} is not on purchase order ${order.poNumber}.`, {
          purchaseOrderLineId: missing[0],
        });
      }

      // Received-so-far comes from the same view the API reads, so the guard
      // can never disagree with the number shown in the UI.
      const totals = await tx.$queryRaw<
        { purchaseOrderLineId: string; quantityReceived: number }[]
      >`
        SELECT "purchase_order_line_id" AS "purchaseOrderLineId",
               "quantity_received"      AS "quantityReceived"
        FROM "purchase_order_line_totals"
        WHERE "purchase_order_line_id" = ANY(${[...requested.keys()]}::uuid[])
      `;
      const receivedSoFar = new Map(totals.map((t) => [t.purchaseOrderLineId, t.quantityReceived]));

      const products = await tx.product.findMany({
        where: { id: { in: lines.map((l) => l.productId) } },
        select: { id: true, sku: true },
      });
      const skuById = new Map(products.map((p) => [p.id, p.sku]));

      const movementRows = lines.map((line) => {
        const attempted = requested.get(line.id) ?? 0;
        const already = receivedSoFar.get(line.id) ?? 0;

        if (already + attempted > line.quantityOrdered) {
          throw overReceipt({
            purchaseOrderLineId: line.id,
            sku: skuById.get(line.productId) ?? line.productId,
            ordered: line.quantityOrdered,
            alreadyReceived: already,
            attempted,
          });
        }

        return {
          productId: line.productId,
          locationId,
          quantity: attempted,
          type: 'RECEIPT' as const,
          purchaseOrderLineId: line.id,
          reason: input.reason ?? null,
          createdById: actor.id,
        };
      });

      // Two writes, one transaction: append to the ledger, then move the
      // projection to match. Nothing outside this transaction can observe one
      // without the other.
      const movements = await tx.stockMovement.createManyAndReturn({ data: movementRows });

      // A product can appear on only one line per PO, so these are already
      // distinct -- but summing defensively keeps this correct if that
      // constraint is ever relaxed.
      const deltas = new Map<string, number>();
      for (const row of movementRows) {
        deltas.set(row.productId, (deltas.get(row.productId) ?? 0) + row.quantity);
      }

      for (const [productId, delta] of deltas) {
        // Raw upsert rather than `prisma.upsert`: INSERT ... ON CONFLICT is a
        // single atomic statement, so two transactions creating the first
        // on-hand row for the same (product, location) cannot collide.
        await tx.$executeRaw`
          INSERT INTO "stock_on_hand"
            ("id", "product_id", "location_id", "quantity", "created_at", "updated_at")
          VALUES
            (${uuidv7()}::uuid, ${productId}::uuid, ${locationId}::uuid, ${delta}, NOW(), NOW())
          ON CONFLICT ("product_id", "location_id") DO UPDATE
            SET "quantity"   = "stock_on_hand"."quantity" + EXCLUDED."quantity",
                "updated_at" = NOW()
        `;
      }

      return { purchaseOrder: order, movements };
    },
    // Read Committed plus the row lock above is enough here, and avoids the
    // serialisation failures a stricter level would make callers retry.
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
  );
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export async function voidPurchaseOrder(id: string): Promise<PurchaseOrder> {
  return await prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.findFirst({ where: { id, ...live } });
    if (!order) throw notFound('Purchase order', id);

    // Voiding a PO that already moved stock would orphan ledger rows behind a
    // deleted parent. Reverse the receipts first (a later sprint's job).
    const [received] = await tx.$queryRaw<{ totalReceived: number }[]>`
      SELECT "total_received" AS "totalReceived"
      FROM "purchase_order_status"
      WHERE "purchase_order_id" = ${id}::uuid
    `;
    if ((received?.totalReceived ?? 0) > 0) {
      throw conflict(
        `Purchase order ${order.poNumber} has received stock and cannot be voided. ` +
          'Reverse the receipts first.',
      );
    }

    // Soft delete cascades by hand: the lines are part of the aggregate, so
    // they leave with it and stop showing up in the totals view.
    const now = new Date();
    await tx.purchaseOrderLine.updateMany({
      where: { purchaseOrderId: id, ...live },
      data: { deletedAt: now },
    });
    return tx.purchaseOrder.update({ where: { id }, data: { deletedAt: now } });
  });
}

// ---------------------------------------------------------------------------

async function assertExists(tx: Tx, entity: 'Vendor' | 'Location', id: string): Promise<void> {
  const row =
    entity === 'Vendor'
      ? await tx.vendor.findFirst({ where: { id, ...live }, select: { id: true } })
      : await tx.location.findFirst({ where: { id, ...live }, select: { id: true } });

  if (!row) throw notFound(entity, id);
}
