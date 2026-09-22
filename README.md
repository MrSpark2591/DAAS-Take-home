# DaaS — Purchase Order Receiving (Sprint 2 slice)

One feature slice end to end: Postgres schema and migration, an Apollo GraphQL API, and a
Next.js UI. You can raise a purchase order, receive stock against it line by line, and watch
on-hand quantities move — with the PO's status derived from what has actually been received,
never set by hand.

**Stack:** Node 24 · TypeScript (strict) · Postgres 17 · Prisma 6 · Apollo Server 5 ·
Next.js 16 (App Router) · MUI 9 · Redux Toolkit + RTK Query · react-hook-form + zod · Biome

---

## Quick start

Four commands from a clean checkout. Postgres comes from Docker; nothing else is assumed.

```bash
docker compose up -d
```

```bash
cd api && cp .env.example .env && npm install && npx prisma migrate deploy && npm run seed && npm run dev
```

```bash
cd web && cp .env.example .env.local && npm install && npm run dev
```

Open <http://localhost:3000>. The API is on <http://localhost:4000>.

Optional, for the repo-wide lint/format and the git hook:

```bash
npm install
```

### What the seed gives you

Four purchase orders covering every status the UI can show, plus the stock ledger and on-hand
rows implied by their receipts:

| PO | Vendor | Status | Why |
| --- | --- | --- | --- |
| PO-1001 | Crestron | `OPEN` | Nothing received |
| PO-1002 | Extron | `PARTIAL` | One line short-delivered |
| PO-1003 | Shure | `RECEIVED` | Fully satisfied |
| PO-1004 | Extron | `OPEN` | Second vendor, for the vendor filter |

It also prints three bearer tokens, one per role. The API prints them again on boot when
`DEV_AUTH_DEBUG=true`.

### Signing in

There is no login screen. The header has an **Acting as** switcher listing the three seeded
users; picking one mints that user's bearer token into the Redux store, and RTK Query sends it
on every subsequent request.

| User | Role | Can |
| --- | --- | --- |
| Ada | `ADMIN` | Everything: create POs, receive, void |
| Wes | `WAREHOUSE` | Receive stock |
| Vic | `VIEWER` | Read only |

Switch to Vic and the **Receive stock** button goes disabled with a tooltip. Force it back on
in devtools and the API still returns `FORBIDDEN` — the UI mirrors the rule, the server owns it.

### Verify

```bash
cd api && npm test
```

12 integration tests against a real Postgres. They create and migrate a separate `daas_test`
database, so they never touch your seeded dev data.

```bash
npm run verify
```

Biome (lint + format) and TypeScript across both packages.

```bash
cd api && npm run check:ledger
```

Asserts the invariant the stock design rests on — see the architecture note below.

### Demo

[`docs/demo.md`](docs/demo.md) has every GraphQL operation the UI sends, the three
responses worth seeing from the receive mutation (success, over-receipt, forbidden), and a
seven-step walkthrough.

---

## Layout

```
api/
  prisma/
    schema.prisma              # models, conventions, why two tables opt out of soft delete
    migrations/                # checked in; constraints and views live here
    seed.ts
  src/
    domains/purchasing/        # one folder per domain
      schema.graphql           #   SDL
      resolvers.ts             #   auth + shape translation only
      service.ts               #   domain rules and transaction boundaries
      loaders.ts               #   per-request DataLoaders
    shared/                    # auth, errors, prisma, id — cross-domain plumbing
    schema.ts                  # the only place domains are wired together
    index.ts
  tests/                       # integration tests against real Postgres
  scripts/check-ledger.ts
web/
  src/
    app/                       # App Router pages
    components/                # AppShell, QueryState, forms, dialogs
    lib/                       # RTK Query api, store, session, theme, operations
    generated/graphql.ts       # codegen output — types from the API's SDL
```

### How this scales to the rest of the roadmap

A domain is a folder exporting `{ typeDefs, resolvers }`. Sprint 3's drawings or sprint 4's
RMAs are a sibling folder plus one line in `src/schema.ts`; nothing else in the server changes.

The boundary that matters is `resolvers.ts` → `service.ts`. Resolvers check a role and
translate shapes. Services own the rules and the transactions, and take no GraphQL types in
their signatures — so when sprint 4 needs "closing an RMA returns stock", it calls the same
stock-movement code path rather than reimplementing it behind a second resolver.

---

## Architecture note

> **Making stock movements transactional and auditable across adjust, transfer, receive and
> allocate.**

### The design

Every change to stock is an append-only row in `stock_movements`: a signed quantity, a type
(`RECEIPT`, `ADJUSTMENT`, `TRANSFER_IN/OUT`, `ALLOCATION`), a product, a location, who did it
and when. Movements are never updated or deleted — the table has no `updated_at` and no
`deleted_at`, deliberately breaking the repo's own soft-delete convention. You reverse a
movement by appending a compensating one, so the history of a mistake is preserved rather than
edited away.

`stock_on_hand` is a projection of that ledger, one row per `(product, location)`, written in
the **same transaction** as the movement that changed it. Reads are a single indexed lookup
instead of an aggregate over the whole ledger, but the ledger stays the source of truth.

Nothing about that is receive-specific. Sprint 2's adjustments and transfers, and sprint 4's
RMA returns, are all "append a movement, move the projection" — the same two writes in the same
transaction, differing only in sign and type.

Derived state is computed in SQL views rather than stored:

- `purchase_order_line_totals` — received and outstanding per line, from the ledger.
- `purchase_order_status` — `OPEN` / `PARTIAL` / `RECEIVED` per order, from those totals.

So a PO has **no status column**. The list filter queries the view, which means filtering
stays a single indexed query rather than fetching everything and filtering in memory, and
there is no flag that can drift from the ledger.

### The main trade-off

**The projection is denormalised, and denormalised data can drift.** I accepted that cost for
O(1) on-hand reads, and paid for it three ways:

1. The projection is only ever written inside the same transaction as its movement.
2. `stock_on_hand.quantity >= 0` is a check constraint, so a bad write fails in the database
   rather than silently producing negative stock.
3. `npm run check:ledger` re-derives on-hand from the ledger and diffs it against the
   projection. It is asserted in the integration tests and is the obvious nightly job in
   production.

The alternative — deriving on-hand from `SUM(movements)` on every read — cannot drift, but
turns the most common query in the system into an aggregate over a table that only ever grows.
That trade flips at a scale this slice is not at; when it does, the fix is a materialised view
refreshed on write, and the check script becomes the thing that validates the migration.

Two smaller calls worth naming:

- **Concurrency.** The receive transaction takes `SELECT … FOR UPDATE` on the PO row before
  reading outstanding quantities. Without it, two people receiving the last item both read
  "1 outstanding" and both write. The lock is per-order, so receipts against different POs stay
  fully concurrent. There is a test for exactly this race.
- **The on-hand upsert is raw `INSERT … ON CONFLICT`,** not `prisma.upsert`. Prisma's upsert is
  a read-then-write that can still collide when two transactions create the first on-hand row
  for the same `(product, location)`; `ON CONFLICT` is one atomic statement.

### What I would ship first

The audit trail, before the projection. `stock_movements` plus the views is a complete,
correct system on its own — slower to read, impossible to corrupt. `stock_on_hand` is an
optimisation, and optimisations should land second, behind the check script that proves they
agree.

---

## Data model

```
vendors ──┐
          ├─< purchase_orders ──< purchase_order_lines ──< stock_movements >── locations
locations ┘                              │                       │
                                    products ────────────────────┴──> stock_on_hand
```

Conventions applied throughout:

- **`uuid` primary keys, generated as UUIDv7** so ids sort by creation time — inserts stay at
  the right edge of the B-tree instead of scattering the way v4 does.
- **`created_at` / `updated_at` on every mutable table**, `timestamptz`.
- **Soft delete via `deleted_at`**, with the two documented exceptions above.
- **Money as integer cents.** Never floats.

Constraints that carry real domain meaning:

| Constraint | Why |
| --- | --- |
| `quantity_ordered > 0`, `unit_cost_cents >= 0` | A zero-quantity line is not an order |
| `stock_movements.quantity <> 0` | A no-op row only pollutes the ledger |
| `type <> 'RECEIPT' OR quantity > 0` | Receipts add stock, by definition |
| `type <> 'RECEIPT' OR purchase_order_line_id IS NOT NULL` | Every receipt traces to a line, or the totals view under-counts |
| `stock_on_hand.quantity >= 0` | You cannot hold negative stock |
| `UNIQUE (product_id, location_id)` on `stock_on_hand` | Makes the increment-on-receive upsert safe |

Uniqueness is **partial** — `WHERE deleted_at IS NULL` — on vendor codes, SKUs, location codes,
PO numbers and `(purchase_order_id, product_id)`. A plain `UNIQUE` would let a soft-deleted
vendor hold its code hostage forever; "unique among rows that still exist" is what the domain
actually means.

---

## API

One guarded, transactional mutation is the centre of the slice:

```graphql
mutation Receive($input: ReceivePurchaseOrderInput!) {
  receivePurchaseOrder(input: $input) {
    purchaseOrder { poNumber status totalReceived }
    movements { id quantity createdAt }
  }
}
```

```json
{
  "input": {
    "purchaseOrderId": "…",
    "locationId": "…",
    "reason": "Delivery docket 88213",
    "lines": [{ "purchaseOrderLineId": "…", "quantity": 5 }]
  }
}
```

It requires `ADMIN` or `WAREHOUSE`, locks the PO, validates every line against its outstanding
quantity, then appends the movements and moves the projection — all in one transaction. Any
rejection rolls back the whole receipt; a half-applied delivery is the one outcome worse than a
rejected one.

Authorisation goes through a single `requireRole` gate, so there is one place to audit and one
place to change when roles become permissions. Errors carry a stable `extensions.code` the UI
branches on:

| Code | Means |
| --- | --- |
| `UNAUTHENTICATED` | No or unusable token |
| `FORBIDDEN` | Role cannot do this; `requiredRoles` says what would |
| `NOT_FOUND` | No such entity |
| `BAD_USER_INPUT` | Validation failed; `field` points at the input |
| `OVER_RECEIPT` | Receiving more than outstanding; carries ordered / received / attempted |
| `CONFLICT` | Duplicate PO number, or voiding an order with receipts |

Unexpected errors are logged server-side and returned as a generic `INTERNAL_SERVER_ERROR` with
no stack trace.

Relations resolve through per-request DataLoaders, so a list of 50 POs with vendors, locations
and line products is a fixed handful of queries rather than a few hundred.

### Auth

A bearer token carrying a user id and a role:

```
Authorization: Bearer daas_<base64url({"sub":"<uuid>","role":"WAREHOUSE"})>
```

It is unsigned — a stand-in for a real IdP, not a security boundary. That is the deliberate
scope cut; swapping it for a verified JWT means replacing `parseBearerToken` and nothing else,
because every caller already goes through `requireRole`.

---

## Frontend

- **List** (`/purchase-orders`) — status filter backed by the SQL view. The filter is part of
  the RTK Query cache key, so each tab caches independently.
- **Create** (`/purchase-orders/new`) — react-hook-form + zod, dynamic line items, duplicate
  products caught client-side with the row pointed at, cost entered in dollars and converted to
  integer cents at the edge.
- **Detail** (`/purchase-orders/[id]`) — per-line progress, full receipt history, and the
  receive dialog.
- **Stock** (`/stock`) — the read side, proving a receipt moved real stock.

Cache invalidation is tag-based. Receiving invalidates the PO it touched, the list (because
status is a filter and a receipt can change it), and `StockOnHand` — so the stock page
refreshes without knowing anything about purchase orders.

Loading, empty and error states go through one `QueryState` component, so all three are
handled identically everywhere instead of each page inventing its own spinner and forgetting
the empty case. Colours and spacing come from the MUI theme; the three PO statuses are
registered palette entries rather than one-off hex values.

`npm run codegen` regenerates `src/generated/graphql.ts` from the API's SDL, so a field renamed
on the server fails `npm run typecheck` in the UI rather than returning `undefined` at runtime.

---

## Tooling

Biome handles both linting and formatting (replacing ESLint + Prettier), with a strict ruleset:
`noExplicitAny`, `useAwait`, `noArrayIndexKey`, `useExhaustiveDependencies`, naming
conventions, the React and Next domains, and the a11y set.

Husky + lint-staged run `biome check --write` on staged files at commit.

```bash
npm run lint       # check
npm run lint:fix   # check and fix
npm run typecheck  # both packages
npm run verify     # lint + typecheck
```

---

## What I cut, and why

- **Editing and deleting POs.** The brief marks editing optional, and receiving is where the
  interesting invariants live. `voidPurchaseOrder` is there because it forced a real decision —
  it refuses once anything has been received, rather than orphaning ledger rows under a deleted
  parent.
- **Adjust, transfer and allocate.** The ledger models all four movement types and the enum
  lists them, but only `RECEIPT` has a mutation. The others are the same two writes with a
  different sign; adding them is a service function, not a schema change.
- **Pagination.** The list is a plain query. At real volume it needs keyset pagination on the
  UUIDv7 primary key — which is part of why the ids are v7.
- **Real auth.** See above.
- **`demoUsers`.** An unauthenticated query that exists only to populate the role switcher. It
  is the one thing in the schema I would delete before this shipped anywhere real, and it says
  so in the SDL.
- **Component tests.** I spent the test budget on integration tests for the transaction,
  concurrency and constraint behaviour, because that is where a bug would silently corrupt
  stock. The form logic is validated by zod schemas that are cheap to read and hard to get
  subtly wrong.
