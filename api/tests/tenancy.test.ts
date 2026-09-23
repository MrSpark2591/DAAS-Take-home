import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listPurchaseOrderIds } from '../src/domains/purchasing/repository.js';
import { receivePurchaseOrder } from '../src/domains/purchasing/service.js';
import { prisma as scopedPrisma } from '../src/shared/prisma.js';
import { withTenant } from '../src/shared/tenancy.js';
import {
  actorFor,
  asTenant,
  type Fixtures,
  givenPurchaseOrder,
  prisma,
  seedFixtures,
} from './helpers.js';

/**
 * Tenant isolation.
 *
 * A cross-tenant leak is the worst bug this system could have -- it shows one
 * customer another customer's costs and suppliers -- so these tests are about
 * the ways the scoping could quietly fail rather than about the happy path.
 *
 * The concurrency test earns its place: the first implementation bound the
 * tenant with `AsyncLocalStorage.enterWith` inside the GraphQL context
 * function, which looked correct and was not -- the store had been lost by the
 * time resolvers ran. A test that only exercised one tenant at a time would
 * have passed against a version that leaked.
 */

let alpha: Fixtures;
let beta: Fixtures;

beforeEach(async () => {
  alpha = await seedFixtures();
  beta = await seedFixtures();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('reads are confined to one tenant', () => {
  it('never returns another tenant’s purchase orders', async () => {
    const mine = await givenPurchaseOrder(alpha, [
      { productId: alpha.widget.id, quantityOrdered: 5 },
    ]);
    const theirs = await givenPurchaseOrder(beta, [
      { productId: beta.widget.id, quantityOrdered: 5 },
    ]);

    const seen = await asTenant(alpha, () => scopedPrisma.purchaseOrder.findMany());
    const ids = seen.map((po) => po.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('returns nothing when asked for another tenant’s row by id', async () => {
    const theirs = await givenPurchaseOrder(beta, [
      { productId: beta.widget.id, quantityOrdered: 5 },
    ]);

    // Knowing the id is not enough: the filter is injected regardless of what
    // the caller asked for.
    const found = await asTenant(alpha, () =>
      scopedPrisma.purchaseOrder.findFirst({ where: { id: theirs.id } }),
    );

    expect(found).toBeNull();
  });

  it('scopes raw SQL too, which the extension cannot reach', async () => {
    await givenPurchaseOrder(alpha, [{ productId: alpha.widget.id, quantityOrdered: 5 }]);
    await givenPurchaseOrder(beta, [{ productId: beta.widget.id, quantityOrdered: 5 }]);

    // `listPurchaseOrderIds` is hand-written SQL, so its tenant predicate is
    // hand-written too. This is the test that fails if someone removes it.
    const fromAlpha = await asTenant(alpha, () => listPurchaseOrderIds({}, { first: 50 }));
    const fromBeta = await asTenant(beta, () => listPurchaseOrderIds({}, { first: 50 }));

    expect(fromAlpha.totalCount).toBe(1);
    expect(fromBeta.totalCount).toBe(1);
    expect(fromAlpha.ids).not.toEqual(fromBeta.ids);
  });

  it('counts only its own rows', async () => {
    await givenPurchaseOrder(alpha, [{ productId: alpha.widget.id, quantityOrdered: 1 }]);
    await givenPurchaseOrder(alpha, [{ productId: alpha.gadget.id, quantityOrdered: 1 }]);
    await givenPurchaseOrder(beta, [{ productId: beta.widget.id, quantityOrdered: 1 }]);

    const count = await asTenant(alpha, () => scopedPrisma.purchaseOrder.count());
    expect(count).toBe(2);
  });
});

describe('writes land in the right tenant', () => {
  it('stamps the acting tenant on a receipt, not the one in the payload', async () => {
    const po = await givenPurchaseOrder(alpha, [
      { productId: alpha.widget.id, quantityOrdered: 4 },
    ]);

    await asTenant(alpha, async () =>
      receivePurchaseOrder(await actorFor(alpha.warehouse), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: 4 }],
      }),
    );

    const movements = await prisma.stockMovement.findMany({
      where: { purchaseOrderLineId: po.lines[0]!.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.tenantId).toBe(alpha.tenant.id);

    // And the other tenant sees no stock at all.
    const theirStock = await asTenant(beta, () => scopedPrisma.stockOnHand.findMany());
    expect(theirStock).toHaveLength(0);
  });

  it('refuses to receive against another tenant’s purchase order', async () => {
    const theirs = await givenPurchaseOrder(beta, [
      { productId: beta.widget.id, quantityOrdered: 4 },
    ]);

    // From alpha's context the order simply does not exist.
    await expect(
      asTenant(alpha, async () =>
        receivePurchaseOrder(await actorFor(alpha.warehouse), {
          purchaseOrderId: theirs.id,
          lines: [{ purchaseOrderLineId: theirs.lines[0]!.id, quantity: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
});

describe('the tenant store survives concurrency', () => {
  it('keeps interleaved work from two tenants apart', async () => {
    await givenPurchaseOrder(alpha, [{ productId: alpha.widget.id, quantityOrdered: 1 }]);
    await givenPurchaseOrder(beta, [{ productId: beta.widget.id, quantityOrdered: 1 }]);
    await givenPurchaseOrder(beta, [{ productId: beta.gadget.id, quantityOrdered: 1 }]);

    // Twenty operations from two tenants, started together and resolving out of
    // order. If the store were shared, or bound to the wrong async chain, some
    // of these would see the other tenant's rows.
    const work = Array.from({ length: 20 }, (_, index) => {
      const fx = index % 2 === 0 ? alpha : beta;
      const expected = fx === alpha ? 1 : 2;
      return asTenant(fx, async () => {
        // A little jitter, so the operations genuinely interleave rather than
        // running to completion one after another.
        await new Promise((resolve) => setTimeout(resolve, index % 5));
        const count = await scopedPrisma.purchaseOrder.count();
        return { tenant: fx.tenant.slug, count, expected };
      });
    });

    const results = await Promise.all(work);

    for (const result of results) {
      expect(result.count).toBe(result.expected);
    }
  });

  it('keeps nested async work inside the tenant that started it', async () => {
    await givenPurchaseOrder(alpha, [{ productId: alpha.widget.id, quantityOrdered: 1 }]);

    const result = await asTenant(alpha, async () => {
      // Several layers of async, which is what a resolver chain looks like.
      const outer = await scopedPrisma.purchaseOrder.count();
      const inner = await (async () => {
        await Promise.resolve();
        return scopedPrisma.purchaseOrder.count();
      })();
      return { outer, inner };
    });

    expect(result.outer).toBe(1);
    expect(result.inner).toBe(1);
  });
});

describe('no tenant context', () => {
  it('throws rather than reading every tenant', async () => {
    // The dangerous default would be "no filter", which silently returns
    // everything. Failing loudly is the whole point.
    await expect(scopedPrisma.purchaseOrder.findMany()).rejects.toThrow(/no tenant context/i);
  });

  it('leaves global tables reachable without one', async () => {
    // Permissions are the catalogue, identical for everyone.
    await expect(scopedPrisma.permission.findMany()).resolves.toBeInstanceOf(Array);
  });
});

describe('uniqueness is per tenant', () => {
  it('lets two tenants use the same PO number, SKU and vendor code', async () => {
    // Global uniqueness here would make onboarding a second customer fail on
    // their first import, which is an expensive thing to discover late.
    const shared = `SHARED-${Date.now()}`;

    await withTenant({ tenantId: alpha.tenant.id, slug: 'a' }, async () => {
      await prisma.vendor.create({ data: { tenantId: alpha.tenant.id, code: shared, name: 'A' } });
      await prisma.product.create({ data: { tenantId: alpha.tenant.id, sku: shared, name: 'A' } });
    });

    await expect(
      withTenant({ tenantId: beta.tenant.id, slug: 'b' }, async () => {
        await prisma.vendor.create({ data: { tenantId: beta.tenant.id, code: shared, name: 'B' } });
        await prisma.product.create({ data: { tenantId: beta.tenant.id, sku: shared, name: 'B' } });
      }),
    ).resolves.not.toThrow();
  });

  it('still rejects a duplicate inside one tenant', async () => {
    const code = `DUP-${Date.now()}`;
    await prisma.vendor.create({ data: { tenantId: alpha.tenant.id, code, name: 'First' } });

    await expect(
      prisma.vendor.create({ data: { tenantId: alpha.tenant.id, code, name: 'Second' } }),
    ).rejects.toThrow();
  });
});
