import { PrismaClient } from '@prisma/client';

/**
 * Asserts the invariant the whole stock design rests on:
 *
 *   SUM(stock_movements.quantity) GROUP BY (product, location)  ==  stock_on_hand.quantity
 *
 * `stock_on_hand` is a projection kept in step with the ledger inside each
 * write transaction. If the two ever disagree, a write escaped its transaction
 * or someone updated on-hand directly, and every number in the UI is suspect.
 *
 * Cheap enough to run in CI after the integration tests, and the obvious thing
 * to schedule nightly once this is in production.
 */

const prisma = new PrismaClient();

interface Drift {
  sku: string;
  location: string;
  ledger: number;
  projection: number;
}

async function main() {
  const drift = await prisma.$queryRaw<Drift[]>`
    SELECT p."sku"      AS "sku",
           l."code"     AS "location",
           COALESCE(m."ledger", 0)::INTEGER AS "ledger",
           COALESCE(s."quantity", 0)::INTEGER AS "projection"
    FROM (
      SELECT "product_id", "location_id", SUM("quantity") AS "ledger"
      FROM "stock_movements"
      GROUP BY "product_id", "location_id"
    ) m
    FULL OUTER JOIN "stock_on_hand" s
      ON s."product_id" = m."product_id" AND s."location_id" = m."location_id"
    JOIN "products"  p ON p."id" = COALESCE(m."product_id",  s."product_id")
    JOIN "locations" l ON l."id" = COALESCE(m."location_id", s."location_id")
    WHERE COALESCE(m."ledger", 0) <> COALESCE(s."quantity", 0)
  `;

  if (drift.length === 0) {
    console.log('Ledger and on-hand projection agree on every product/location pair.');
    return;
  }

  console.error(`Ledger drift on ${drift.length} product/location pair(s):\n`);
  for (const row of drift) {
    console.error(
      `  ${row.sku.padEnd(16)} ${row.location.padEnd(10)} ` +
        `ledger=${row.ledger} projection=${row.projection} (diff ${row.projection - row.ledger})`,
    );
  }
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
