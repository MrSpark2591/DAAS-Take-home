/**
 * The permission catalogue.
 *
 * Permissions are defined in code because the code is what checks them: a
 * permission the application never asks about is dead data, and a permission
 * the application asks about but the database has never heard of is a bug that
 * should fail at build time, not at 2am. The rows in `permissions` are seeded
 * from this list.
 *
 * What is *data*, and therefore editable without a deploy, is the mapping from
 * roles to permissions. That is the whole point of the split: a role is a named
 * bundle, not a hard-coded capability.
 *
 * Naming is `resource:action`, lower snake for the resource. Keep it coarse
 * enough to stay readable in a UI and fine enough that a role can be assembled
 * without granting more than intended.
 *
 * Every entry here gates a real operation. A permission that grants nothing is
 * worse than an absent one: it advertises a capability that does not exist, and
 * an administrator who grants it has been misled about what they just allowed.
 * `assertPolicyIsComplete` catches the opposite mistake -- an operation with no
 * permission -- at boot.
 */

export const PERMISSIONS = {
  PURCHASE_ORDER_READ: 'purchase_order:read',
  PURCHASE_ORDER_CREATE: 'purchase_order:create',
  PURCHASE_ORDER_VOID: 'purchase_order:void',
  STOCK_READ: 'stock:read',
  STOCK_RECEIVE: 'stock:receive',
  ROLE_MANAGE: 'role:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  [PERMISSIONS.PURCHASE_ORDER_READ]: 'View purchase orders and their lines',
  [PERMISSIONS.PURCHASE_ORDER_CREATE]: 'Raise new purchase orders',
  [PERMISSIONS.PURCHASE_ORDER_VOID]: 'Void a purchase order that has no receipts',
  [PERMISSIONS.STOCK_READ]: 'View on-hand stock and the movement ledger',
  [PERMISSIONS.STOCK_RECEIVE]: 'Receive stock against a purchase order',
  [PERMISSIONS.ROLE_MANAGE]: 'Create roles and change what they grant',
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

/**
 * Roles shipped with the product.
 *
 * `isSystem` marks these as undeletable — an install with no admin role is
 * unrecoverable. Everything else about them, including which permissions they
 * grant, is ordinary data that an operator can change.
 */
export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Full access, including raising and voiding purchase orders.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'warehouse',
    name: 'Warehouse',
    description: 'Receives deliveries and moves stock. Cannot raise purchase orders.',
    permissions: [
      PERMISSIONS.PURCHASE_ORDER_READ,
      PERMISSIONS.STOCK_READ,
      PERMISSIONS.STOCK_RECEIVE,
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to purchase orders and stock.',
    permissions: [PERMISSIONS.PURCHASE_ORDER_READ, PERMISSIONS.STOCK_READ],
  },
];

/** Narrows an arbitrary string from a token or the database to a known permission. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value);
}
