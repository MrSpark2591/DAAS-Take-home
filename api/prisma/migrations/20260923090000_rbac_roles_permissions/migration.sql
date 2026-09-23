-- Decouple access rights from roles.
--
-- Before: `users.role` was an enum, and the code branched on it directly.
-- After:  permissions are the unit of authorisation, roles are named bundles of
--         them, and a user may hold several roles. Nothing in the application
--         branches on a role key any more.
--
-- Existing users keep exactly the access they had: the backfill below maps each
-- old enum value onto the matching system role.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE "permissions" (
  "id"          UUID           NOT NULL,
  "key"         VARCHAR(64)    NOT NULL,
  "description" VARCHAR(200)   NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "roles" (
  "id"          UUID           NOT NULL,
  "key"         VARCHAR(32)    NOT NULL,
  "name"        VARCHAR(80)    NOT NULL,
  "description" VARCHAR(300),
  "is_system"   BOOLEAN        NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"  TIMESTAMPTZ(6),
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
  "role_id"       UUID           NOT NULL,
  "permission_id" UUID           NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id")
);

CREATE TABLE "user_roles" (
  "user_id"          UUID           NOT NULL,
  "role_id"          UUID           NOT NULL,
  "assigned_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assigned_by_id"   UUID,
  CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role_id")
);

-- ---------------------------------------------------------------------------
-- Keys and indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions" ("key");

-- Role keys are unique among live rows only, so a deleted role does not hold
-- its key hostage. Same reasoning as vendors and SKUs elsewhere in the schema.
CREATE UNIQUE INDEX "roles_key_live_key" ON "roles" ("key") WHERE "deleted_at" IS NULL;

ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_permission_id_fkey"
  FOREIGN KEY ("permission_id") REFERENCES "permissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: deleting a role that people still hold should fail
-- loudly rather than silently stripping their access.
ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions" ("permission_id");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles" ("role_id");

-- ---------------------------------------------------------------------------
-- Seed the catalogue.
--
-- Mirrors src/shared/permissions.ts. The application can only check permissions
-- it knows at compile time, so that file is the source of truth and this is the
-- migration that makes the rows exist.
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid(), 'purchase_order:read',   'View purchase orders and their lines'),
  (gen_random_uuid(), 'purchase_order:create', 'Raise new purchase orders'),
  (gen_random_uuid(), 'purchase_order:void',   'Void a purchase order that has no receipts'),
  (gen_random_uuid(), 'stock:read',            'View on-hand stock and the movement ledger'),
  (gen_random_uuid(), 'stock:receive',         'Receive stock against a purchase order'),
  (gen_random_uuid(), 'stock:adjust',          'Adjust or transfer stock outside of receiving'),
  (gen_random_uuid(), 'user:read',             'View users and their roles'),
  (gen_random_uuid(), 'role:manage',           'Create roles and change what they grant');

INSERT INTO "roles" ("id", "key", "name", "description", "is_system", "updated_at") VALUES
  (gen_random_uuid(), 'admin',     'Administrator', 'Full access, including raising and voiding purchase orders.', true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'warehouse', 'Warehouse',     'Receives deliveries and moves stock. Cannot raise purchase orders.', true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'viewer',    'Viewer',        'Read-only access to purchase orders and stock.', true, CURRENT_TIMESTAMP);

-- admin: everything
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE r."key" = 'admin';

-- warehouse: read purchase orders, and move stock
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r JOIN "permissions" p ON p."key" IN (
  'purchase_order:read', 'stock:read', 'stock:receive', 'stock:adjust'
)
WHERE r."key" = 'warehouse';

-- viewer: read only
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r JOIN "permissions" p ON p."key" IN ('purchase_order:read', 'stock:read')
WHERE r."key" = 'viewer';

-- ---------------------------------------------------------------------------
-- Backfill, then drop the old column.
--
-- Order matters: the assignment has to happen while `users.role` still exists.
-- ---------------------------------------------------------------------------
INSERT INTO "user_roles" ("user_id", "role_id")
SELECT u."id", r."id"
FROM "users" u
JOIN "roles" r ON r."key" = LOWER(u."role"::TEXT);

ALTER TABLE "users" DROP COLUMN "role";

DROP TYPE "role";
