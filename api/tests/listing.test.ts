import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listPurchaseOrderIds, listStockOnHandIds } from '../src/domains/purchasing/repository.js';
import {
  asTenant,
  type Fixtures,
  givenPurchaseOrder,
  givenStock,
  prisma,
  seedFixtures,
} from './helpers.js';

/**
 * Filtering and pagination happen in SQL, so these tests are about the things
 * that break when they do not: pages that overlap or skip rows, a total that
 * disagrees with the list, and filters that silently match more than the user
 * asked for.
 */

let fx: Fixtures;

beforeEach(async () => {
  fx = await seedFixtures();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Creates `count` purchase orders so there is something to page through. */
async function givenManyPurchaseOrders(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const po = await givenPurchaseOrder(fx, [
      { productId: fx.widget.id, quantityOrdered: index + 1 },
    ]);
    ids.push(po.id);
  }
  return ids;
}

describe('paging through purchase orders', () => {
  it('walks the whole list without repeating or skipping a row', () => {
    return asTenant(fx, async () => {
      const created = await givenManyPurchaseOrders(7);

      const seen: string[] = [];
      let after: string | null = null;

      // Walk forward the way a client would, following endCursor each time.
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await listPurchaseOrderIds({}, { first: 3, after });
        seen.push(...page.ids);
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }

      const mine = seen.filter((id) => created.includes(id));
      expect(mine).toHaveLength(created.length);
      // No duplicates: a row appearing on two pages is the classic offset bug.
      expect(new Set(mine).size).toBe(created.length);
    });
  });

  it('reports a total that ignores the page size', () => {
    return asTenant(fx, async () => {
      await givenManyPurchaseOrders(5);

      const page = await listPurchaseOrderIds({ vendorId: fx.vendor.id }, { first: 2 });

      expect(page.ids).toHaveLength(2);
      expect(page.totalCount).toBe(5);
      expect(page.pageInfo.hasNextPage).toBe(true);
    });
  });

  it('returns newest first', () => {
    return asTenant(fx, async () => {
      const created = await givenManyPurchaseOrders(3);

      const page = await listPurchaseOrderIds({ vendorId: fx.vendor.id }, { first: 10 });

      // UUIDv7 sorts by creation time, so the most recently created comes first.
      expect(page.ids).toEqual([...created].reverse());
    });
  });

  it('stops cleanly on the last page', () => {
    return asTenant(fx, async () => {
      await givenManyPurchaseOrders(2);

      const page = await listPurchaseOrderIds({ vendorId: fx.vendor.id }, { first: 10 });

      expect(page.pageInfo.hasNextPage).toBe(false);
      expect(page.ids).toHaveLength(2);
    });
  });

  it('rejects a page size beyond the cap', () => {
    return asTenant(fx, async () => {
      await expect(listPurchaseOrderIds({}, { first: 5000 })).rejects.toThrow(/cannot exceed/i);
      await expect(listPurchaseOrderIds({}, { first: 0 })).rejects.toThrow(
        /positive whole number/i,
      );
    });
  });

  it('rejects a cursor it did not issue', () => {
    return asTenant(fx, async () => {
      await expect(listPurchaseOrderIds({}, { after: 'not-a-cursor' })).rejects.toThrow(
        /invalid pagination cursor/i,
      );
    });
  });
});

describe('filtering purchase orders', () => {
  it('combines filters with AND rather than widening', () => {
    return asTenant(fx, async () => {
      const mine = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

      // Right vendor, wrong status: the combination must exclude it.
      const wrongStatus = await listPurchaseOrderIds(
        { vendorId: fx.vendor.id, status: 'RECEIVED' },
        { first: 50 },
      );
      expect(wrongStatus.ids).not.toContain(mine.id);

      const bothMatch = await listPurchaseOrderIds(
        { vendorId: fx.vendor.id, status: 'OPEN' },
        { first: 50 },
      );
      expect(bothMatch.ids).toContain(mine.id);
    });
  });

  it('matches a PO number substring, case-insensitively', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 1 }]);
      const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
      const middle = row.poNumber.slice(2, 8);

      const page = await listPurchaseOrderIds({ search: middle.toLowerCase() }, { first: 50 });
      expect(page.ids).toContain(po.id);
    });
  });

  it('treats % and _ in a search as literal characters', () => {
    return asTenant(fx, async () => {
      await givenManyPurchaseOrders(3);

      // Unescaped, `%` is a LIKE wildcard and would match every row -- which is
      // exactly the bug that makes a search box look like it is ignoring input.
      const wildcard = await listPurchaseOrderIds({ search: '%' }, { first: 50 });
      expect(wildcard.totalCount).toBe(0);

      const underscore = await listPurchaseOrderIds({ search: '_' }, { first: 50 });
      expect(underscore.totalCount).toBe(0);
    });
  });

  it('excludes soft-deleted purchase orders', () => {
    return asTenant(fx, async () => {
      const po = await givenPurchaseOrder(fx, [{ productId: fx.widget.id, quantityOrdered: 5 }]);

      const before = await listPurchaseOrderIds({ vendorId: fx.vendor.id }, { first: 50 });
      expect(before.ids).toContain(po.id);

      await prisma.purchaseOrder.update({ where: { id: po.id }, data: { deletedAt: new Date() } });

      const after = await listPurchaseOrderIds({ vendorId: fx.vendor.id }, { first: 50 });
      expect(after.ids).not.toContain(po.id);
      expect(after.totalCount).toBe(before.totalCount - 1);
    });
  });
});

describe('filtering stock on hand', () => {
  beforeEach(async () => {
    // Two products in one location, one of them at zero. Created through the
    // ledger, because on-hand rows with no movement behind them break the
    // invariant every other test asserts.
    await givenStock(fx, fx.widget.id, fx.mainLocation.id, 12);
    await givenStock(fx, fx.gadget.id, fx.mainLocation.id, 0);
  });

  it('narrows by location', () => {
    return asTenant(fx, async () => {
      const here = await listStockOnHandIds({ locationId: fx.mainLocation.id }, { first: 50 });
      const elsewhere = await listStockOnHandIds(
        { locationId: fx.overflowLocation.id },
        { first: 50 },
      );

      expect(here.totalCount).toBe(2);
      expect(elsewhere.totalCount).toBe(0);
    });
  });

  it('hides zero rows when asked', () => {
    return asTenant(fx, async () => {
      const all = await listStockOnHandIds({ locationId: fx.mainLocation.id }, { first: 50 });
      const stocked = await listStockOnHandIds(
        { locationId: fx.mainLocation.id, inStockOnly: true },
        { first: 50 },
      );

      expect(all.totalCount).toBe(2);
      expect(stocked.totalCount).toBe(1);
    });
  });

  it('searches SKU and product name together', () => {
    return asTenant(fx, async () => {
      const bySku = await listStockOnHandIds(
        { locationId: fx.mainLocation.id, search: fx.widget.sku.slice(0, 6) },
        { first: 50 },
      );
      expect(bySku.totalCount).toBe(1);

      const byName = await listStockOnHandIds(
        { locationId: fx.mainLocation.id, search: 'Gadget' },
        { first: 50 },
      );
      expect(byName.totalCount).toBe(1);
    });
  });

  it('orders by SKU and pages without overlap', () => {
    return asTenant(fx, async () => {
      const first = await listStockOnHandIds({ locationId: fx.mainLocation.id }, { first: 1 });
      expect(first.ids).toHaveLength(1);
      expect(first.pageInfo.hasNextPage).toBe(true);

      const second = await listStockOnHandIds(
        { locationId: fx.mainLocation.id },
        { first: 1, after: first.pageInfo.endCursor },
      );

      // The keyset is (sku, id), so the second page continues rather than repeats.
      expect(second.ids[0]).not.toBe(first.ids[0]);
    });
  });
});
