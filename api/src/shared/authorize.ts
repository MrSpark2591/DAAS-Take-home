import type { GraphQLSchema } from 'graphql';
import type { Actor } from './auth.js';
import { forbidden, unauthenticated } from './errors.js';
import { PERMISSIONS, type Permission } from './permissions.js';

/**
 * Default-deny authorisation for every root field.
 *
 * Guards used to be written inline in each resolver, which meant the enforcement
 * was only as good as the author's memory. It was not: every read query shipped
 * unguarded and was readable anonymously, while the mutations beside them were
 * correctly locked down. Nothing failed, because nothing was checking that a
 * check existed.
 *
 * So the policy is declared here, in one table, and applied by wrapping the
 * schema's root resolvers. `assertPolicyIsComplete` then runs at boot and
 * refuses to start if any Query or Mutation field is missing from the table --
 * a new resolver cannot be reached until someone has decided who may call it.
 * Forgetting is a startup crash, not a silent hole.
 */

/** Reachable without a session. Each entry needs a reason. */
type Policy = Permission | 'PUBLIC' | 'AUTHENTICATED';

const POLICY: Record<string, Policy> = {
  // --- Authentication. Necessarily reachable while signed out. ---------------
  login: 'PUBLIC',
  // Presenting the refresh cookie IS the credential; it is verified in the
  // service, which is why this is not an unauthenticated hole.
  refreshSession: 'PUBLIC',
  // Idempotent and safe: with no valid session it clears cookies and returns.
  logout: 'PUBLIC',
  // The catalogue of permission keys. Knowing the names reveals nothing about
  // who holds them, and a login screen may need it before a session exists.
  permissions: 'PUBLIC',

  // --- Identity -------------------------------------------------------------
  me: 'AUTHENTICATED',
  roles: PERMISSIONS.ROLE_MANAGE,

  // --- Purchasing reads -----------------------------------------------------
  purchaseOrders: PERMISSIONS.PURCHASE_ORDER_READ,
  purchaseOrder: PERMISSIONS.PURCHASE_ORDER_READ,
  // Reference data, but it is still commercial information: vendor contacts and
  // the product catalogue are not public.
  vendors: PERMISSIONS.PURCHASE_ORDER_READ,
  products: PERMISSIONS.PURCHASE_ORDER_READ,
  // Locations are needed by the receive dialog as well as the create form, so
  // they sit behind the read permission every role that needs them holds.
  locations: PERMISSIONS.STOCK_READ,
  stockOnHand: PERMISSIONS.STOCK_READ,

  // --- Purchasing writes ----------------------------------------------------
  createPurchaseOrder: PERMISSIONS.PURCHASE_ORDER_CREATE,
  receivePurchaseOrder: PERMISSIONS.STOCK_RECEIVE,
  voidPurchaseOrder: PERMISSIONS.PURCHASE_ORDER_VOID,
};

/** Introspection meta-fields, which the schema provides rather than us. */
const META_FIELDS = new Set(['__schema', '__type', '__typename']);

export function policyFor(fieldName: string): Policy | undefined {
  return POLICY[fieldName];
}

/**
 * Enforces the policy for one root field. Exported so the resolver wrapper and
 * the tests exercise exactly the same code path.
 */
export function enforcePolicy(fieldName: string, actor: Actor | null): void {
  const policy = POLICY[fieldName];

  // Unreachable once `assertPolicyIsComplete` has run at boot, but denying by
  // default here means a field added at runtime still cannot slip through.
  if (!policy) {
    throw forbidden(`No authorisation policy is defined for "${fieldName}".`);
  }

  if (policy === 'PUBLIC') return;
  if (!actor) throw unauthenticated();
  if (policy === 'AUTHENTICATED') return;

  if (!actor.permissions.has(policy)) {
    throw forbidden(`This action requires the "${policy}" permission.`, [policy]);
  }
}

/**
 * Fails at boot if any root field has no policy.
 *
 * This is the part that makes the design hold: without it, the table is just
 * another thing to remember to update.
 */
export function assertPolicyIsComplete(schema: GraphQLSchema): void {
  const missing: string[] = [];

  for (const rootType of [schema.getQueryType(), schema.getMutationType()]) {
    if (!rootType) continue;
    for (const fieldName of Object.keys(rootType.getFields())) {
      if (META_FIELDS.has(fieldName)) continue;
      if (!POLICY[fieldName]) missing.push(`${rootType.name}.${fieldName}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Authorisation policy is incomplete. Add an entry to src/shared/authorize.ts for:\n` +
        missing.map((field) => `  - ${field}`).join('\n'),
    );
  }
}
