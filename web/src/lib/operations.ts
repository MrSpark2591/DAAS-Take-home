/**
 * Every GraphQL document the UI sends. Kept in one file so codegen has a single
 * place to scan and so the network surface of the app is reviewable at a glance.
 *
 * The `/* GraphQL *\/` marker is what makes codegen pick these up and validate
 * them against the API's SDL at build time.
 */

const PURCHASE_ORDER_SUMMARY = /* GraphQL */ `
  fragment PurchaseOrderSummary on PurchaseOrder {
    id
    poNumber
    status
    totalOrdered
    totalReceived
    totalCostCents
    createdAt
    vendor {
      id
      name
      code
    }
    location {
      id
      code
      name
    }
  }
`;

export const PurchaseOrdersDocument = /* GraphQL */ `
  query PurchaseOrders($filter: PurchaseOrderFilter) {
    purchaseOrders(filter: $filter) {
      ...PurchaseOrderSummary
    }
  }
  ${PURCHASE_ORDER_SUMMARY}
`;

export const PurchaseOrderDocument = /* GraphQL */ `
  query PurchaseOrder($id: ID!) {
    purchaseOrder(id: $id) {
      ...PurchaseOrderSummary
      notes
      createdBy {
        id
        name
      }
      lines {
        id
        quantityOrdered
        quantityReceived
        quantityOutstanding
        unitCostCents
        lineTotalCents
        product {
          id
          sku
          name
          unit
        }
        receipts {
          id
          quantity
          createdAt
          reason
          location {
            id
            code
          }
          createdBy {
            id
            name
          }
        }
      }
    }
  }
  ${PURCHASE_ORDER_SUMMARY}
`;

export const FormOptionsDocument = /* GraphQL */ `
  query FormOptions {
    vendors {
      id
      code
      name
    }
    locations {
      id
      code
      name
    }
    products {
      id
      sku
      name
      unit
    }
  }
`;

export const MeDocument = /* GraphQL */ `
  query Me {
    me {
      id
      name
      email
      roles {
        id
        key
        name
      }
      permissions
    }
  }
`;

export const LoginDocument = /* GraphQL */ `
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      expiresIn
      user {
        id
        name
        email
        roles {
          id
          key
          name
        }
        permissions
      }
    }
  }
`;

/**
 * Exchanges the refresh cookie for a new pair. Called only by the base query's
 * reauth path, never directly from a component.
 */
export const RefreshSessionDocument = /* GraphQL */ `
  mutation RefreshSession {
    refreshSession {
      expiresIn
      user {
        id
        name
        email
        roles {
          id
          key
          name
        }
        permissions
      }
    }
  }
`;

export const LogoutDocument = /* GraphQL */ `
  mutation Logout {
    logout
  }
`;

export const StockOnHandDocument = /* GraphQL */ `
  query StockOnHand($locationId: ID, $productId: ID) {
    stockOnHand(locationId: $locationId, productId: $productId) {
      id
      quantity
      updatedAt
      product {
        id
        sku
        name
      }
      location {
        id
        code
        name
      }
    }
  }
`;

export const CreatePurchaseOrderDocument = /* GraphQL */ `
  mutation CreatePurchaseOrder($input: CreatePurchaseOrderInput!) {
    createPurchaseOrder(input: $input) {
      id
      poNumber
    }
  }
`;

export const ReceivePurchaseOrderDocument = /* GraphQL */ `
  mutation ReceivePurchaseOrder($input: ReceivePurchaseOrderInput!) {
    receivePurchaseOrder(input: $input) {
      purchaseOrder {
        id
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
`;
