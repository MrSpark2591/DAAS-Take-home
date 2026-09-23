-- Multi-tenancy: every row of business data belongs to exactly one tenant.
--
-- Isolation model: shared database, shared schema, `tenant_id` column. The
-- alternatives are a schema or a database per tenant, which give harder
-- isolation at the cost of migrations that must be applied N times and
-- connection pools that fragment. For an internal tool with a handful of
-- tenants, row-level scoping enforced centrally is the right trade -- and the
-- trade is named in the README rather than left implicit.
--
-- Existing data is not discarded: it moves into a default tenant, so this
-- migration is safe to apply to a populated database.

-- ---------------------------------------------------------------------------
-- Tenants and their feature switches
-- ---------------------------------------------------------------------------
CREATE TABLE "tenants" (
  "id"         UUID           NOT NULL,
  "slug"       VARCHAR(64)    NOT NULL,
  "name"       VARCHAR(160)   NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_slug_live_key" ON "tenants" ("slug") WHERE "deleted_at" IS NULL;

CREATE TABLE "tenant_features" (
  "tenant_id"   UUID           NOT NULL,
  "feature_key" VARCHAR(64)    NOT NULL,
  "enabled"     BOOLEAN        NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("tenant_id", "feature_key")
);

ALTER TABLE "tenant_features"
  ADD CONSTRAINT "tenant_features_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The default tenant that existing data moves into.
--
-- A fixed id so the seed and any follow-up migration can refer to it without
-- a lookup.
-- ---------------------------------------------------------------------------
INSERT INTO "tenants" ("id", "slug", "name", "updated_at")
VALUES ('01a00000-0000-7000-8000-000000000001', 'default', 'Default Tenant', CURRENT_TIMESTAMP);

-- Stock visibility on for the existing tenant: they could already see it, and a
-- migration must not silently take a feature away from someone using it.
INSERT INTO "tenant_features" ("tenant_id", "feature_key", "enabled", "updated_at")
VALUES ('01a00000-0000-7000-8000-000000000001', 'stock.view', true, CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- Add tenant_id everywhere, in three steps per table: nullable, backfill,
-- NOT NULL. A NOT NULL column cannot simply appear on a populated table.
-- ---------------------------------------------------------------------------
ALTER TABLE "users"            ADD COLUMN "tenant_id" UUID;
ALTER TABLE "roles"            ADD COLUMN "tenant_id" UUID;
ALTER TABLE "vendors"          ADD COLUMN "tenant_id" UUID;
ALTER TABLE "products"         ADD COLUMN "tenant_id" UUID;
ALTER TABLE "locations"        ADD COLUMN "tenant_id" UUID;
ALTER TABLE "purchase_orders"  ADD COLUMN "tenant_id" UUID;
ALTER TABLE "stock_movements"  ADD COLUMN "tenant_id" UUID;
ALTER TABLE "stock_on_hand"    ADD COLUMN "tenant_id" UUID;

UPDATE "users"           SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "roles"           SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "vendors"         SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "products"        SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "locations"       SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "purchase_orders" SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "stock_movements" SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "stock_on_hand"   SET "tenant_id" = '01a00000-0000-7000-8000-000000000001' WHERE "tenant_id" IS NULL;

ALTER TABLE "users"            ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "roles"            ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "vendors"          ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "products"         ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "locations"        ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "purchase_orders"  ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "stock_movements"  ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "stock_on_hand"    ALTER COLUMN "tenant_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Foreign keys. CASCADE, because deleting a tenant must take its data with it;
-- leaving orphaned rows behind is how a "deleted" customer's data survives.
-- ---------------------------------------------------------------------------
ALTER TABLE "users"           ADD CONSTRAINT "users_tenant_id_fkey"           FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roles"           ADD CONSTRAINT "roles_tenant_id_fkey"           FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendors"         ADD CONSTRAINT "vendors_tenant_id_fkey"         FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products"        ADD CONSTRAINT "products_tenant_id_fkey"        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "locations"       ADD CONSTRAINT "locations_tenant_id_fkey"       FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_on_hand"   ADD CONSTRAINT "stock_on_hand_tenant_id_fkey"   FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Uniqueness becomes per-tenant.
--
-- This is the part that is easy to miss and expensive to get wrong: two tenants
-- must both be able to have a vendor called ACME, a SKU called WIDGET-1, and a
-- PO-1001. Global uniqueness would make onboarding a second customer fail with
-- a constraint violation on their first import.
-- ---------------------------------------------------------------------------
DROP INDEX "users_email_live_key";
DROP INDEX "vendors_code_live_key";
DROP INDEX "products_sku_live_key";
DROP INDEX "locations_code_live_key";
DROP INDEX "purchase_orders_po_number_live_key";
DROP INDEX "roles_key_live_key";

-- Email stays globally unique: it is the login identifier, and sign-in happens
-- before a tenant is known. Letting the same address exist in two tenants would
-- make "which account did I just authenticate?" ambiguous.
CREATE UNIQUE INDEX "users_email_live_key" ON "users" ("email") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "vendors_tenant_code_live_key"          ON "vendors" ("tenant_id", "code") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "products_tenant_sku_live_key"          ON "products" ("tenant_id", "sku") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "locations_tenant_code_live_key"        ON "locations" ("tenant_id", "code") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "purchase_orders_tenant_number_live_key" ON "purchase_orders" ("tenant_id", "po_number") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "roles_tenant_key_live_key"             ON "roles" ("tenant_id", "key") WHERE "deleted_at" IS NULL;

-- stock_on_hand is one row per (product, location); both are already
-- tenant-scoped, so the existing unique index stays correct.

-- ---------------------------------------------------------------------------
-- Indexes for the queries, now that every one of them filters by tenant.
--
-- Tenant leads each composite: it is the most selective predicate on every
-- query, and it is present on all of them.
-- ---------------------------------------------------------------------------
CREATE INDEX "users_tenant_id_idx"           ON "users" ("tenant_id");
CREATE INDEX "roles_tenant_id_idx"           ON "roles" ("tenant_id");
CREATE INDEX "vendors_tenant_id_idx"         ON "vendors" ("tenant_id");
CREATE INDEX "products_tenant_id_idx"        ON "products" ("tenant_id");
CREATE INDEX "locations_tenant_id_idx"       ON "locations" ("tenant_id");
CREATE INDEX "stock_movements_tenant_id_idx" ON "stock_movements" ("tenant_id");
CREATE INDEX "stock_on_hand_tenant_id_idx"   ON "stock_on_hand" ("tenant_id");

-- The purchase order list filters by tenant and pages on id, so the keyset
-- composites from the previous migration are rebuilt with tenant leading.
DROP INDEX "purchase_orders_live_keyset_idx";
DROP INDEX "purchase_orders_vendor_keyset_idx";
DROP INDEX "purchase_orders_location_keyset_idx";

CREATE INDEX "purchase_orders_tenant_keyset_idx"
  ON "purchase_orders" ("tenant_id", "id" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "purchase_orders_tenant_vendor_keyset_idx"
  ON "purchase_orders" ("tenant_id", "vendor_id", "id" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "purchase_orders_tenant_location_keyset_idx"
  ON "purchase_orders" ("tenant_id", "location_id", "id" DESC) WHERE "deleted_at" IS NULL;
