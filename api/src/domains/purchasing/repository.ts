import { Prisma } from '@prisma/client';
import {
  buildPage,
  encodeCursor,
  type PageInfo,
  resolvePageArgs,
} from '../../shared/pagination.js';
import { prisma } from '../../shared/prisma.js';
import { requireTenant } from '../../shared/tenancy.js';

/**
 * List queries that SQL has to answer.
 *
 * Everything here is one statement: filters, ordering, and the keyset window
 * are composed into a single query so the database returns exactly the page
 * asked for. The previous implementation fetched every matching id and then
 * re-queried, which cannot paginate and gets slower with every purchase order
 * ever raised.
 *
 * Fragments are built with `Prisma.sql`, so every value is a bound parameter --
 * string interpolation into SQL is never used, including for the search term.
 */

export interface PurchaseOrderFilter {
  status?: 'OPEN' | 'PARTIAL' | 'RECEIVED' | null;
  vendorId?: string | null;
  locationId?: string | null;
  /** Case-insensitive substring of the PO number. */
  search?: string | null;
}

export interface ListResult<T> {
  nodes: T[];
  pageInfo: PageInfo;
  totalCount: number;
}

/**
 * Builds the shared WHERE clause.
 *
 * The same fragment feeds both the page query and the count, so the number the
 * UI shows can never disagree with the rows it lists.
 */
function purchaseOrderConditions(filter: PurchaseOrderFilter): Prisma.Sql {
  // Raw SQL bypasses the tenant extension, so the predicate is added by hand
  // here -- and first, so it is impossible to read this function and miss it.
  // `listing.test.ts` fails if either list ever returns another tenant's rows.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`po."tenant_id" = ${requireTenant().tenantId}::uuid`,
    Prisma.sql`po."deleted_at" IS NULL`,
  ];

  // Status lives in a view because it is derived from the ledger, so filtering
  // on it is a join rather than a column comparison -- but it is still one
  // indexed query, not a fetch-everything-and-filter.
  if (filter.status) conditions.push(Prisma.sql`s."status" = ${filter.status}`);
  if (filter.vendorId) conditions.push(Prisma.sql`po."vendor_id" = ${filter.vendorId}::uuid`);
  if (filter.locationId) conditions.push(Prisma.sql`po."location_id" = ${filter.locationId}::uuid`);

  const search = filter.search?.trim();
  if (search) {
    // `%` and `_` are LIKE wildcards; escaping them keeps a user's literal
    // input from matching far more than they typed.
    const escaped = search.replace(/[\\%_]/g, (match) => `\\${match}`);
    conditions.push(Prisma.sql`po."po_number" ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }

  return Prisma.join(conditions, ' AND ');
}

export async function listPurchaseOrderIds(
  filter: PurchaseOrderFilter,
  page: { first?: number | null; after?: string | null },
): Promise<{ ids: string[]; pageInfo: PageInfo; totalCount: number }> {
  const { limit, cursor } = resolvePageArgs(page);
  const where = purchaseOrderConditions(filter);

  // Newest first. UUIDv7 sorts by creation time, so this is both a meaningful
  // order and the keyset column -- `id < cursor` is a single index seek at any
  // depth, where OFFSET would walk and discard every skipped row.
  const keyset = cursor?.[0] ? Prisma.sql`AND po."id" < ${cursor[0]}::uuid` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT po."id"
    FROM "purchase_orders" po
    JOIN "purchase_order_status" s ON s."purchase_order_id" = po."id"
    WHERE ${where}
    ${keyset}
    ORDER BY po."id" DESC
    LIMIT ${limit + 1}
  `;

  const counted = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::INTEGER AS "count"
    FROM "purchase_orders" po
    JOIN "purchase_order_status" s ON s."purchase_order_id" = po."id"
    WHERE ${where}
  `;
  const count = counted[0]?.count ?? 0;

  const { nodes, pageInfo } = buildPage(rows, limit, (row) => encodeCursor([row.id]));
  return { ids: nodes.map((row) => row.id), pageInfo, totalCount: count };
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

export interface StockOnHandFilter {
  locationId?: string | null;
  productId?: string | null;
  /** Case-insensitive substring of SKU or product name. */
  search?: string | null;
  /** Hides rows that have fallen to zero. */
  inStockOnly?: boolean | null;
}

function stockConditions(filter: StockOnHandFilter): Prisma.Sql {
  // As above: the extension cannot reach raw SQL, so the tenant is explicit.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`soh."tenant_id" = ${requireTenant().tenantId}::uuid`,
    Prisma.sql`p."deleted_at" IS NULL`,
  ];

  if (filter.locationId)
    conditions.push(Prisma.sql`soh."location_id" = ${filter.locationId}::uuid`);
  if (filter.productId) conditions.push(Prisma.sql`soh."product_id" = ${filter.productId}::uuid`);
  if (filter.inStockOnly) conditions.push(Prisma.sql`soh."quantity" > 0`);

  const search = filter.search?.trim();
  if (search) {
    const escaped = search.replace(/[\\%_]/g, (match) => `\\${match}`);
    const pattern = `%${escaped}%`;
    conditions.push(
      Prisma.sql`(p."sku" ILIKE ${pattern} ESCAPE '\\' OR p."name" ILIKE ${pattern} ESCAPE '\\')`,
    );
  }

  return Prisma.join(conditions, ' AND ');
}

export async function listStockOnHandIds(
  filter: StockOnHandFilter,
  page: { first?: number | null; after?: string | null },
): Promise<{ ids: string[]; pageInfo: PageInfo; totalCount: number }> {
  const { limit, cursor } = resolvePageArgs(page);
  const where = stockConditions(filter);

  // Ordered by SKU, because that is how someone reads a stock list -- which
  // means the keyset needs a composite key, since SKUs are not unique across
  // locations. Postgres row-value comparison expresses that as one predicate
  // that an index on (sku, id) can still satisfy.
  const keyset =
    cursor?.[0] && cursor[1]
      ? Prisma.sql`AND (p."sku", soh."id") > (${cursor[0]}, ${cursor[1]}::uuid)`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<{ id: string; sku: string }[]>`
    SELECT soh."id", p."sku"
    FROM "stock_on_hand" soh
    JOIN "products" p ON p."id" = soh."product_id"
    WHERE ${where}
    ${keyset}
    ORDER BY p."sku" ASC, soh."id" ASC
    LIMIT ${limit + 1}
  `;

  const counted = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::INTEGER AS "count"
    FROM "stock_on_hand" soh
    JOIN "products" p ON p."id" = soh."product_id"
    WHERE ${where}
  `;
  const count = counted[0]?.count ?? 0;

  const { nodes, pageInfo } = buildPage(rows, limit, (row) => encodeCursor([row.sku, row.id]));
  return { ids: nodes.map((row) => row.id), pageInfo, totalCount: count };
}

/**
 * Reorders rows to match the order the id query returned.
 *
 * `findMany({ where: { id: { in: ids } } })` does not preserve the order of
 * `ids`, so sorting the page in SQL would be undone by the hydration step.
 */
export function inIdOrder<T extends { id: string }>(rows: T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
