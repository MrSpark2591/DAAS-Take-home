# CLAUDE.md

Guidance for AI agents working in this repository. Read this before changing code.

For *what* this project is and why it is designed this way, read [README.md](README.md) —
especially the architecture note. This file covers *how to work in it*.

---

## Repository shape

Two independently installed packages plus root-level tooling. There is no npm workspace; each
package has its own `node_modules`.

| Path | What it is |
| --- | --- |
| `api/` | Apollo Server 5 + Prisma 6 + Postgres. TypeScript, ESM, strict. |
| `web/` | Next.js 16 App Router + MUI 9 + RTK Query. TypeScript, strict. |
| `biome.json`, root `package.json` | Lint, format, git hooks. Run from the repo root. |
| `docker-compose.yml` | Postgres 17. Everything assumes this is running. |

Node 24 is required (`.nvmrc`, `engines`).

---

## Commands

Always run these from the directory shown.

```bash
docker compose up -d                 # root — start Postgres first, everything needs it
```

| Directory | Command | Purpose |
| --- | --- | --- |
| root | `npm run verify` | Lint + typecheck both packages. **Run before claiming done.** |
| root | `npm run lint:fix` | Biome check + autofix |
| `api/` | `npm run dev` | API on :4000, prints seeded bearer tokens |
| `api/` | `npm test` | Integration tests against real Postgres |
| `api/` | `npm run seed` | Reset and reseed dev data (truncates first) |
| `api/` | `npm run db:reset` | Drop, re-migrate, reseed |
| `api/` | `npm run check:ledger` | Assert on-hand matches the movement ledger |
| `web/` | `npm run dev` | UI on :3000 |
| `web/` | `npm run codegen` | Regenerate types from the API's SDL |

---

## Non-negotiable conventions

These are enforced by the schema, the migration, or review. Do not quietly break them.

### Database

- **UUIDv7 primary keys.** Prisma generates them via `@default(uuid(7))`. Raw SQL inserts must
  use `uuidv7()` from `api/src/shared/id.ts` — never `gen_random_uuid()`, which is v4 and
  destroys the time-ordering the ids exist for.
- **`created_at` / `updated_at` on every mutable table**, `timestamptz`.
- **Soft delete via `deleted_at`.** Read queries must filter it — spread `live` from
  `api/src/shared/prisma.ts` into the `where`. Two tables opt out on purpose and the schema
  explains why: `stock_movements` (append-only ledger) and `stock_on_hand` (derived projection).
- **Money is integer cents.** Never a float, never a decimal string. The UI converts to and
  from dollars at the form boundary only.
- **Uniqueness is partial** — `WHERE deleted_at IS NULL`. These live in the migration SQL, not
  in `schema.prisma`, because Prisma cannot express them.

### Derived state

`purchase_order_line_totals` and `purchase_order_status` are SQL views. Received quantities and
PO status are computed from the ledger, **never stored**.

If you find yourself adding a `status` column or a `quantity_received` column, stop — that is
the bug this design exists to prevent. Change the view instead.

### Stock writes

Every change to on-hand stock is two writes in **one transaction**:

1. Append a row to `stock_movements` (signed quantity, typed, attributed).
2. Move the `stock_on_hand` projection to match.

Never write `stock_on_hand` on its own. Never update or delete a movement — reverse it with a
compensating movement. `npm run check:ledger` will catch you if you do.

When adding a new movement type (adjust, transfer, allocate), extend
`api/src/domains/purchasing/service.ts` rather than writing a second path; the transaction and
locking logic is the part worth reusing.

### Authorisation

All role checks go through `requireRole` in `api/src/shared/auth.ts`, using the named role sets
(`CAN_RECEIVE_STOCK`, `CAN_MANAGE_PURCHASE_ORDERS`). Do not read `actor.role` directly in a
resolver — one gate means one place to audit.

The UI mirrors these rules via `canReceiveStock` / `canManagePurchaseOrders` in
`web/src/lib/session.ts`. **The UI copy is cosmetic.** Adding a client-side check is never a
substitute for the server-side one.

---

## Layering

```
resolvers.ts   →  role check + shape translation. Thin. No business rules.
service.ts     →  domain rules + transaction boundaries. No GraphQL types in signatures.
loaders.ts     →  per-request DataLoaders. Batching only.
```

The rule that matters: **`service.ts` must be callable from a worker, a CLI or an import job**
without going through GraphQL. If you are tempted to pass a resolver `args` object or a
GraphQL context into a service, the logic is in the wrong place.

### Adding a domain

A domain is a folder under `api/src/domains/` exporting `{ typeDefs, resolvers }` (see
`purchasing/index.ts`). Add the folder, then add one line to `api/src/schema.ts`. Nothing else
in the server changes.

---

## Frontend rules

- **MUI 9 removed system props.** `justifyContent`, `alignItems`, `display`, `fontWeight` and
  friends are **not** valid as direct props — they go in `sx`. This is the single most common
  typecheck failure in `web/`.
- **No one-off hex values.** Colours and spacing come from the theme in `web/src/lib/theme.ts`.
  PO statuses use the registered `palette.status` entries.
- **All GraphQL documents live in `web/src/lib/operations.ts`** with the `/* GraphQL */` marker
  so codegen can find and validate them. After editing a document or the API's SDL, run
  `npm run codegen` — otherwise types silently go stale.
- **Loading / empty / error states go through `QueryState`.** Do not hand-roll a spinner.
- **Cache invalidation is tag-based.** A mutation that changes data another screen shows must
  invalidate that screen's tag. Receiving invalidates the PO, the list (status is a filter), and
  `StockOnHand`.

---

## Testing

Tests are integration tests against a real Postgres, in `api/tests/`. They create and migrate a
separate `daas_test` database via `tests/global-setup.ts`; they never touch dev data.

**Write tests for behaviour that would hurt in a warehouse**, not for coverage. The existing
suite covers over-receipt rejection, all-or-nothing multi-line receipts, concurrent receipts
racing for the last item, location overrides, and ledger/projection agreement. Follow that
style: each test name describes a scenario a warehouse manager would recognise.

Do not mock Prisma. The behaviour worth testing here — transaction rollback, `FOR UPDATE`
serialisation, check constraints, SQL views — lives in the database. A mock would assert that
we called the functions we wrote, not that receiving is correct.

Gotcha: Vitest loads `api/.env` into `process.env`, which is why the test database URL lives in
`api/tests/database-url.ts` and is imported by both the Vitest config and the global setup.
Do not read `process.env.DATABASE_URL` in test setup code — you will get the dev database.

---

## Style

Biome handles lint and format; there is no ESLint or Prettier. Run `npm run lint:fix` from the
root rather than hand-formatting. Husky + lint-staged enforce this at commit time.

Notable enabled rules: `noExplicitAny`, `useAwait`, `noArrayIndexKey`,
`useExhaustiveDependencies`, `useImportType`, plus the React, Next and a11y rule sets.

Comments should explain **why**, not what. The existing code comments the non-obvious calls —
why the row lock is there, why the upsert is raw SQL, why two tables skip soft delete. Match
that density; do not narrate obvious code.
