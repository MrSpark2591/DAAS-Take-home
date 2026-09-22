-- DaaS Sprint 2 slice: purchase orders, receiving, and the stock ledger.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "role" AS ENUM ('ADMIN', 'WAREHOUSE', 'VIEWER');

CREATE TYPE "movement_type" AS ENUM (
  'RECEIPT',
  'ADJUSTMENT',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ALLOCATION'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE "users" (
  "id"         UUID           NOT NULL,
  "email"      VARCHAR(320)   NOT NULL,
  "name"       VARCHAR(120)   NOT NULL,
  "role"       "role"         NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vendors" (
  "id"         UUID           NOT NULL,
  "code"       VARCHAR(32)    NOT NULL,
  "name"       VARCHAR(160)   NOT NULL,
  "email"      VARCHAR(320),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "products" (
  "id"         UUID           NOT NULL,
  "sku"        VARCHAR(64)    NOT NULL,
  "name"       VARCHAR(200)   NOT NULL,
  "unit"       VARCHAR(16)    NOT NULL DEFAULT 'ea',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "locations" (
  "id"         UUID           NOT NULL,
  "code"       VARCHAR(32)    NOT NULL,
  "name"       VARCHAR(160)   NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_orders" (
  "id"            UUID           NOT NULL,
  "po_number"     VARCHAR(32)    NOT NULL,
  "vendor_id"     UUID           NOT NULL,
  "location_id"   UUID           NOT NULL,
  "notes"         VARCHAR(2000),
  "created_by_id" UUID           NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"    TIMESTAMPTZ(6),
  CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_order_lines" (
  "id"                UUID           NOT NULL,
  "purchase_order_id" UUID           NOT NULL,
  "product_id"        UUID           NOT NULL,
  "quantity_ordered"  INTEGER        NOT NULL,
  "unit_cost_cents"   INTEGER        NOT NULL,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"        TIMESTAMPTZ(6),
  CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_movements" (
  "id"                     UUID            NOT NULL,
  "product_id"             UUID            NOT NULL,
  "location_id"            UUID            NOT NULL,
  "quantity"               INTEGER         NOT NULL,
  "type"                   "movement_type" NOT NULL,
  "purchase_order_line_id" UUID,
  "reason"                 VARCHAR(500),
  "created_by_id"          UUID            NOT NULL,
  "created_at"             TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_on_hand" (
  "id"          UUID           NOT NULL,
  "product_id"  UUID           NOT NULL,
  "location_id" UUID           NOT NULL,
  "quantity"    INTEGER        NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "stock_on_hand_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Foreign keys. Everything is RESTRICT except PO lines, which are part of the
-- PO aggregate and die with it.
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_vendor_id_fkey"
  FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fkey"
  FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_purchase_order_line_id_fkey"
  FOREIGN KEY ("purchase_order_line_id") REFERENCES "purchase_order_lines" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_on_hand"
  ADD CONSTRAINT "stock_on_hand_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_on_hand"
  ADD CONSTRAINT "stock_on_hand_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX "purchase_orders_vendor_id_idx"  ON "purchase_orders" ("vendor_id");
CREATE INDEX "purchase_orders_location_id_idx" ON "purchase_orders" ("location_id");
CREATE INDEX "purchase_order_lines_purchase_order_id_idx" ON "purchase_order_lines" ("purchase_order_id");
CREATE INDEX "purchase_order_lines_product_id_idx" ON "purchase_order_lines" ("product_id");
CREATE INDEX "stock_movements_product_id_location_id_idx" ON "stock_movements" ("product_id", "location_id");
CREATE INDEX "stock_movements_purchase_order_line_id_idx" ON "stock_movements" ("purchase_order_line_id");
CREATE INDEX "stock_movements_created_at_idx" ON "stock_movements" ("created_at");
CREATE INDEX "stock_on_hand_location_id_idx" ON "stock_on_hand" ("location_id");

-- One on-hand row per product per location. This is what makes the
-- increment-on-receive upsert safe under concurrency.
CREATE UNIQUE INDEX "stock_on_hand_product_location_key"
  ON "stock_on_hand" ("product_id", "location_id");

-- ---------------------------------------------------------------------------
-- Uniqueness, scoped to live rows.
--
-- A plain UNIQUE would make a soft-deleted vendor hold its code hostage
-- forever. Partial indexes give us "unique among rows that still exist", which
-- is what the domain actually means.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "users_email_live_key"
  ON "users" ("email") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "vendors_code_live_key"
  ON "vendors" ("code") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "products_sku_live_key"
  ON "products" ("sku") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "locations_code_live_key"
  ON "locations" ("code") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "purchase_orders_po_number_live_key"
  ON "purchase_orders" ("po_number") WHERE "deleted_at" IS NULL;

-- A product appears at most once on a given PO, so "receive 5 of SKU-1"
-- is never ambiguous about which line it lands on.
CREATE UNIQUE INDEX "purchase_order_lines_po_product_live_key"
  ON "purchase_order_lines" ("purchase_order_id", "product_id")
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Check constraints. These are the invariants we refuse to let the
-- application get wrong, even through a migration script or a psql session.
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_quantity_ordered_positive"
  CHECK ("quantity_ordered" > 0);

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_unit_cost_non_negative"
  CHECK ("unit_cost_cents" >= 0);

-- A zero-quantity movement is a no-op row that only pollutes the ledger.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_quantity_non_zero"
  CHECK ("quantity" <> 0);

-- Receipts add stock, by definition. This is the DB-level half of the
-- over-receipt guard in the resolver.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_receipt_is_positive"
  CHECK ("type" <> 'RECEIPT' OR "quantity" > 0);

-- Every RECEIPT traces back to the PO line it satisfied. Without this the
-- "quantity received" view could silently under-count.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_receipt_has_po_line"
  CHECK ("type" <> 'RECEIPT' OR "purchase_order_line_id" IS NOT NULL);

-- You cannot hold negative stock. If a future adjust/allocate tries, the
-- transaction dies here rather than corrupting the projection.
ALTER TABLE "stock_on_hand"
  ADD CONSTRAINT "stock_on_hand_quantity_non_negative"
  CHECK ("quantity" >= 0);

-- ---------------------------------------------------------------------------
-- Derived state.
--
-- Received quantity and PO status are computed from the ledger, never stored.
-- Keeping them in views means every reader -- GraphQL, a psql session, a future
-- reporting job -- gets the same answer, and there is no flag to drift.
-- ---------------------------------------------------------------------------
CREATE VIEW "purchase_order_line_totals" AS
SELECT
  l."id"                AS "purchase_order_line_id",
  l."purchase_order_id" AS "purchase_order_id",
  l."quantity_ordered"  AS "quantity_ordered",
  COALESCE(SUM(m."quantity"), 0)::INTEGER AS "quantity_received",
  GREATEST(
    l."quantity_ordered" - COALESCE(SUM(m."quantity"), 0),
    0
  )::INTEGER AS "quantity_outstanding"
FROM "purchase_order_lines" l
LEFT JOIN "stock_movements" m
  ON m."purchase_order_line_id" = l."id"
 AND m."type" = 'RECEIPT'
WHERE l."deleted_at" IS NULL
GROUP BY l."id", l."purchase_order_id", l."quantity_ordered";

CREATE VIEW "purchase_order_status" AS
SELECT
  po."id" AS "purchase_order_id",
  COALESCE(SUM(t."quantity_ordered"), 0)::INTEGER  AS "total_ordered",
  COALESCE(SUM(t."quantity_received"), 0)::INTEGER AS "total_received",
  CASE
    WHEN COALESCE(SUM(t."quantity_received"), 0) = 0 THEN 'OPEN'
    WHEN COALESCE(SUM(t."quantity_received"), 0)
         >= COALESCE(SUM(t."quantity_ordered"), 0) THEN 'RECEIVED'
    ELSE 'PARTIAL'
  END AS "status"
FROM "purchase_orders" po
LEFT JOIN "purchase_order_line_totals" t
  ON t."purchase_order_id" = po."id"
WHERE po."deleted_at" IS NULL
GROUP BY po."id";
