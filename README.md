# DaaS — Purchase Order Receiving (Sprint 2 slice)

One feature slice end to end: Postgres schema and migration, an Apollo GraphQL API, and a
Next.js UI. You can raise a purchase order, receive stock against it line by line, and watch
on-hand quantities move — with the PO's status derived from what has actually been received,
never set by hand.

**Stack:** Node 24 · TypeScript (strict) · Postgres 17 · Prisma 6 · Apollo Server 5 ·
Next.js 16 (App Router) · MUI 9 · Redux Toolkit + RTK Query · react-hook-form + zod ·
pino · Biome

---

## Quick start

One command, from a clean clone:

```bash
npm start
```

It copies the `.env` files, installs both packages, starts Postgres and waits for it to
pass its healthcheck, generates the Prisma client, applies the migrations, seeds an empty
database, and runs the API and web app together. Every step is idempotent, so it is also
the command to run on any later morning — it will not reinstall what is there or reseed
over data you were looking at.

Then open <http://localhost:3000> and sign in.

Two tenants are seeded, so isolation and feature switches are visible rather than
theoretical. Password is `daas-dev-password` for all of them.

| User | Tenant | Role | Stock visible |
| --- | --- | --- | :---: |
| `ada@daas.test` | Riverside AV | Administrator | ✓ |
| `wes@daas.test` | Riverside AV | Warehouse | ✓ |
| `vic@daas.test` | Riverside AV | Viewer | ✓ |
| `nina@northgate.test` | Northgate Integration | Administrator | — |

Sign in as Ada, then as Nina: different purchase orders, different vendors, and no
**Stock on hand** in the navigation at all. Both tenants have a `PO-1001`, which is the
point — uniqueness is per tenant.

<details>
<summary>Prerequisites, and the individual commands if you want them</summary>

Node 24 (`.nvmrc`) and Docker running. Nothing else.

```bash
npm run dev          # both services, prefixed output, Ctrl-C stops both
npm run dev:api      # one service alone, when you want its logs isolated
npm run dev:web
npm run db:up        # Postgres only
npm run db:down
npm run verify       # lint + typecheck, both packages
npm test             # 75 integration tests against a real Postgres
```

`npm run dev` uses `--kill-others-on-fail`, so a crash in one service stops the other
rather than leaving a half-running stack on an occupied port.

To reset the data: `npm --prefix api run seed` (it truncates first, so `npm start` will not
do it for you once the database has users).

</details>

### What the seed gives you

Four purchase orders covering every status the UI can show, plus the stock ledger and
on-hand rows implied by their receipts:

| PO | Vendor | Status | Why |
| --- | --- | --- | --- |
| PO-1001 | Crestron | `OPEN` | Nothing received |
| PO-1002 | Extron | `PARTIAL` | One line short-delivered |
| PO-1003 | Shure | `RECEIVED` | Fully satisfied |
| PO-1004 | Extron | `OPEN` | Second vendor, for the vendor filter |

[`docs/demo.md`](docs/demo.md) is a ten-minute guided walkthrough, followed by the API
behind it.

---

# Design decisions

The three things worth arguing about: how identity is proved, how access is decided, and
where the rules are actually enforced.

---

## 1. Authentication

Password sign-in issuing two tokens, deliberately different in kind:

| | Access token | Refresh token |
| --- | --- | --- |
| Format | JWT, HS256 | Opaque, 256 random bits |
| Lifetime | 15 minutes | 30 days |
| Delivery | httpOnly cookie | httpOnly cookie |
| Server state | none — signature only | SHA-256 **hash** in `refresh_tokens` |
| Revocable | no | yes |

**Why two kinds.** The access token is stateless so the hot path — every query and mutation
— costs no database round trip. That is exactly why it is short-lived: a stateless token
cannot be revoked, so the expiry window bounds the damage. The refresh token is the
opposite: it must be revocable, which makes it stateful regardless, so signing it would buy
nothing. It is stored only as a hash, for the same reason passwords are — a dump of that
table must not yield usable sessions.

**Rotation with reuse detection.** Every refresh issues a new pair and retires the old one.
Presenting an already-retired token means it leaked, because the legitimate client is
holding its replacement — so the whole token *family* from that sign-in is revoked and both
parties must sign in again. That detection is the entire reason rotation is worth doing;
without it a stolen token simply works until it expires.

Three details that are easy to get wrong, and are handled:

- **The claim is a conditional `UPDATE`** (`rotated_at IS NULL` in the `WHERE`), not
  read-then-write. Only one caller can win, so concurrent refreshes cannot both succeed.
- **Revocation runs outside the transaction that rejects the caller.** Revoking the family
  *inside* it rolled the revocation back — the detection fired and left the stolen session
  working. That was a real bug, caught by a test.
- **The client single-flights refreshes** behind a mutex. Several queries expiring at once
  would each fire a refresh, and the later ones would look exactly like theft — the app
  would log the user out by itself.

**Passwords** use scrypt from `node:crypto`: memory-hard, on OWASP's accepted list, and no
native build step for a reviewer to install. Parameters are stored with each hash so they
can be raised later without invalidating existing passwords. Sign-in always runs a
verification even for an unknown email, and returns an identical message for a wrong
password and an unknown account, so the form is not an account-enumeration oracle.

**Cookies never reach JavaScript.** The browser talks to a same-origin Next route handler
at `/api/graphql`, which forwards to the API and relays `Set-Cookie` back. That keeps the
cookies first-party — no CORS credential negotiation, `SameSite=Lax`, `Secure` in
production — and means `document.cookie` is empty even to an XSS payload.

**The accepted limitation:** an access token stays valid until it expires, so deactivating a
user or changing their access takes effect within 15 minutes rather than instantly. The fix,
if that window mattered, is a `token_version` column checked per request — trading a little
statelessness for immediate revocation.

---

## 2. Authorisation — access rights, and the role map

**Permissions are the unit of authorisation. A role is only a named bundle of them, and
nothing in the codebase branches on a role key.**

### The access rights

| Permission | Grants |
| --- | --- |
| `purchase_order:read` | View purchase orders and their lines |
| `purchase_order:create` | Raise new purchase orders |
| `purchase_order:void` | Void a purchase order that has no receipts |
| `stock:read` | View on-hand stock and the movement ledger |
| `stock:receive` | Receive stock against a purchase order |
| `role:manage` | Create roles and change what they grant |

Every one of these gates a real operation. The catalogue started with two more —
`stock:adjust` and `user:read` — added on the assumption that the operations would follow.
They did not, so they were removed: a permission that grants nothing is worse than an
absent one, because it tells an administrator they have allowed something they have not.
They come back with the mutations they were named for.

### The role map

| Permission | Administrator | Warehouse | Viewer |
| --- | :---: | :---: | :---: |
| `purchase_order:read` | ✓ | ✓ | ✓ |
| `purchase_order:create` | ✓ | | |
| `purchase_order:void` | ✓ | | |
| `stock:read` | ✓ | ✓ | ✓ |
| `stock:receive` | ✓ | ✓ | |
| `role:manage` | ✓ | | |

Four tables hold this:

| Table | Holds |
| --- | --- |
| `permissions` | The catalogue above |
| `roles` | Named bundles; `is_system` marks the three that ship |
| `role_permissions` | The map above — **data**, editable without a deploy |
| `user_roles` | Who holds what. A user may hold several |

### Why split them

The split earns its keep the moment someone needs a role the product did not ship. Creating
a "Goods In" role that grants only `stock:receive` is three INSERTs, and the receive
mutation then authorises it with **no code change**:

```sql
INSERT INTO roles (id, key, name, is_system, updated_at)
VALUES (gen_random_uuid(), 'goods_in', 'Goods In', false, CURRENT_TIMESTAMP);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key = 'stock:receive'
WHERE r.key = 'goods_in';
```

There is a test that does exactly this, because it is the property that rots the first time
someone reaches for a role name.

**What stays in code is the catalogue**, in `api/src/shared/permissions.ts` — the
application can only check permissions it knows at compile time, and a typo should be a
typecheck failure rather than a silently-false check. What is data is the *mapping*.

A user's effective permissions are the **union** across their roles, so roles add access and
never remove it. Errors name the missing permission, because that is what an administrator
has to grant:

```json
{ "message": "This action requires the \"stock:receive\" permission.",
  "extensions": { "code": "FORBIDDEN", "requiredPermissions": ["stock:receive"] } }
```

Access tokens carry the effective permission list, which is what keeps authorisation free
of a database round trip on every request.

---

## 3. Multi-tenancy and feature switches

### Isolation

Shared database, shared schema, `tenant_id` column. The alternatives — a schema or a
database per tenant — give harder isolation at the cost of running every migration N times
and fragmenting the connection pool. For an internal tool with a handful of tenants,
row-level scoping enforced centrally is the right trade.

**The enforcement is the interesting part.** Writing `where: { tenantId }` at each call site
is the same pattern that already shipped unguarded reads here once — and a cross-tenant leak
is worse than an unguarded read, because it shows one customer another customer's costs and
suppliers.

So the filter is injected by a Prisma client extension, and the tenant travels in
`AsyncLocalStorage` rather than through every function signature. A query written without a
tenant filter still gets one; a query issued with no tenant context **throws** rather than
quietly reading every tenant. `assertTenancyIsComplete` runs at boot and refuses to start if
a model is neither scoped nor explicitly global.

**What this cost, honestly.** The first implementation bound the tenant with
`AsyncLocalStorage.enterWith` inside the GraphQL context function. It looked right and was
not — the store was gone by the time resolvers ran. The fix was Express middleware wrapping
the request in `storage.run`, which is why the API is no longer on
`startStandaloneServer`. A second subtlety followed: Prisma promises are lazy, so returning
one from inside the store without awaiting it dispatches the query *outside* the store.
`withTenant` awaits internally so no caller can reintroduce that.

Two places the extension cannot reach, both handled explicitly and both covered by tests
that fail if the predicate is removed:

- **Raw SQL** — the list queries and the `SELECT … FOR UPDATE` row lock in receiving.
- **Writes** — these name the tenant explicitly. A missing one fails the `NOT NULL`
  constraint immediately, which is loud; a missing *read* filter would be silent, which is
  why reads are the ones the extension guarantees.

**The limit, stated plainly:** this is application-level enforcement. Postgres row-level
security would move the boundary into the database, and is the natural hardening step. It
needs a session variable set per transaction, which with Prisma's pooling means routing
every call through a transaction client — a larger change than this slice warrants. The
README says so rather than implying the database is enforcing it.

### Feature switches

`tenant_features` rows, with the catalogue in `api/src/shared/features.ts` — same split as
permissions, for the same reason. **Absent means off**, so a new feature is dark for
everyone until someone switches it on.

A feature is **not** authorisation, and they are separate tables in `authorize.ts`:

| | Asks | Fixed by |
| --- | --- | --- |
| Permission | May *this user* do it? | An administrator granting it |
| Feature | Does *this tenant* have it at all? | An account manager |

Conflating them produces the wrong error. A user with `stock:read` in a tenant without
`stock.view` has not been under-permissioned, so they get `FEATURE_DISABLED`, not
`FORBIDDEN`. The feature is checked *after* the permission, so an unauthorised caller cannot
probe which features a tenant has bought.

The one flag so far is `stock.view`: it gates the `stockOnHand` query, the nav entry, and
the page itself — typing `/stock` in a tenant without it gets an explanation, not an error.

---

## 4. Guard rails

Rules are enforced in two places, and the split is deliberate: the database holds the
invariants that must be true no matter what code runs, and the application holds the ones
that need context or a good error message.

### At the database

**Constraints — things no code path may violate.**

| Constraint | Prevents |
| --- | --- |
| `quantity_ordered > 0`, `unit_cost_cents >= 0` | A zero-quantity or negative-cost line |
| `stock_movements.quantity <> 0` | No-op rows polluting the ledger |
| `type <> 'RECEIPT' OR quantity > 0` | A "receipt" that removes stock |
| `type <> 'RECEIPT' OR purchase_order_line_id IS NOT NULL` | A receipt the totals view cannot attribute |
| `stock_on_hand.quantity >= 0` | Negative stock |
| `refresh_tokens.expires_at > created_at` | A token that expired before it was issued |

These are not belt-and-braces for the resolver checks — they hold against a migration
script, a psql session, or a future service that forgets. One of them caught a bug in my own
test fixture while I was writing these tests.

**Unique indexes, scoped to live rows.** Uniqueness is partial — `WHERE deleted_at IS NULL`
— on vendor codes, SKUs, location codes, PO numbers, role keys, user emails, and
`(purchase_order_id, product_id)`. A plain `UNIQUE` would let a soft-deleted vendor hold its
code hostage forever; "unique among rows that still exist" is what the domain means.

**Foreign keys are `RESTRICT` by default**, `CASCADE` only where the child is genuinely part
of the parent aggregate (PO lines, a user's sessions and role assignments). Deleting a role
that people still hold fails loudly rather than silently stripping their access.

**Indexes built for the queries that run.** Chosen against the query plans and verified
with `EXPLAIN`, not guessed:

| Query shape | Index | Plan |
| --- | --- | --- |
| Filter by vendor + keyset | `(vendor_id, id DESC) WHERE deleted_at IS NULL` | Index Only Scan |
| Substring search | GIN `gin_trgm_ops` on `po_number` | Bitmap Index Scan |
| Unfiltered list + keyset | `(id DESC) WHERE deleted_at IS NULL` | Index Only Scan |
| Received totals view | `(purchase_order_line_id) WHERE type = 'RECEIPT'` | matches the join exactly |

Two details worth naming:

- **Partial on `deleted_at IS NULL`.** Every list carries that predicate and soft-deleted
  rows are never listed, so the index holds only rows that can actually be returned.
- **The unfiltered keyset index was tested, not assumed.** With few deleted rows the
  planner prefers a backward scan of the primary key and the index is redundant. At 70%
  soft-deleted — what a long-lived table looks like — it switches to the partial index,
  because the PK scan would otherwise read and discard every dead row to fill a page. That
  is the evidence it earns its write cost.

A trigram index is needed because `ILIKE '%1002%'` has a leading wildcard: a btree can only
seek on a known prefix, so it cannot help at all.

The single-column `vendor_id` and `location_id` indexes were **dropped** — the composites
serve those lookups from their leading column, and keeping both would cost an extra write
per insert for no read benefit.

---
### At the application layer

**Authorisation is default-deny, applied at the schema rather than in each resolver.** The
policy is one table in [`authorize.ts`](api/src/shared/authorize.ts), and every Query and
Mutation root field is wrapped with it as the schema is built:

```ts
const POLICY: Record<string, Policy> = {
  login:                'PUBLIC',          // necessarily reachable while signed out
  me:                   'AUTHENTICATED',   // a session, but no particular permission
  purchaseOrders:       PERMISSIONS.PURCHASE_ORDER_READ,
  stockOnHand:          PERMISSIONS.STOCK_READ,
  receivePurchaseOrder: PERMISSIONS.STOCK_RECEIVE,
  // …
};
```

A boot-time assertion **refuses to start the server** if any root field is missing from
that table, naming the field. Adding a resolver without deciding who may call it is a
startup crash, not a silent hole.

That structure exists because the obvious alternative failed here. Guards written by hand
in each resolver covered all three mutations and **none** of the reads — purchase orders
with costs, vendor contact emails and stock levels were readable with no session at all.
Nothing caught it, because nothing was checking that a check existed. Moving the decision
into one reviewable table and making its completeness a startup assertion fixes the class
rather than the instances.

Only root fields are wrapped: nested fields are reachable only *through* a root field, so
gating the entry point gates the subtree.

**Transactions wrap every multi-row write.** Receiving appends the ledger rows and moves
the on-hand projection in one transaction — nothing outside it can observe one without the
other. A `SELECT … FOR UPDATE` on the purchase order serialises concurrent receipts, so two
people receiving the last item cannot both pass the outstanding-quantity check.

**Input validation is zod, in the service rather than the resolver**, so a future worker or
CLI gets the same checks. GraphQL already enforces types and nullability; zod covers what
it cannot — ranges, integer-ness, non-empty lists, duplicate keys.

**SQL is composed with `Prisma.sql`**, never string interpolation, so every value is a bound
parameter. `%` and `_` are escaped in anything reaching a `LIKE`, or a stray wildcard
quietly matches everything.

**Errors carry a stable `extensions.code`** the UI branches on. Unexpected errors are logged
server-side with the request id and returned as a generic `INTERNAL_SERVER_ERROR` with no
stack trace.

**The UI mirrors, never owns.** `can(user, PERMISSIONS.X)` decides what to render; the
server decides what is permitted. Re-enabling a disabled button in devtools still gets
`FORBIDDEN`.

---

# Implementation notes

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

One more worth naming here: `UNIQUE (product_id, location_id)` on `stock_on_hand` is what
makes the increment-on-receive upsert safe under concurrency.

The check constraints, partial unique indexes and foreign-key rules are covered under
[Guard rails → At the database](#at-the-database).

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

---

## Filtering and pagination

**Every filter is applied in SQL.** Nothing is fetched and narrowed in the browser, and
nothing is fetched and narrowed in the resolver either — filters, ordering and the page
window are composed into one statement in
[`repository.ts`](api/src/domains/purchasing/repository.ts).

That replaced a real wart: the old status filter selected *every* matching id from the
view and then re-queried, which cannot paginate and gets slower with every PO ever raised.

```graphql
purchaseOrders(
  filter: { status: PARTIAL, vendorId: "…", search: "1002" }
  first: 20
  after: "…"
) {
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes { poNumber status }
}
```

### Why keyset, not offset

`OFFSET 5000` makes Postgres walk and discard 5000 rows on every request, so the last page
is the slowest one. Worse, a row inserted while someone is paging shifts everything down —
they see a row twice, or miss one entirely.

Keyset asks "the rows after this one", which is a single index seek at any depth and is
stable under inserts. The cost is that you cannot jump to page 37, which is why the UI
offers next/previous rather than numbered pages. `totalCount` is still returned, so it can
say "1–20 of 47".

This is what the UUIDv7 primary keys were for: they sort by creation time, so `ORDER BY id
DESC` is both a meaningful "newest first" and a usable keyset column with no extra index.

Stock on hand is ordered by SKU instead, which is not unique — so its cursor is the
composite `(sku, id)`, compared with a Postgres row-value predicate that an index on those
two columns can still satisfy in one seek.

Guardrails: `first` is capped at 100, cursors are opaque (a client that parses one ends up
depending on the sort key), and `%`/`_` in a search term are escaped so a stray wildcard
cannot quietly match everything.

---

## Logging

Structured JSON via pino — pretty-printed locally, JSON in production.

One line per GraphQL operation, carrying a `requestId` that an inbound `x-request-id`
can set, so a trace started at the proxy continues through the API:

```
INFO: graphql operation
    requestId: "trace-abc"   userId: "01a0ccc8-…"   operation: "PurchaseOrders"
    durationMs: 11           errorCount: 0
```

Levels are chosen so a production `level: warn` still surfaces everything actionable:
expected rejections (a permission denial) sit at debug, operations over
`SLOW_OPERATION_MS` warn with `slow: true`, and only genuine faults reach error.

Auth events carry an `event` field for alerting — `auth.login`, `auth.logout`, and
`auth.refresh_reuse`, the last being refresh-token theft detection and therefore a warn.

**Everything credential-shaped is redacted by path** before it is written: authorization
and cookie headers, passwords, tokens and hashes. A token that reaches a log file is a
leak that outlives the request and gets copied into every downstream system, so this is
configured centrally rather than trusted to each call site.

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
    domains/auth/              # identity: sign-in, rotation, roles, cookies
      service.ts               #   rotation, reuse detection, effective permissions
      cookies.ts               #   httpOnly cookie shaping
    shared/
      permissions.ts           #   the permission catalogue — source of truth
      auth.ts                  #   requirePermission, the single authorisation gate
      logger.ts                #   pino, with credential redaction
      logging-plugin.ts        #   one log line per GraphQL operation
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

The boundary that matters is `resolvers.ts` → `service.ts`. Resolvers check a permission and
translate shapes. Services own the rules and the transactions, and take no GraphQL types in
their signatures — so when sprint 4 needs "closing an RMA returns stock", it calls the same
stock-movement code path rather than reimplementing it behind a second resolver.

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
