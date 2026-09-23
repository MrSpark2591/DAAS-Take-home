import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { receivePurchaseOrder, voidPurchaseOrder } from '../src/domains/purchasing/service.js';
import { requirePermission } from '../src/shared/auth.js';
import { PERMISSIONS } from '../src/shared/permissions.js';
import {
  actorFor,
  asTenant,
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
  it('moves stock and advances status when a delivery arrives short', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 20 }]);
      const line = po.lines[0]!;

      // The truck showed up with 8 of the 20 ordered.
      await receivePurchaseOrder(await actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: line.id, quantity: 8 }],
      });

      expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(8);

      const partial = await statusOf(po.id);
      expect(partial?.status).toBe('PARTIAL');
      expect(partial?.totalReceived).toBe(8);

      // The rest arrives later.
      await receivePurchaseOrder(await actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: line.id, quantity: 12 }],
      });

      expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(20);
      expect((await statusOf(po.id))?.status).toBe('RECEIVED');

      // Two receipts, two ledger rows: the history of the delivery survives.
      expect(await movementsFor(line.id)).toHaveLength(2);
      expect(await ledgerMatchesProjection()).toBe(true);
    });
  });

  it('refuses to receive more than was ordered and leaves no trace', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 10 }]);
      const line = po.lines[0]!;

      await receivePurchaseOrder(await actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: line.id, quantity: 7 }],
      });

      // Only 3 outstanding, but the docket says 5.
      await expect(
        receivePurchaseOrder(await actorFor(fx.warehouse), {
          purchaseOrderId: po.id,
          lines: [{ purchaseOrderLineId: line.id, quantity: 5 }],
        }),
      ).rejects.toMatchObject({ extensions: { code: 'OVER_RECEIPT', ordered: 10, attempted: 5 } });

      // The rejected receipt must not have moved anything.
      expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(7);
      expect(await movementsFor(line.id)).toHaveLength(1);
    });
  });

  it('applies a multi-line receipt all-or-nothing', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [
        { productId: fx.widget.id, quantityOrdered: 10 },
        { productId: fx.gadget.id, quantityOrdered: 4 },
      ]);
      const [widgetLine, gadgetLine] = po.lines;

      // The first line is fine; the second over-receives. The whole receipt must
      // roll back -- a half-applied delivery is the worst possible outcome,
      // because on-hand silently disagrees with the paperwork.
      await expect(
        receivePurchaseOrder(await actorFor(fx.warehouse), {
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
  });

  it('sums repeated lines in one call before checking the limit', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 10 }]);
      const line = po.lines[0]!;

      // Scanning the same SKU twice on one docket: 6 + 6 is 12, over the 10
      // ordered, even though neither entry exceeds it on its own.
      await expect(
        receivePurchaseOrder(await actorFor(fx.warehouse), {
          purchaseOrderId: po.id,
          lines: [
            { purchaseOrderLineId: line.id, quantity: 6 },
            { purchaseOrderLineId: line.id, quantity: 6 },
          ],
        }),
      ).rejects.toMatchObject({ extensions: { code: 'OVER_RECEIPT', attempted: 12 } });

      expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(0);
    });
  });

  it('puts stock in the location the receipt names, not the order default', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

      // Delivery diverted to the overflow bay because main was full.
      await receivePurchaseOrder(await actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        locationId: fx.overflowLocation.id,
        lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 5 }],
      });

      expect(await onHand(fx.widget.id, fx.overflowLocation.id)).toBe(5);
      expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(0);
      // The PO is still fully received -- receiving elsewhere does not stall it.
      expect((await statusOf(po.id))?.status).toBe('RECEIVED');
    });
  });

  it('lets only one of two simultaneous receipts take the last item', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 1 }]);
      const line = po.lines[0]!;

      // Two staff scan the same last unit at the same moment. Without the
      // `FOR UPDATE` lock on the PO both read "1 outstanding" and both write,
      // leaving on-hand at 2 for a single ordered unit.
      const results = await Promise.allSettled([
        receivePurchaseOrder(await actorFor(fx.warehouse), {
          purchaseOrderId: po.id,
          lines: [{ purchaseOrderLineId: line.id, quantity: 1 }],
        }),
        receivePurchaseOrder(await actorFor(fx.admin), {
          purchaseOrderId: po.id,
          lines: [{ purchaseOrderLineId: line.id, quantity: 1 }],
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(1);
      expect(await ledgerMatchesProjection()).toBe(true);
    });
  });

  it('rejects a line that belongs to a different purchase order', () => {
    return asTenant(fx, async () => {
      const [mine, theirs] = await Promise.all([
        givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]),
        givenPurchaseOrder(fx, [{ productId: fx.gadget.id, quantityOrdered: 5 }]),
      ]);

      await expect(
        receivePurchaseOrder(await actorFor(fx.warehouse), {
          purchaseOrderId: mine.id,
          lines: [{ purchaseOrderLineId: theirs.lines[0]!.id, quantity: 1 }],
        }),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

      expect(await onHand(fx.gadget.id, fx.mainLocation.id)).toBe(0);
    });
  });

  it('rejects zero and negative quantities before touching the ledger', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);
      const line = po.lines[0]!;

      for (const quantity of [0, -3]) {
        await expect(
          receivePurchaseOrder(await actorFor(fx.warehouse), {
            purchaseOrderId: po.id,
            lines: [{ purchaseOrderLineId: line.id, quantity }],
          }),
        ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      }

      expect(await movementsFor(line.id)).toHaveLength(0);
    });
  });
});

describe('who is allowed to receive', () => {
  it('lets a user holding stock:receive receive', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 3 }]);

      await expect(
        receivePurchaseOrder(await actorFor(fx.warehouse), {
          purchaseOrderId: po.id,
          lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 3 }],
        }),
      ).resolves.toBeDefined();
    });
  });

  // The gate lives in the resolver, so these assert the policy function that
  // both the resolver and the UI read from.
  it('refuses a viewer, who holds no stock:receive permission', () => {
    return asTenant(fx, async () => {
      const viewer = await actorFor(fx.viewer);

      expect(() => requirePermission(viewer, PERMISSIONS.STOCK_RECEIVE)).toThrowError(
        /requires the "stock:receive" permission/i,
      );
      expect(() => requirePermission(null, PERMISSIONS.STOCK_RECEIVE)).toThrowError(/sign in/i);
      expect(
        requirePermission(await actorFor(fx.warehouse), PERMISSIONS.STOCK_RECEIVE),
      ).toMatchObject({ id: fx.warehouse.id });
    });
  });

  it('grants access through any role holding the permission, not a named role', () => {
    return asTenant(fx, async () => {
      // The point of the split: a role invented at runtime, with no code change,
      // must be able to authorise receiving. If this ever fails, something has
      // started branching on a role key again.
      const goodsIn = await prisma.role.create({
        data: {
          tenantId: fx.tenant.id,
          key: `goods-in-${Date.now()}`,
          name: 'Goods In',
          permissions: {
            create: {
              permission: { connect: { key: PERMISSIONS.STOCK_RECEIVE } },
            },
          },
        },
      });
      await prisma.userRole.create({ data: { userId: fx.viewer.id, roleId: goodsIn.id } });

      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 4 }]);

      await expect(
        receivePurchaseOrder(await actorFor(fx.viewer), {
          purchaseOrderId: po.id,
          lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 4 }],
        }),
      ).resolves.toBeDefined();

      expect(await onHand(fx.widget.id, fx.mainLocation.id)).toBe(4);
    });
  });

  it('takes the union when a user holds several roles', () => {
    return asTenant(fx, async () => {
      // Roles add access and never subtract it, so holding viewer *and* a role
      // granting receive must leave the user able to receive.
      const access = await actorFor(fx.viewer);
      expect(access.permissions.has(PERMISSIONS.STOCK_RECEIVE)).toBe(false);

      const extra = await prisma.role.create({
        data: {
          tenantId: fx.tenant.id,
          key: `extra-${Date.now()}`,
          name: 'Extra',
          permissions: {
            create: { permission: { connect: { key: PERMISSIONS.STOCK_RECEIVE } } },
          },
        },
      });
      await prisma.userRole.create({ data: { userId: fx.viewer.id, roleId: extra.id } });

      const widened = await actorFor(fx.viewer);
      expect(widened.roles).toHaveLength(2);
      // Kept what viewer granted, gained what the new role grants.
      expect(widened.permissions.has(PERMISSIONS.PURCHASE_ORDER_READ)).toBe(true);
      expect(widened.permissions.has(PERMISSIONS.STOCK_RECEIVE)).toBe(true);
    });
  });
});

describe('voiding a purchase order', () => {
  it('refuses once stock has been received against it', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

      await receivePurchaseOrder(await actorFor(fx.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 1 }],
      });

      // Voiding now would orphan a ledger row under a deleted parent.
      await expect(voidPurchaseOrder(po.id)).rejects.toMatchObject({
        extensions: { code: 'CONFLICT' },
      });
    });
  });

  it('hides a voided order and its lines from the derived views', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

      await voidPurchaseOrder(po.id);

      expect(await statusOf(po.id)).toBeUndefined();
      // Soft delete, not a real one: the row is still there for audit.
      const row = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
      expect(row?.deletedAt).toBeInstanceOf(Date);
    });
  });
});
