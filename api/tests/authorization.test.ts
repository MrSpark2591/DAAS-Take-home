import { makeExecutableSchema } from '@graphql-tools/schema';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/shared/auth.js';
import { assertPolicyIsComplete, enforcePolicy, policyFor } from '../src/shared/authorize.js';
import { PERMISSIONS, type Permission } from '../src/shared/permissions.js';

/**
 * The API is the authorisation boundary; the UI only mirrors it. These tests
 * are about the boundary holding for the cases that actually went wrong:
 * a read query nobody remembered to guard, and a new field added later.
 */

const actorWith = (...permissions: Permission[]): Actor => ({
  id: 'test-user',
  tenantId: 'test-tenant',
  permissions: new Set(permissions),
  roles: ['test'],
});

/** Every root field the schema exposes, so a new one cannot be forgotten here. */
const READ_FIELDS = ['purchaseOrders', 'purchaseOrder', 'vendors', 'products', 'stockOnHand'];
const WRITE_FIELDS = ['createPurchaseOrder', 'receivePurchaseOrder', 'voidPurchaseOrder'];

describe('the API refuses anonymous access to business data', () => {
  it.each([...READ_FIELDS, ...WRITE_FIELDS, 'locations', 'me', 'roles'])(
    'rejects an anonymous caller on %s',
    (field) => {
      expect(() => enforcePolicy(field, null)).toThrowError(/sign in/i);
    },
  );

  it('does not gate the operations needed to obtain a session', () => {
    // Blocking these would make signing in impossible.
    for (const field of ['login', 'refreshSession', 'logout', 'permissions']) {
      expect(() => enforcePolicy(field, null)).not.toThrow();
    }
  });
});

describe('permission gating per field', () => {
  it('rejects a signed-in user who lacks the permission', () => {
    const readOnly = actorWith(PERMISSIONS.PURCHASE_ORDER_READ, PERMISSIONS.STOCK_READ);

    expect(() => enforcePolicy('receivePurchaseOrder', readOnly)).toThrowError(
      /requires the "stock:receive" permission/i,
    );
    expect(() => enforcePolicy('createPurchaseOrder', readOnly)).toThrowError(
      /purchase_order:create/,
    );
  });

  it('allows a user holding exactly the required permission', () => {
    expect(() =>
      enforcePolicy('receivePurchaseOrder', actorWith(PERMISSIONS.STOCK_RECEIVE)),
    ).not.toThrow();

    expect(() =>
      enforcePolicy('purchaseOrders', actorWith(PERMISSIONS.PURCHASE_ORDER_READ)),
    ).not.toThrow();
  });

  it('gates reads behind read permissions rather than leaving them open', () => {
    // The bug this replaced: these were reachable with no session at all.
    const nobody = actorWith();

    for (const field of READ_FIELDS) {
      expect(() => enforcePolicy(field, nobody)).toThrowError(/requires the/i);
    }
  });

  it('needs a session but no particular permission for `me`', () => {
    expect(() => enforcePolicy('me', null)).toThrowError(/sign in/i);
    expect(() => enforcePolicy('me', actorWith())).not.toThrow();
  });
});

describe('default deny', () => {
  it('rejects a field that has no policy entry', () => {
    // Not "allow because nobody said otherwise".
    expect(() =>
      enforcePolicy('somethingNobodyMapped', actorWith(...Object.values(PERMISSIONS))),
    ).toThrowError(/no authorisation policy is defined/i);
  });

  it('has a policy for every root field the real schema exposes', async () => {
    const { schema } = await import('../src/schema.js');
    expect(() => assertPolicyIsComplete(schema)).not.toThrow();
  });

  it('refuses to start when a new root field has no policy', () => {
    // The failure mode that let unguarded reads ship: a resolver added, and
    // nobody remembering that authorisation is a separate step.
    const schema = makeExecutableSchema({
      typeDefs: `type Query { existingThing: String, brandNewThing: String }`,
    });

    expect(() => assertPolicyIsComplete(schema)).toThrowError(/Query.brandNewThing/);
  });

  it('exposes the policy so it can be reviewed in one place', () => {
    expect(policyFor('stockOnHand')).toBe(PERMISSIONS.STOCK_READ);
    expect(policyFor('login')).toBe('PUBLIC');
    expect(policyFor('nothing')).toBeUndefined();
  });
});
