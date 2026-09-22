import { PrismaClient } from '@prisma/client';
import { mintToken } from '../src/shared/auth.js';

/**
 * Seeds a reviewable dataset: three users (one per role), a handful of
 * vendors/products/locations, and four purchase orders that between them cover
 * every status the UI can show -- OPEN, PARTIAL and RECEIVED -- plus the stock
 * ledger and on-hand rows those receipts imply.
 *
 * Idempotent: it truncates the slice's tables first, so `npm run seed` twice
 * gives the same result.
 */

const prisma = new PrismaClient();

async function main() {
  // Order matters for FKs; CASCADE handles the rest.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "stock_movements", "stock_on_hand", "purchase_order_lines",
      "purchase_orders", "products", "locations", "vendors", "users"
    RESTART IDENTITY CASCADE
  `);

  const [admin, warehouse, viewer] = await Promise.all([
    prisma.user.create({
      data: { email: 'ada@daas.test', name: 'Ada (Admin)', role: 'ADMIN' },
    }),
    prisma.user.create({
      data: { email: 'wes@daas.test', name: 'Wes (Warehouse)', role: 'WAREHOUSE' },
    }),
    prisma.user.create({
      data: { email: 'vic@daas.test', name: 'Vic (Viewer)', role: 'VIEWER' },
    }),
  ]);

  const vendors = await Promise.all(
    [
      { code: 'CRESTRON', name: 'Crestron Electronics', email: 'orders@crestron.test' },
      { code: 'EXTRON', name: 'Extron AV', email: 'sales@extron.test' },
      { code: 'SHURE', name: 'Shure Audio', email: 'supply@shure.test' },
    ].map((data) => prisma.vendor.create({ data })),
  );

  const locations = await Promise.all(
    [
      { code: 'WH-MAIN', name: 'Main Warehouse' },
      { code: 'WH-OVER', name: 'Overflow Bay' },
      { code: 'VAN-01', name: 'Install Van 01' },
    ].map((data) => prisma.location.create({ data })),
  );

  const products = await Promise.all(
    [
      { sku: 'DM-NVX-360', name: 'DM NVX 4K60 Encoder/Decoder', unit: 'ea' },
      { sku: 'TSW-1070', name: '10.1" Touch Screen, Black', unit: 'ea' },
      { sku: 'SR-HD-101', name: 'HDMI Scaling Receiver', unit: 'ea' },
      { sku: 'MXA910', name: 'Ceiling Array Microphone', unit: 'ea' },
      { sku: 'CBL-CAT6-305', name: 'Cat6 Cable, 305m Box', unit: 'box' },
    ].map((data) => prisma.product.create({ data })),
  );

  const vendor = (code: string) => vendors.find((v) => v.code === code)!;
  const location = (code: string) => locations.find((l) => l.code === code)!;
  const product = (sku: string) => products.find((p) => p.sku === sku)!;

  // PO-1001 -- nothing received yet (OPEN)
  await prisma.purchaseOrder.create({
    data: {
      poNumber: 'PO-1001',
      vendorId: vendor('CRESTRON').id,
      locationId: location('WH-MAIN').id,
      notes: 'Riverside Tower - level 3 boardrooms.',
      createdById: admin.id,
      lines: {
        create: [
          { productId: product('DM-NVX-360').id, quantityOrdered: 12, unitCostCents: 189_900 },
          { productId: product('TSW-1070').id, quantityOrdered: 4, unitCostCents: 124_500 },
        ],
      },
    },
  });

  // PO-1002 -- one line part-received (PARTIAL)
  const partial = await prisma.purchaseOrder.create({
    data: {
      poNumber: 'PO-1002',
      vendorId: vendor('EXTRON').id,
      locationId: location('WH-MAIN').id,
      notes: 'Stock replenishment.',
      createdById: admin.id,
      lines: {
        create: [
          { productId: product('SR-HD-101').id, quantityOrdered: 20, unitCostCents: 45_000 },
          { productId: product('CBL-CAT6-305').id, quantityOrdered: 10, unitCostCents: 21_000 },
        ],
      },
    },
    include: { lines: true },
  });

  // PO-1003 -- fully received (RECEIVED)
  const received = await prisma.purchaseOrder.create({
    data: {
      poNumber: 'PO-1003',
      vendorId: vendor('SHURE').id,
      locationId: location('WH-MAIN').id,
      createdById: admin.id,
      lines: {
        create: [{ productId: product('MXA910').id, quantityOrdered: 6, unitCostCents: 312_000 }],
      },
    },
    include: { lines: true },
  });

  // PO-1004 -- second vendor, untouched, so the vendor filter has something to do
  await prisma.purchaseOrder.create({
    data: {
      poNumber: 'PO-1004',
      vendorId: vendor('EXTRON').id,
      locationId: location('WH-OVER').id,
      notes: 'Overflow bay delivery.',
      createdById: admin.id,
      lines: {
        create: [{ productId: product('TSW-1070').id, quantityOrdered: 8, unitCostCents: 124_500 }],
      },
    },
  });

  // Receipts are written the same way the API writes them: a ledger row plus a
  // matching on-hand increment. Seeding on-hand directly would produce data the
  // application itself could never create.
  const receipts = [
    { line: partial.lines.find((l) => l.productId === product('SR-HD-101').id)!, qty: 8 },
    { line: partial.lines.find((l) => l.productId === product('CBL-CAT6-305').id)!, qty: 10 },
    { line: received.lines[0]!, qty: 6 },
  ];

  for (const { line, qty } of receipts) {
    const locationId =
      line.purchaseOrderId === partial.id ? partial.locationId : received.locationId;

    await prisma.$transaction([
      prisma.stockMovement.create({
        data: {
          productId: line.productId,
          locationId,
          quantity: qty,
          type: 'RECEIPT',
          purchaseOrderLineId: line.id,
          reason: 'Seeded goods-in',
          createdById: warehouse.id,
        },
      }),
      prisma.stockOnHand.upsert({
        where: { productId_locationId: { productId: line.productId, locationId } },
        create: { productId: line.productId, locationId, quantity: qty },
        update: { quantity: { increment: qty } },
      }),
    ]);
  }

  console.log('Seeded 3 users, 3 vendors, 5 products, 3 locations, 4 purchase orders.\n');
  console.log('Bearer tokens for the UI role switcher and for GraphQL clients:\n');
  for (const user of [admin, warehouse, viewer]) {
    console.log(`  ${user.role.padEnd(9)} ${mintToken(user)}`);
  }
  console.log();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
