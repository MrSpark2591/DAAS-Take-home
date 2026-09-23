-- Indexes built for the queries the API actually runs.
--
-- The list endpoints changed shape: they now filter, order and paginate in one
-- statement, with a keyset window. The old single-column indexes cannot serve
-- that -- `WHERE vendor_id = $1 AND id < $2 ORDER BY id DESC` needs the filter
-- and the sort key in one index, or Postgres filters by vendor and then sorts
-- the result.
--
-- Note on production: these are plain CREATE INDEX, which takes a write lock
-- for the duration. On a populated table you would run the same statements
-- with CREATE INDEX CONCURRENTLY, outside a migration transaction -- Prisma
-- wraps migrations in one, and CONCURRENTLY cannot run inside a transaction.

-- ---------------------------------------------------------------------------
-- Trigram search.
--
-- `po_number ILIKE '%1002%'` has a leading wildcard, so a btree index cannot be
-- used at all -- it can only seek on a known prefix. A GIN trigram index breaks
-- each value into three-character chunks and can match a substring anywhere.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "purchase_orders_po_number_trgm_idx"
  ON "purchase_orders" USING GIN ("po_number" gin_trgm_ops);

CREATE INDEX "products_sku_trgm_idx"
  ON "products" USING GIN ("sku" gin_trgm_ops);

CREATE INDEX "products_name_trgm_idx"
  ON "products" USING GIN ("name" gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Purchase order list: filter + keyset, over live rows only.
--
-- Every one of these is partial on `deleted_at IS NULL`, because every list
-- query carries that predicate and soft-deleted rows are never listed. The
-- index then holds only rows that can actually be returned, which keeps it
-- smaller and means a soft delete removes the row from the index rather than
-- leaving it to be filtered out on read.
--
-- `id DESC` is part of the key, not an afterthought: it is both the sort order
-- and the keyset column, so one index seek answers "the next 20 after this
-- cursor" without a sort step.
-- ---------------------------------------------------------------------------
-- Verified with EXPLAIN rather than assumed. On a table with few deleted rows
-- the planner prefers a backward scan of the primary key, and this index is
-- redundant. At 70% soft-deleted -- what a long-lived table looks like -- it
-- switches to an Index Only Scan here, because the PK scan would otherwise read
-- and discard every dead row to fill a page.
CREATE INDEX "purchase_orders_live_keyset_idx"
  ON "purchase_orders" ("id" DESC) WHERE "deleted_at" IS NULL;

CREATE INDEX "purchase_orders_vendor_keyset_idx"
  ON "purchase_orders" ("vendor_id", "id" DESC) WHERE "deleted_at" IS NULL;

CREATE INDEX "purchase_orders_location_keyset_idx"
  ON "purchase_orders" ("location_id", "id" DESC) WHERE "deleted_at" IS NULL;

-- Superseded by the composites above: a lookup by vendor alone uses the
-- leading column of `purchase_orders_vendor_keyset_idx`. Keeping both would
-- cost an extra write on every insert and update for no read benefit.
DROP INDEX "purchase_orders_vendor_id_idx";
DROP INDEX "purchase_orders_location_id_idx";

-- ---------------------------------------------------------------------------
-- The derived-status views.
--
-- `purchase_order_line_totals` LEFT JOINs stock_movements on
-- (purchase_order_line_id, type = 'RECEIPT'). A partial index on exactly that
-- predicate is smaller than the existing full index and matches the join
-- condition precisely, which matters because this view is evaluated for every
-- status-filtered list query.
-- ---------------------------------------------------------------------------
CREATE INDEX "stock_movements_receipts_by_line_idx"
  ON "stock_movements" ("purchase_order_line_id")
  WHERE "type" = 'RECEIPT';

-- Line lookups are always scoped to live lines.
CREATE INDEX "purchase_order_lines_live_by_order_idx"
  ON "purchase_order_lines" ("purchase_order_id") WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Stock on hand list.
--
-- Ordered by SKU with a (sku, id) keyset. The join to products is what supplies
-- the sort key, so `products_sku_live_key` already covers the ordering; this
-- index covers the location filter together with the quantity predicate used by
-- `inStockOnly`.
-- ---------------------------------------------------------------------------
CREATE INDEX "stock_on_hand_location_quantity_idx"
  ON "stock_on_hand" ("location_id", "quantity");

DROP INDEX "stock_on_hand_location_id_idx";

-- ---------------------------------------------------------------------------
-- Session cleanup.
--
-- Expiring old refresh tokens scans for rows past their expiry that are still
-- live; a partial index means that job touches only the rows it can act on.
-- ---------------------------------------------------------------------------
CREATE INDEX "refresh_tokens_active_expiry_idx"
  ON "refresh_tokens" ("expires_at")
  WHERE "revoked_at" IS NULL AND "rotated_at" IS NULL;
