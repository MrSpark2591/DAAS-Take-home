# DaaS — Purchase Order Receiving (Sprint 2 slice)

One feature slice end to end: Postgres schema and migration, an Apollo GraphQL API, and a
Next.js UI. You can raise a purchase order, receive stock against it line by line, and watch
on-hand quantities move — with the PO's status derived from what has actually been received,
never set by hand.

**Stack:** Node 24 · TypeScript (strict) · Postgres 17 · Prisma 6 · Apollo Server 5 ·
Next.js 16 (App Router) · MUI 9 · Redux Toolkit + RTK Query · react-hook-form + zod · Biome

---

## Quick start

Three commands from a clean checkout. Postgres comes from Docker; nothing else is assumed.

```bash
cp api/.env.example api/.env && cp web/.env.example web/.env.local
```

```bash
npm install && npm run setup
```

`setup` installs both packages, generates the Prisma client, starts Postgres and waits for it
to pass its healthcheck, applies the migration, and seeds.

```bash
npm run dev
```

That runs the API and the web app **together**, with prefixed, colour-coded output:

```
[api] DaaS API ready at http://localhost:4000/
[web] ▲ Next.js 16.3.5   - Local: http://localhost:3000
```

Open <http://localhost:3000>. Ctrl-C stops both; if either process dies, the other is shut down
with it rather than left orphaned holding a port.

### Running them separately

Sometimes you want one service's logs on their own — restarting the API without bouncing the
Next dev server, or attaching a debugger:

```bash
npm run dev:api    # or: cd api && npm run dev
```

```bash
npm run dev:web    # or: cd web && npm run dev
```

Both read the same `.env` files, so they behave identically either way. `npm run db:up` and
`npm run db:down` control Postgres on its own.

### What the seed gives you

Four purchase orders covering every status the UI can show, plus the stock ledger and on-hand
rows implied by their receipts:

| PO | Vendor | Status | Why |
| --- | --- | --- | --- |
| PO-1001 | Crestron | `OPEN` | Nothing received |
| PO-1002 | Extron | `PARTIAL` | One line short-delivered |
| PO-1003 | Shure | `RECEIVED` | Fully satisfied |
| PO-1004 | Extron | `OPEN` | Second vendor, for the vendor filter |

It also creates three sign-ins, one per role, and prints them. The API prints them again on
boot when `DEV_AUTH_DEBUG=true`.

### Signing in

Real authentication: password sign-in, a signed JWT access token, and a rotating
refresh token. Sign in at <http://localhost:3000/login> with any seeded account — the
password is the same for all three and is printed by `npm run seed`.

| User | Role | Can |
| --- | --- | --- |
| `ada@daas.test` | `ADMIN` | Everything: create POs, receive, void |
| `wes@daas.test` | `WAREHOUSE` | Receive stock |
| `vic@daas.test` | `VIEWER` | Read only |

Sign in as Vic and the **Receive stock** button is disabled. Force it back on in devtools
and the API still returns `FORBIDDEN` — the UI mirrors the rule, the server owns it.

### Verify

```bash
cd api && npm test
```

26 integration tests against a real Postgres — receiving, and the session lifecycle. They
create and migrate a separate `daas_test` database, so they never touch your seeded dev data.

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
    domains/auth/              # identity: sign-in, rotation, cookies
      service.ts               #   rotation and reuse detection
      cookies.ts               #   httpOnly cookie shaping
    shared/                    # auth, tokens, password, errors, prisma, id, env
    schema.ts                  # the only place domains are wired together
    index.ts
  tests/                       # integration tests against real Postgres
  scripts/check-ledger.ts
web/
  src/
    app/
      login/                   # sign-in page, outside the guard
      (app)/                   # everything behind a session
      api/graphql/route.ts     # same-origin proxy that carries the cookies
    components/                # AppShell, AuthGuard, QueryState, forms, dialogs
    lib/                       # RTK Query api (+ silent refresh), store, session, theme
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

Two token types, deliberately different, both delivered as httpOnly cookies:

| | Access | Refresh |
| --- | --- | --- |
| Format | JWT, HS256 | Opaque, 256 random bits |
| Lifetime | 15 min | 30 days |
| Server state | none — signature only | SHA-256 **hash** in `refresh_tokens` |
| Revocable | no | yes |

The access token is stateless so the hot path costs no database round trip; that is
exactly why it is short-lived, because a stateless token cannot be revoked. The refresh
token is deliberately **not** a JWT: it has to be revocable, which makes it stateful
regardless, so signing it would buy nothing. Only its hash is stored, for the same reason
passwords are hashed — a dump of that table must not yield usable sessions.

**Rotation with reuse detection.** Every refresh issues a new pair and retires the old
one. Presenting an already-retired token means it leaked — the legitimate client holds
the replacement — so the whole token *family* from that sign-in is revoked and both
parties must sign in again. That detection is the entire reason rotation is worth doing;
without it a stolen token simply works until it expires.

Three details that are easy to get wrong, and are handled:

- **The claim is a conditional `UPDATE`**, not read-then-write. Only one caller can find
  `rotated_at IS NULL`, so concurrent refreshes cannot both succeed.
- **Revocation happens outside any transaction that then throws.** Revoking the family
  inside a transaction that rejects the caller would roll the revocation back — the
  detection would fire and leave the stolen session working.
- **The client single-flights refreshes behind a mutex.** Several queries expiring at
  once would otherwise each fire a refresh, and the later ones would look exactly like
  theft — the app would log the user out by itself.

**Passwords** use scrypt from `node:crypto` (memory-hard, on OWASP's accepted list, no
native build step). Parameters are stored with each hash so they can be raised later
without invalidating existing passwords. Sign-in always runs a verification even for an
unknown email, and returns an identical message for a wrong password and an unknown
account, so the form is not an account-enumeration oracle.

**Cookies never reach JavaScript.** The browser talks to a same-origin Next route handler
at `/api/graphql`, which forwards to the API and relays `Set-Cookie` back. That keeps the
cookies first-party — no CORS credential negotiation, `SameSite=Lax`, `Secure` in
production — and means `document.cookie` is empty even to an XSS payload.

**The accepted limitation:** an access token stays valid until it expires. Deactivating a
user or changing a role takes effect within 15 minutes, not instantly. The fix, if that
window mattered, is a `token_version` column checked per request, trading a little
statelessness for immediate revocation.

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
- **Password reset, sign-up, MFA.** The session lifecycle is real — sign-in, rotation, reuse
  detection, logout — but account management is not part of this slice. Seeded users only.
- **A sessions screen.** `refresh_tokens` records the user agent and IP per family, so "your
  active sessions, sign out that one" is a query away, and `revokeAllSessions` already exists.
  There was no screen worth building for it here.
- **Component tests.** I spent the test budget on integration tests for the transaction,
  concurrency and constraint behaviour, because that is where a bug would silently corrupt
  stock. The form logic is validated by zod schemas that are cheap to read and hard to get
  subtly wrong.
