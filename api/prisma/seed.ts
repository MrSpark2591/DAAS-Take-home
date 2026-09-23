import { PrismaClient } from '@prisma/client';
import { FEATURES } from '../src/shared/features.js';
import { hashPassword } from '../src/shared/password.js';
import { SYSTEM_ROLES } from '../src/shared/permissions.js';

/**
 * Seeds two tenants, so tenant isolation and feature switches are visible
 * rather than theoretical:
 *
 *   riverside  — the original data, stock visibility ON
 *   northgate  — its own vendors, products and POs, stock visibility OFF
 *
 * Signing in as each shows a different dataset and a different navigation, from
 * the same code and the same database.
 *
 * Uses the unscoped client on purpose: seeding is one of the two jobs that
 * legitimately crosses tenants, and it sets `tenantId` explicitly so the rows it
 * writes are unambiguous.
 */

const prisma = new PrismaClient();

const PASSWORD = process.env.SEED_PASSWORD ?? 'daas-dev-password';

interface TenantPlan {
  slug: string;
  name: string;
  stockVisible: boolean;
  users: { email: string; name: string; role: string }[];
  vendors: { code: string; name: string; email: string }[];
  products: { sku: string; name: string; unit?: string }[];
  locations: { code: string; name: string }[];
}

const PLANS: TenantPlan[] = [
  {
    slug: 'riverside',
    name: 'Riverside AV',
    stockVisible: true,
    users: [
      { email: 'ada@daas.test', name: 'Ada Admin', role: 'admin' },
      { email: 'wes@daas.test', name: 'Wes Warehouse', role: 'warehouse' },
      { email: 'vic@daas.test', name: 'Vic Viewer', role: 'viewer' },
    ],
    vendors: [
      { code: 'CRESTRON', name: 'Crestron Electronics', email: 'orders@crestron.test' },
      { code: 'EXTRON', name: 'Extron AV', email: 'sales@extron.test' },
      { code: 'SHURE', name: 'Shure Audio', email: 'supply@shure.test' },
    ],
    products: [
      { sku: 'DM-NVX-360', name: 'DM NVX 4K60 Encoder/Decoder' },
      { sku: 'TSW-1070', name: '10.1" Touch Screen, Black' },
      { sku: 'SR-HD-101', name: 'HDMI Scaling Receiver' },
      { sku: 'MXA910', name: 'Ceiling Array Microphone' },
      { sku: 'CBL-CAT6-305', name: 'Cat6 Cable, 305m Box', unit: 'box' },
    ],
    locations: [
      { code: 'WH-MAIN', name: 'Main Warehouse' },
      { code: 'WH-OVER', name: 'Overflow Bay' },
      { code: 'VAN-01', name: 'Install Van 01' },
    ],
  },
  {
    slug: 'northgate',
    name: 'Northgate Integration',
    // Switched off deliberately: this is the tenant that proves a feature flag
    // changes what the product is, not just what the nav bar says.
    stockVisible: false,
    users: [{ email: 'nina@northgate.test', name: 'Nina Northgate', role: 'admin' }],
    // Same vendor codes and SKUs as Riverside on purpose: uniqueness is
    // per-tenant, and this is what would fail if it were global.
    vendors: [{ code: 'CRESTRON', name: 'Crestron Electronics', email: 'orders@crestron.test' }],
    products: [{ sku: 'DM-NVX-360', name: 'DM NVX 4K60 Encoder/Decoder' }],
    locations: [{ code: 'WH-MAIN', name: 'Northgate Store' }],
  },
];

async function main() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "tenant_features", "user_roles", "refresh_tokens", "stock_movements",
      "stock_on_hand", "purchase_order_lines", "purchase_orders", "role_permissions",
      "roles", "products", "locations", "vendors", "users", "tenants"
    RESTART IDENTITY CASCADE
  `);

  const passwordHash = await hashPassword(PASSWORD);
  // Permissions are global reference data created by the migration.
  const permissions = await prisma.permission.findMany();
  const permissionId = (key: string) => {
    const row = permissions.find((p) => p.key === key);
    if (!row) throw new Error(`Permission "${key}" is missing. Run the migrations first.`);
    return row.id;
  };

  for (const plan of PLANS) {
    await seedTenant(plan, passwordHash, permissionId);
  }

  console.log('Seeded 2 tenants.\n');
  for (const plan of PLANS) {
    const stock = plan.stockVisible ? 'stock visible' : 'stock HIDDEN (feature off)';
    console.log(`  ${plan.name} — ${stock}`);
    for (const person of plan.users) console.log(`    ${person.email.padEnd(24)} ${person.role}`);
  }
  console.log(`\n  password for all: ${PASSWORD}\n`);
}

/** Builds one tenant: its feature switches, roles, users and reference data. */
async function seedTenant(
  plan: TenantPlan,
  passwordHash: string,
  permissionId: (key: string) => string,
): Promise<void> {
  {
    const tenant = await prisma.tenant.create({
      data: { slug: plan.slug, name: plan.name },
    });

    if (plan.stockVisible) {
      await prisma.tenantFeature.create({
        data: { tenantId: tenant.id, featureKey: FEATURES.STOCK_VIEW, enabled: true },
      });
    }

    // Each tenant gets its own copy of the system roles, so editing one
    // tenant's roles cannot change anyone else's access.
    const roles = new Map<string, string>();
    for (const definition of SYSTEM_ROLES) {
      const role = await prisma.role.create({
        data: {
          tenantId: tenant.id,
          key: definition.key,
          name: definition.name,
          description: definition.description,
          isSystem: true,
          permissions: {
            create: definition.permissions.map((key) => ({ permissionId: permissionId(key) })),
          },
        },
      });
      roles.set(definition.key, role.id);
    }

    const users = new Map<string, string>();
    for (const person of plan.users) {
      const user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: person.email,
          name: person.name,
          passwordHash,
          roles: { create: { roleId: roles.get(person.role)! } },
        },
      });
      users.set(person.role, user.id);
    }

    const vendors = new Map<string, string>();
    for (const vendor of plan.vendors) {
      const row = await prisma.vendor.create({ data: { tenantId: tenant.id, ...vendor } });
      vendors.set(vendor.code, row.id);
    }

    const products = new Map<string, string>();
    for (const product of plan.products) {
      const row = await prisma.product.create({
        data: { tenantId: tenant.id, unit: 'ea', ...product },
      });
      products.set(product.sku, row.id);
    }

    const locations = new Map<string, string>();
    for (const location of plan.locations) {
      const row = await prisma.location.create({ data: { tenantId: tenant.id, ...location } });
      locations.set(location.code, row.id);
    }

    const adminId = users.get('admin')!;
    const warehouseId = users.get('warehouse') ?? adminId;

    if (plan.slug === 'riverside') {
      await seedRiversidePurchaseOrders(
        tenant.id,
        adminId,
        warehouseId,
        vendors,
        products,
        locations,
      );
    } else {
      await prisma.purchaseOrder.create({
        data: {
          tenantId: tenant.id,
          // Same PO number as Riverside, which is the point: per-tenant unique.
          poNumber: 'PO-1001',
          vendorId: vendors.get('CRESTRON')!,
          locationId: locations.get('WH-MAIN')!,
          notes: 'Northgate fitout.',
          createdById: adminId,
          lines: {
            create: [
              {
                productId: products.get('DM-NVX-360')!,
                quantityOrdered: 5,
                unitCostCents: 189_900,
              },
            ],
          },
        },
      });
    }
  }
}

/** The original four orders, including the receipts that give them their status. */
async function seedRiversidePurchaseOrders(
  tenantId: string,
  adminId: string,
  warehouseId: string,
  vendors: Map<string, string>,
  products: Map<string, string>,
  locations: Map<string, string>,
) {
  const main = locations.get('WH-MAIN')!;

  await prisma.purchaseOrder.create({
    data: {
      tenantId,
      poNumber: 'PO-1001',
      vendorId: vendors.get('CRESTRON')!,
      locationId: main,
      notes: 'Riverside Tower - level 3 boardrooms.',
      createdById: adminId,
      lines: {
        create: [
          { productId: products.get('DM-NVX-360')!, quantityOrdered: 12, unitCostCents: 189_900 },
          { productId: products.get('TSW-1070')!, quantityOrdered: 4, unitCostCents: 124_500 },
        ],
      },
    },
  });

  const partial = await prisma.purchaseOrder.create({
    data: {
      tenantId,
      poNumber: 'PO-1002',
      vendorId: vendors.get('EXTRON')!,
      locationId: main,
      notes: 'Stock replenishment.',
      createdById: adminId,
      lines: {
        create: [
          { productId: products.get('SR-HD-101')!, quantityOrdered: 20, unitCostCents: 45_000 },
          { productId: products.get('CBL-CAT6-305')!, quantityOrdered: 10, unitCostCents: 21_000 },
        ],
      },
    },
    include: { lines: true },
  });

  const received = await prisma.purchaseOrder.create({
    data: {
      tenantId,
      poNumber: 'PO-1003',
      vendorId: vendors.get('SHURE')!,
      locationId: main,
      createdById: adminId,
      lines: {
        create: [
          { productId: products.get('MXA910')!, quantityOrdered: 6, unitCostCents: 312_000 },
        ],
      },
    },
    include: { lines: true },
  });

  await prisma.purchaseOrder.create({
    data: {
      tenantId,
      poNumber: 'PO-1004',
      vendorId: vendors.get('EXTRON')!,
      locationId: locations.get('WH-OVER')!,
      notes: 'Overflow bay delivery.',
      createdById: adminId,
      lines: {
        create: [
          { productId: products.get('TSW-1070')!, quantityOrdered: 8, unitCostCents: 124_500 },
        ],
      },
    },
  });

  // Receipts are written the way the API writes them: a ledger row plus a
  // matching on-hand increment. Seeding on-hand directly would produce data the
  // application itself could never create.
  const receipts = [
    { line: partial.lines.find((l) => l.productId === products.get('SR-HD-101'))!, qty: 8 },
    { line: partial.lines.find((l) => l.productId === products.get('CBL-CAT6-305'))!, qty: 10 },
    { line: received.lines[0]!, qty: 6 },
  ];

  for (const { line, qty } of receipts) {
    await prisma.$transaction([
      prisma.stockMovement.create({
        data: {
          tenantId,
          productId: line.productId,
          locationId: main,
          quantity: qty,
          type: 'RECEIPT',
          purchaseOrderLineId: line.id,
          reason: 'Seeded goods-in',
          createdById: warehouseId,
        },
      }),
      prisma.stockOnHand.upsert({
        where: { productId_locationId: { productId: line.productId, locationId: main } },
        create: { tenantId, productId: line.productId, locationId: main, quantity: qty },
        update: { quantity: { increment: qty } },
      }),
    ]);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
