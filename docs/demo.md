# DaaS — guided walkthrough

A purchase-order receiving slice: raise an order, receive stock against it, and watch on-hand
quantities move — with the order's status derived from what has actually been received.

Everything below runs locally in a few minutes. Section 1 is the tour; the rest is the API
behind it, for anyone who would rather read requests than click.

```bash
npm start
```

One command from a clean clone: it writes the `.env` files, installs both packages, starts
Postgres, migrates, seeds, and runs the API and the web app. Then open
<http://localhost:3000>.

**Sign-ins** — password `daas-dev-password` for all of them:

| User | Organisation | Role | Stock visible |
| --- | --- | --- | :---: |
| `ada@daas.test` | Riverside AV | Administrator | ✓ |
| `wes@daas.test` | Riverside AV | Warehouse | ✓ |
| `vic@daas.test` | Riverside AV | Viewer | ✓ |
| `nina@northgate.test` | Northgate Integration | Administrator | — |

---

## 1. The walkthrough

Ten minutes, in order. Each step shows one thing the design is actually about.

### Receiving, and status that derives itself

**1. Sign in as `ada@daas.test`.** The list shows four purchase orders, one in each state:
`Open`, `Partially received`, `Received`. None of those is a stored column — they are computed
from the stock ledger by a SQL view, so the status can never disagree with what was received.

**2. Filter.** Search `1002`, pick a vendor, change the status. Every filter runs in SQL with
keyset pagination; nothing is narrowed in the browser.

**3. Open PO-1002.** Two lines, one part-delivered. Each line carries its own receipt history:
who received what, into which location, when, against which delivery note.

**4. Click *Receive stock* and type `99`.** The dialog says *"Only 12 outstanding."* Correct it
to `5`, add a delivery note, confirm.

Received goes 8 → 13, the progress bar moves, "7 left" appears, and a new audit line shows up —
without a page reload. Behind that, one transaction appended a ledger row and moved the on-hand
projection; either both happened or neither did.

**5. Open *Stock on hand*.** `SR-HD-101` is now 13. That page knows nothing about purchase
orders — receiving invalidates a shared cache tag, and it refreshes itself.

### Permissions, not roles

**6. Sign out, sign in as `vic@daas.test`** (Viewer). *Receive stock* is disabled, and there is
no *New PO* button.

Re-enable the button in devtools and click it anyway. The API answers:

```json
{ "message": "This action requires the \"stock:receive\" permission.",
  "extensions": { "code": "FORBIDDEN", "requiredPermissions": ["stock:receive"] } }
```

The UI mirrors the rule; the server owns it. Note the error names a **permission**, not a role
— because a permission is the thing an administrator grants to fix it. Roles are only named
bundles, and nothing in the codebase branches on a role name.

### Multiple organisations, and feature switches

**7. Sign out, sign in as `nina@northgate.test`.**

Three things change at once:

- The header chip reads **Northgate Integration**.
- The purchase orders are entirely different — and Northgate also has a `PO-1001`. Both
  organisations can use the same PO numbers, SKUs and vendor codes, because uniqueness is
  per organisation.
- **"Stock on hand" is gone from the navigation.** Stock visibility is a feature switch, and
  Northgate does not have it.

**8. Type `/stock` in the address bar anyway.** You get an explanation, not an error:

> **Stock is not enabled** — Stock visibility is switched off for Northgate Integration.

The API refuses it independently with `FEATURE_DISABLED`. That is deliberately a different
code from `FORBIDDEN`: a permission problem is fixed by an administrator, a disabled feature by
an account manager, and telling someone the wrong one wastes their afternoon.

### Proof, not assertion

**9. Run the tests.**

```bash
npm test
```

75 integration tests against a real Postgres — no mocks, because the behaviour worth testing
(transaction rollback, `SELECT … FOR UPDATE` serialisation, check constraints, SQL views,
tenant isolation) lives in the database. They cover over-receipt, all-or-nothing multi-line
receipts, two people racing for the last item, refresh-token theft detection, and interleaved
requests from two organisations.

**10. Check the ledger.**

```bash
npm --prefix api run check:ledger
```

Re-derives on-hand from the movement ledger and diffs it against the stored projection. This is
what makes denormalising on-hand defensible: the invariant is asserted rather than hoped for.

---

## 2. The API behind it

Sessions are cookie-based, so a client needs a cookie jar.

```bash
curl -s -c jar.txt -X POST http://localhost:3000/api/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"mutation($i:LoginInput!){login(input:$i){user{name tenant{name features}}}}","variables":{"i":{"email":"ada@daas.test","password":"daas-dev-password"}}}'
```

That sets two httpOnly cookies — a 15-minute access JWT and a 30-day rotating refresh token.
Later calls just need `-b jar.txt`. The API also accepts `Authorization: Bearer <token>`, so
the Apollo sandbox works without cookies.

### Purchase orders, filtered and paginated

```graphql
query PurchaseOrders($filter: PurchaseOrderFilter, $first: Int, $after: String) {
  purchaseOrders(filter: $filter, first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { poNumber status totalReceived totalCostCents vendor { name } }
  }
}
```

```json
{ "filter": { "status": "PARTIAL", "search": "1002" }, "first": 20 }
```

Pagination is keyset, not offset: pass `pageInfo.endCursor` back as `after`. Cursors are
opaque, `first` is capped at 100, and `%` in a search term is escaped rather than treated as a
wildcard.

### Receiving — the guarded, transactional mutation

```graphql
mutation ReceivePurchaseOrder($input: ReceivePurchaseOrderInput!) {
  receivePurchaseOrder(input: $input) {
    purchaseOrder { poNumber status totalReceived }
    movements { id quantity createdAt }
  }
}
```

```json
{
  "input": {
    "purchaseOrderId": "<PO-1002 id>",
    "reason": "Delivery docket 88213",
    "lines": [{ "purchaseOrderLineId": "<SR-HD-101 line id>", "quantity": 5 }]
  }
}
```

Three responses worth seeing:

**Success** — status advances on its own, because it is derived:

```json
{ "purchaseOrder": { "poNumber": "PO-1002", "status": "PARTIAL", "totalReceived": 23 },
  "movements": [{ "quantity": 5 }] }
```

**Over-receipt** — send `"quantity": 99`. The error names the SKU and the numbers, so the
dialog can put the message on the right row, and nothing is written:

```json
{ "message": "Cannot receive 99 of SR-HD-101: 20 ordered, 8 already received, 12 outstanding.",
  "extensions": { "code": "OVER_RECEIPT", "sku": "SR-HD-101", "ordered": 20,
                  "alreadyReceived": 8, "attempted": 99 } }
```

**Forbidden** — the same call signed in as Vic:

```json
{ "message": "This action requires the \"stock:receive\" permission.",
  "extensions": { "code": "FORBIDDEN", "requiredPermissions": ["stock:receive"] } }
```

### Who you are, and what your organisation has

```graphql
query Me {
  me {
    name
    tenant { name features }
    roles { key name permissions { key } }
    permissions
  }
}
```

`permissions` is the union across every role held. Granting a group of people new access is an
`INSERT` into `role_permissions`, not a deploy — a "Goods In" role that grants only
`stock:receive` works with no code change, and there is a test that proves it.

### Every read is gated too

With no cookie and no token:

```bash
curl -s http://localhost:4000/ -H 'content-type: application/json' \
  -d '{"query":"{ purchaseOrders { totalCount } }"}'
```

```json
{ "errors": [{ "message": "Sign in to continue.",
               "extensions": { "code": "UNAUTHENTICATED" } }] }
```

Authorisation is declared once per field and applied as the schema is built, and the server
refuses to boot if any field has no entry — so a new resolver cannot ship unguarded.

### Session lifecycle

```bash
# Rotate: issues a new pair and retires the presented token
curl -s -b jar.txt -c jar.txt -X POST http://localhost:3000/api/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"mutation{refreshSession{expiresIn}}"}'
```

Replay the *previous* refresh token afterwards and the API answers:

```json
{ "errors": [{ "message": "Session reuse detected. All sessions have been signed out." }] }
```

The legitimate token dies with it, because there is no way to tell the thief from the victim.
That detection is the reason rotation is worth doing at all.

---

## 3. Where to look in the code

| Question | File |
| --- | --- |
| How is receiving made atomic? | [`api/src/domains/purchasing/service.ts`](../api/src/domains/purchasing/service.ts) |
| Where is status derived? | [`the init migration`](../api/prisma/migrations/20260922000000_init/migration.sql) — the two SQL views at the end |
| Who may call what? | [`api/src/shared/authorize.ts`](../api/src/shared/authorize.ts) |
| How is one organisation kept out of another's data? | [`api/src/shared/tenancy.ts`](../api/src/shared/tenancy.ts) |
| Why these indexes? | [`the index migration`](../api/prisma/migrations/20260923100000_query_pattern_indexes/migration.sql) |

The [README](../README.md) covers the design decisions and their trade-offs, including the
architecture note on making stock movements transactional and auditable.
