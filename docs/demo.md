# Demo — the operations behind the screens

Every GraphQL operation the UI sends, in the order a walkthrough hits them. Paste any of these
into <http://localhost:4000> with an `Authorization` header, or watch them go out in the
network tab.

The bearer tokens are printed by `npm run seed` and again when the API boots with
`DEV_AUTH_DEBUG=true`:

```
Authorization: Bearer daas_<base64url({"sub":"<uuid>","role":"ADMIN"})>
```

---

## 1. The list, and the derived status filter

Status is not a column. `purchaseOrders(filter: { status: PARTIAL })` resolves through the
`purchase_order_status` SQL view.

```graphql
query PurchaseOrders($filter: PurchaseOrderFilter) {
  purchaseOrders(filter: $filter) {
    id
    poNumber
    status
    totalOrdered
    totalReceived
    totalCostCents
    vendor { name }
    location { code }
  }
}
```

```json
{ "filter": { "status": "PARTIAL" } }
```

Against the seed, all four orders come back as `OPEN`, `PARTIAL`, `RECEIVED`, `OPEN` — one of
each state the UI can show.

---

## 2. Creating a purchase order — `ADMIN` only

Header and lines are one transaction. Costs are integer cents; the form converts from dollars
at the edge.

```graphql
mutation CreatePurchaseOrder($input: CreatePurchaseOrderInput!) {
  createPurchaseOrder(input: $input) {
    id
    poNumber
  }
}
```

```json
{
  "input": {
    "poNumber": "PO-2001",
    "vendorId": "<vendor id>",
    "locationId": "<location id>",
    "notes": "Level 8 boardroom fitout.",
    "lines": [
      { "productId": "<product id>", "quantityOrdered": 3, "unitCostCents": 189900 }
    ]
  }
}
```

Run it twice and the second returns `CONFLICT` with `field: "poNumber"`, which the form
attaches to the input rather than showing as a page-level banner.

---

## 3. Receiving — the guarded, transactional mutation

Requires `ADMIN` or `WAREHOUSE`. Locks the PO, validates every line against its outstanding
quantity, appends the movements and moves the on-hand projection — all or nothing.

```graphql
mutation ReceivePurchaseOrder($input: ReceivePurchaseOrderInput!) {
  receivePurchaseOrder(input: $input) {
    purchaseOrder {
      poNumber
      status
      totalReceived
    }
    movements {
      id
      quantity
      createdAt
    }
  }
}
```

```json
{
  "input": {
    "purchaseOrderId": "<PO-1002 id>",
    "locationId": "<location id>",
    "reason": "Delivery docket 88213",
    "lines": [{ "purchaseOrderLineId": "<SR-HD-101 line id>", "quantity": 5 }]
  }
}
```

### The three responses worth seeing

**Success** — status advances on its own, because it is derived:

```json
{
  "data": {
    "receivePurchaseOrder": {
      "purchaseOrder": { "poNumber": "PO-1002", "status": "PARTIAL", "totalReceived": 23 },
      "movements": [{ "quantity": 5 }]
    }
  }
}
```

**Over-receipt** — same call with `"quantity": 99`. The error names the SKU and the numbers, so
the dialog can put a message on the right row:

```json
{
  "errors": [{
    "message": "Cannot receive 99 of SR-HD-101: 20 ordered, 8 already received, 12 outstanding.",
    "extensions": {
      "code": "OVER_RECEIPT",
      "sku": "SR-HD-101",
      "ordered": 20,
      "alreadyReceived": 8,
      "attempted": 99
    }
  }]
}
```

**Forbidden** — same call with Vic's `VIEWER` token. The UI disables the button, but this is the
check that actually enforces it:

```json
{
  "errors": [{
    "message": "Your role (VIEWER) cannot perform this action. Requires: ADMIN or WAREHOUSE.",
    "extensions": { "code": "FORBIDDEN", "requiredRoles": ["ADMIN", "WAREHOUSE"] }
  }]
}
```

---

## 4. The PO detail, including receipt history

Each line carries its own audit trail: who received what, into which location, when, and
against which delivery note.

```graphql
query PurchaseOrder($id: ID!) {
  purchaseOrder(id: $id) {
    poNumber
    status
    notes
    createdBy { name }
    lines {
      quantityOrdered
      quantityReceived
      quantityOutstanding
      unitCostCents
      product { sku name }
      receipts {
        quantity
        reason
        createdAt
        location { code }
        createdBy { name }
      }
    }
  }
}
```

---

## 5. Stock on hand — proof the receipt moved real stock

```graphql
query StockOnHand($locationId: ID) {
  stockOnHand(locationId: $locationId) {
    quantity
    updatedAt
    product { sku name }
    location { code }
  }
}
```

Receiving invalidates this query's cache tag, so the stock page updates without knowing
anything about purchase orders.

---

## Suggested walkthrough

1. **Purchase orders** — four seeded POs, one per status. Filter to *Partially received*.
2. Open **PO-1002**. Note the per-line progress bars and the existing receipt history.
3. **Receive stock** → type `99` into a line. Client-side: *"Only 12 outstanding."*
4. Correct it to `5`, add a delivery note, confirm. Received goes 8 → 13, "7 left", and a new
   audit line appears — no reload.
5. **Stock on hand** — `SR-HD-101` is now 13. The cache tag did that.
6. Switch **Acting as** to *Vic (Viewer)*. **Receive stock** is disabled with a tooltip; the API
   returns `FORBIDDEN` regardless.
7. `cd api && npm run check:ledger` — the ledger and the projection still agree.
