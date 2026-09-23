export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  DateTime: { input: string; output: string; }
};

/**
 * What the client gets back from a sign-in or a refresh.
 *
 * The refresh token is deliberately absent: it is delivered as an httpOnly
 * cookie, so browser JavaScript can never read it. Even the access token is a
 * cookie -- this payload carries only what the UI needs to render.
 */
export type AuthPayload = {
  /** Seconds until the access token expires. */
  expiresIn: Scalars['Int']['output'];
  user: User;
};

export type CreatePurchaseOrderInput = {
  lines: Array<CreatePurchaseOrderLineInput>;
  locationId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  poNumber: Scalars['String']['input'];
  vendorId: Scalars['ID']['input'];
};

export type CreatePurchaseOrderLineInput = {
  productId: Scalars['ID']['input'];
  quantityOrdered: Scalars['Int']['input'];
  unitCostCents: Scalars['Int']['input'];
};

export type Location = {
  code: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

export type LoginInput = {
  email: Scalars['String']['input'];
  password: Scalars['String']['input'];
};

export type MovementType =
  | 'ADJUSTMENT'
  | 'ALLOCATION'
  | 'RECEIPT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT';

export type Mutation = {
  /** Requires ADMIN. */
  createPurchaseOrder: PurchaseOrder;
  /**
   * Exchange credentials for a session. Sets the access and refresh cookies.
   *
   * Fails with UNAUTHENTICATED and a deliberately vague message for both an
   * unknown email and a wrong password.
   */
  login: AuthPayload;
  /** Revokes this session everywhere it was rotated to, and clears the cookies. */
  logout: Scalars['Boolean']['output'];
  /**
   * Receive quantities against PO lines. Requires ADMIN or WAREHOUSE.
   *
   * Runs as one transaction: it appends a RECEIPT movement per line and
   * increments the matching on-hand row. Either the whole receipt lands or none
   * of it does. Rejects over-receipt with an OVER_RECEIPT error.
   */
  receivePurchaseOrder: ReceivePurchaseOrderResult;
  /**
   * Exchange the refresh cookie for a new access token and a new refresh token.
   *
   * The presented refresh token is retired in the same transaction that issues
   * its replacement. Presenting an already-retired token is treated as theft and
   * revokes every session descended from that sign-in.
   */
  refreshSession: AuthPayload;
  /** Soft-deletes a purchase order. Requires ADMIN. Refuses once anything has been received. */
  voidPurchaseOrder: PurchaseOrder;
};


export type MutationCreatePurchaseOrderArgs = {
  input: CreatePurchaseOrderInput;
};


export type MutationLoginArgs = {
  input: LoginInput;
};


export type MutationReceivePurchaseOrderArgs = {
  input: ReceivePurchaseOrderInput;
};


export type MutationVoidPurchaseOrderArgs = {
  id: Scalars['ID']['input'];
};

/**
 * Page of results, keyset-paginated.
 *
 * There are no page numbers: cursors walk forward from where you are, which is a
 * single index seek at any depth and stays stable when rows are inserted while
 * someone is paging. `totalCount` is still provided so the UI can say "1-20 of 47".
 */
export type PageInfo = {
  /** Opaque. Pass it as `after` to fetch the next page. */
  endCursor: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
};

/**
 * A single access right, such as `stock:receive`.
 *
 * Permissions are the unit of authorisation: every guarded resolver checks one,
 * and nothing in the API branches on a role.
 */
export type Permission = {
  description: Scalars['String']['output'];
  key: Scalars['String']['output'];
};

export type Product = {
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  sku: Scalars['String']['output'];
  /** On-hand quantity per location for this product. */
  stockOnHand: Array<StockOnHand>;
  unit: Scalars['String']['output'];
};

export type PurchaseOrder = {
  createdAt: Scalars['DateTime']['output'];
  createdBy: User;
  id: Scalars['ID']['output'];
  lines: Array<PurchaseOrderLine>;
  /** Default receiving location. A receipt may override it. */
  location: Location;
  notes: Maybe<Scalars['String']['output']>;
  poNumber: Scalars['String']['output'];
  status: PurchaseOrderStatus;
  /** Sum of all line totals. */
  totalCostCents: Scalars['Int']['output'];
  totalOrdered: Scalars['Int']['output'];
  totalReceived: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
  vendor: Vendor;
};

export type PurchaseOrderConnection = {
  nodes: Array<PurchaseOrder>;
  pageInfo: PageInfo;
  /** Total matching the filter, ignoring pagination. */
  totalCount: Scalars['Int']['output'];
};

/**
 * Every field is optional and they combine with AND. All filtering happens in
 * SQL -- nothing is fetched and narrowed in memory.
 */
export type PurchaseOrderFilter = {
  locationId?: InputMaybe<Scalars['ID']['input']>;
  /** Case-insensitive substring of the PO number. */
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<PurchaseOrderStatus>;
  vendorId?: InputMaybe<Scalars['ID']['input']>;
};

export type PurchaseOrderLine = {
  id: Scalars['ID']['output'];
  /** unitCostCents * quantityOrdered. */
  lineTotalCents: Scalars['Int']['output'];
  product: Product;
  quantityOrdered: Scalars['Int']['output'];
  /** quantityOrdered - quantityReceived, floored at zero. */
  quantityOutstanding: Scalars['Int']['output'];
  /** SUM of RECEIPT movements against this line. Computed, not stored. */
  quantityReceived: Scalars['Int']['output'];
  /** Receipt history for this line, newest first. */
  receipts: Array<StockMovement>;
  unitCostCents: Scalars['Int']['output'];
};

/**
 * Derived from received quantities, never stored. A PO with nothing received is
 * OPEN, one fully satisfied is RECEIVED, anything in between is PARTIAL.
 */
export type PurchaseOrderStatus =
  | 'OPEN'
  | 'PARTIAL'
  | 'RECEIVED';

export type Query = {
  locations: Array<Location>;
  /** The signed-in user, or null when the request carries no valid access token. */
  me: Maybe<User>;
  /** The full permission catalogue, for building a role editor. */
  permissions: Array<Permission>;
  products: Array<Product>;
  purchaseOrder: Maybe<PurchaseOrder>;
  /**
   * Purchase orders, newest first.
   *
   * `first` defaults to 20 and is capped at 100. Pass `pageInfo.endCursor` back as
   * `after` to walk forward.
   */
  purchaseOrders: PurchaseOrderConnection;
  /** Every role defined in this install. Requires the `role:manage` permission. */
  roles: Array<Role>;
  /** On-hand stock across every product/location pair, ordered by SKU. */
  stockOnHand: StockOnHandConnection;
  vendors: Array<Vendor>;
};


export type QueryPurchaseOrderArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPurchaseOrdersArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  filter?: InputMaybe<PurchaseOrderFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryStockOnHandArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  filter?: InputMaybe<StockOnHandFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
};

export type ReceiveLineInput = {
  purchaseOrderLineId: Scalars['ID']['input'];
  /** Must be positive and cannot exceed the line's outstanding quantity. */
  quantity: Scalars['Int']['input'];
};

export type ReceivePurchaseOrderInput = {
  lines: Array<ReceiveLineInput>;
  /** Overrides the PO's default receiving location for this receipt. */
  locationId?: InputMaybe<Scalars['ID']['input']>;
  purchaseOrderId: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type ReceivePurchaseOrderResult = {
  /** The ledger rows this receipt created. */
  movements: Array<StockMovement>;
  purchaseOrder: PurchaseOrder;
};

/**
 * A named bundle of permissions.
 *
 * A role grants no capability of its own. It exists so access can be handed out
 * in meaningful groups and changed without a deploy -- inventing a "goods-in"
 * role that grants `stock:receive` needs no code change.
 */
export type Role = {
  description: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  /** Shipped with the product and undeletable. */
  isSystem: Scalars['Boolean']['output'];
  key: Scalars['String']['output'];
  name: Scalars['String']['output'];
  permissions: Array<Permission>;
};

/** A single immutable entry in the stock ledger. */
export type StockMovement = {
  createdAt: Scalars['DateTime']['output'];
  createdBy: User;
  id: Scalars['ID']['output'];
  location: Location;
  product: Product;
  /** Signed. Positive adds to on-hand, negative removes. */
  quantity: Scalars['Int']['output'];
  reason: Maybe<Scalars['String']['output']>;
  type: MovementType;
};

export type StockOnHand = {
  id: Scalars['ID']['output'];
  location: Location;
  product: Product;
  quantity: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type StockOnHandConnection = {
  nodes: Array<StockOnHand>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type StockOnHandFilter = {
  /** Hides rows that have fallen to zero. */
  inStockOnly?: InputMaybe<Scalars['Boolean']['input']>;
  locationId?: InputMaybe<Scalars['ID']['input']>;
  productId?: InputMaybe<Scalars['ID']['input']>;
  /** Case-insensitive substring of SKU or product name. */
  search?: InputMaybe<Scalars['String']['input']>;
};

/** The organisation a user belongs to. All their data lives inside it. */
export type Tenant = {
  /**
   * Feature keys switched on for this organisation. Absent means off, so the UI
   * should treat anything not listed as unavailable rather than assuming.
   */
  features: Array<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  slug: Scalars['String']['output'];
};

/**
 * A person who can sign in. Identity lives in this domain; purchasing references
 * it for attribution (who raised a PO, who received stock).
 */
export type User = {
  email: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  /**
   * Effective permissions: the union across every role held. This is what the UI
   * should branch on, never a role key.
   */
  permissions: Array<Scalars['String']['output']>;
  /** Every role held. A user may hold several. */
  roles: Array<Role>;
  /** The organisation this user belongs to. */
  tenant: Tenant;
};

export type Vendor = {
  code: Scalars['String']['output'];
  email: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

export type PurchaseOrderSummaryFragment = { id: string, poNumber: string, status: PurchaseOrderStatus, totalOrdered: number, totalReceived: number, totalCostCents: number, createdAt: string, vendor: { id: string, name: string, code: string }, location: { id: string, code: string, name: string } };

export type PurchaseOrdersQueryVariables = Exact<{
  filter?: InputMaybe<PurchaseOrderFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type PurchaseOrdersQuery = { purchaseOrders: { totalCount: number, pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<{ id: string, poNumber: string, status: PurchaseOrderStatus, totalOrdered: number, totalReceived: number, totalCostCents: number, createdAt: string, vendor: { id: string, name: string, code: string }, location: { id: string, code: string, name: string } }> } };

export type PurchaseOrderQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type PurchaseOrderQuery = { purchaseOrder: { notes: string | null, id: string, poNumber: string, status: PurchaseOrderStatus, totalOrdered: number, totalReceived: number, totalCostCents: number, createdAt: string, createdBy: { id: string, name: string }, lines: Array<{ id: string, quantityOrdered: number, quantityReceived: number, quantityOutstanding: number, unitCostCents: number, lineTotalCents: number, product: { id: string, sku: string, name: string, unit: string }, receipts: Array<{ id: string, quantity: number, createdAt: string, reason: string | null, location: { id: string, code: string }, createdBy: { id: string, name: string } }> }>, vendor: { id: string, name: string, code: string }, location: { id: string, code: string, name: string } } | null };

export type FormOptionsQueryVariables = Exact<{ [key: string]: never; }>;


export type FormOptionsQuery = { vendors: Array<{ id: string, code: string, name: string }>, locations: Array<{ id: string, code: string, name: string }>, products: Array<{ id: string, sku: string, name: string, unit: string }> };

export type MeQueryVariables = Exact<{ [key: string]: never; }>;


export type MeQuery = { me: { id: string, name: string, email: string, permissions: Array<string>, tenant: { id: string, slug: string, name: string, features: Array<string> }, roles: Array<{ id: string, key: string, name: string }> } | null };

export type LoginMutationVariables = Exact<{
  input: LoginInput;
}>;


export type LoginMutation = { login: { expiresIn: number, user: { id: string, name: string, email: string, permissions: Array<string>, tenant: { id: string, slug: string, name: string, features: Array<string> }, roles: Array<{ id: string, key: string, name: string }> } } };

export type RefreshSessionMutationVariables = Exact<{ [key: string]: never; }>;


export type RefreshSessionMutation = { refreshSession: { expiresIn: number, user: { id: string, name: string, email: string, permissions: Array<string>, tenant: { id: string, slug: string, name: string, features: Array<string> }, roles: Array<{ id: string, key: string, name: string }> } } };

export type LogoutMutationVariables = Exact<{ [key: string]: never; }>;


export type LogoutMutation = { logout: boolean };

export type StockOnHandQueryVariables = Exact<{
  filter?: InputMaybe<StockOnHandFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type StockOnHandQuery = { stockOnHand: { totalCount: number, pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<{ id: string, quantity: number, updatedAt: string, product: { id: string, sku: string, name: string }, location: { id: string, code: string, name: string } }> } };

export type CreatePurchaseOrderMutationVariables = Exact<{
  input: CreatePurchaseOrderInput;
}>;


export type CreatePurchaseOrderMutation = { createPurchaseOrder: { id: string, poNumber: string } };

export type ReceivePurchaseOrderMutationVariables = Exact<{
  input: ReceivePurchaseOrderInput;
}>;


export type ReceivePurchaseOrderMutation = { receivePurchaseOrder: { purchaseOrder: { id: string, poNumber: string, status: PurchaseOrderStatus, totalReceived: number }, movements: Array<{ id: string, quantity: number, createdAt: string }> } };
