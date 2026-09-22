import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { receivePurchaseOrder, voidPurchaseOrder } from '../src/domains/purchasing/service.js';
import {
  actorFor,
  type Fixtures,
  givenPurchaseOrder,
  ledgerMatchesProjection,
  movementsFor,
  onHand,
  prisma,
  seedFixtures,
  statusOf,
} from './helpers.js';

/**
 * Tests are chosen around what would actually hurt in a warehouse: receiving
 * more than was ordered, two people receiving the same delivery at once, a
 * multi-line receipt half-applying, stock landing in the wrong location, and
 * status disagreeing with the ledger. Each one describes a scenario a
 * warehouse manager would recognise, not a function signature.
 */

let fx: Fixtures;

beforeEach(async () => {
  fx = await seedFixtures();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('receiving against a purchase order', () => {
  it('moves stock and advances status when a delivery arrives short', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 20 }]);
    const line = po.lines[0]!;

    // The truck showed up with 8 of the 20 ordered.
    await receivePurchaseOrder(actorFor(fx.warehouse), {
      purchaseOrderId: po.id,
      lines: [{ purchaseOrderLineId: line.id, quantity: 8 }],
    });

    expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(8);

    const partial = await statusOf(po.id);
    expect(partial?.status).toBe('PARTIAL');
    expect(partial?.totalReceived).toBe(8);

    // The rest arrives later.
    await receivePurchaseOrder(actorFor(fx.warehouse), {
      purchaseOrderId: po.id,
      lines: [{ purchaseOrderLineId: line.id, quantity: 12 }],
    });

    expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(20);
    expect((await statusOf(po.id))?.status).toBe('RECEIVED');

    // Two receipts, two ledger rows: the history of the delivery survives.
    expect(await movementsFor(line.id)).toHaveLength(2);
    expect(await ledgerMatchesProjection()).toBe(true);
  });

  it('refuses to receive more than was ordered and leaves no trace', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 10 }]);
    const line = po.lines[0]!;

    await receivePurchaseOrder(actorFor(fx.warehouse), {
      purchaseOrderId: po.id,
      lines: [{ purchaseOrderLineId: line.id, quantity: 7 }],
    });

    // Only 3 outstanding, but the docket says 5.
    await expect(
      receivePurchaseOrder(actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: line.id, quantity: 5 }],
      }),
    ).rejects.toMatchObject({ extensions: { code: 'OVER_RECEIPT', ordered: 10, attempted: 5 } });

    // The rejected receipt must not have moved anything.
    expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(7);
    expect(await movementsFor(line.id)).toHaveLength(1);
  });

  it('applies a multi-line receipt all-or-nothing', async () => {
    const po = await givenPurchaseOrder(fx, [
      { productId: fx.widget.id, quantityOrdered: 10 },
      { productId: fx.gadget.id, quantityOrdered: 4 },
    ]);
    const [widgetLine, gadgetLine] = po.lines;

    // The first line is fine; the second over-receives. The whole receipt must
    // roll back -- a half-applied delivery is the worst possible outcome,
    // because on-hand silently disagrees with the paperwork.
    await expect(
      receivePurchaseOrder(actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [
          { purchaseOrderLineId: widgetLine!.id, quantity: 10 },
          { purchaseOrderLineId: gadgetLine!.id, quantity: 99 },
        ],
      }),
    ).rejects.toMatchObject({ extensions: { code: 'OVER_RECEIPT' } });

    expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(0);
    expect(await onHand(fx.gadget.id, fx.mainLocation.id)).toBe(0);
    expect(await movementsFor(widgetLine!.id)).toHaveLength(0);
    expect((await statusOf(po.id))?.status).toBe('OPEN');
  });

  it('sums repeated lines in one call before checking the limit', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 10 }]);
    const line = po.lines[0]!;

    // Scanning the same SKU twice on one docket: 6 + 6 is 12, over the 10
    // ordered, even though neither entry exceeds it on its own.
    await expect(
      receivePurchaseOrder(actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [
          { purchaseOrderLineId: line.id, quantity: 6 },
          { purchaseOrderLineId: line.id, quantity: 6 },
        ],
      }),
    ).rejects.toMatchObject({ extensions: { code: 'OVER_RECEIPT', attempted: 12 } });

    expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(0);
  });

  it('puts stock in the location the receipt names, not the order default', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

    // Delivery diverted to the overflow bay because main was full.
    await receivePurchaseOrder(actorFor(fx.warehouse), {
      purchaseOrderId: po.id,
      locationId: fx.overflowLocation.id,
      lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 5 }],
    });

    expect(await onHand(fx.widget.id, fx.overflowLocation.id)).toBe(5);
    expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(0);
    // The PO is still fully received -- receiving elsewhere does not stall it.
    expect((await statusOf(po.id))?.status).toBe('RECEIVED');
  });

  it('lets only one of two simultaneous receipts take the last item', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 1 }]);
    const line = po.lines[0]!;

    // Two staff scan the same last unit at the same moment. Without the
    // `FOR UPDATE` lock on the PO both read "1 outstanding" and both write,
    // leaving on-hand at 2 for a single ordered unit.
    const results = await Promise.allSettled([
      receivePurchaseOrder(actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: line.id, quantity: 1 }],
      }),
      receivePurchaseOrder(actorFor(fx.admin), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: line.id, quantity: 1 }],
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(1);
    expect(await ledgerMatchesProjection()).toBe(true);
  });

  it('rejects a line that belongs to a different purchase order', async () => {
    const [mine, theirs] = await Promise.all([
      givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]),
      givenPurchaseOrder(fx, [{ productId: fx.gadget.id, quantityOrdered: 5 }]),
    ]);

    await expect(
      receivePurchaseOrder(actorFor(fx.warehouse), {
        purchaseOrderId: mine.id,
        lines: [{ purchaseOrderLineId: theirs.lines[0]!.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    expect(await onHand(fx.gadget.id, fx.mainLocation.id)).toBe(0);
  });

  it('rejects zero and negative quantities before touching the ledger', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);
    const line = po.lines[0]!;

    for (const quantity of [0, -3]) {
      await expect(
        receivePurchaseOrder(actorFor(fx.warehouse), {
          purchaseOrderId: po.id,
          lines: [{ purchaseOrderLineId: line.id, quantity }],
        }),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }

    expect(await movementsFor(line.id)).toHaveLength(0);
  });
});

describe('who is allowed to receive', () => {
  it('lets warehouse staff receive', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 3 }]);

    await expect(
      receivePurchaseOrder(actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 3 }],
      }),
    ).resolves.toBeDefined();
  });

  // Note: the role check itself lives in the resolver via `requireRole`, so the
  // API-level rejection is covered by the schema test below. This asserts the
  // policy function that both the resolver and the UI read from.
  it('does not include viewers in the receiving role set', async () => {
    const { CAN_RECEIVE_STOCK, requireRole } = await import('../src/shared/auth.js');

    expect(() => requireRole(actorFor(fx.viewer), CAN_RECEIVE_STOCK)).toThrowError(
      /cannot perform this action/i,
    );
    expect(() => requireRole(null, CAN_RECEIVE_STOCK)).toThrowError(/sign in/i);
    expect(requireRole(actorFor(fx.warehouse), CAN_RECEIVE_STOCK)).toMatchObject({
      role: 'WAREHOUSE',
    });
  });
});

describe('voiding a purchase order', () => {
  it('refuses once stock has been received against it', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

    await receivePurchaseOrder(actorFor(fx.warehouse), {
      purchaseOrderId: po.id,
      lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 1 }],
    });

    // Voiding now would orphan a ledger row under a deleted parent.
    await expect(voidPurchaseOrder(po.id)).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
  });

  it('hides a voided order and its lines from the derived views', async () => {
    const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

    await voidPurchaseOrder(po.id);

    expect(await statusOf(po.id)).toBeUndefined();
    // Soft delete, not a real one: the row is still there for audit.
    const row = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });
});
