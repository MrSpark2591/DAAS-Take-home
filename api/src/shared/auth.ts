import { forbidden, unauthenticated } from './errors.js';
import type { Permission } from './permissions.js';
import { verifyAccessToken } from './tokens.js';

/**
 * Authentication and authorisation.
 *
 * Authentication is a signed JWT (HS256), valid for 15 minutes and verified by
 * signature alone -- no database round trip on the hot path. That is exactly
 * why it is short-lived: a stateless token cannot be revoked, so the expiry
 * window bounds the damage. Longer sessions come from rotating refresh tokens,
 * which are stateful and revocable (see `domains/auth/service.ts`).
 *
 * Authorisation is by **permission**, never by role. Roles are named bundles of
 * permissions and exist so access can be granted in meaningful groups; nothing
 * here branches on a role key, which is what lets an operator invent a new role
 * without a code change.
 */

export interface Actor {
  id: string;
  /** Effective permissions: the union across every role the user holds. */
  permissions: ReadonlySet<Permission>;
  /** For display and audit. Deliberately not consulted when authorising. */
  roles: readonly string[];
}

/**
 * Resolves the actor for a request, or null when it carries no usable access
 * token. Never throws: an expired token is indistinguishable from no token as
 * far as the schema is concerned, and the client's response to both is the same
 * -- call `refreshSession` and retry.
 */
export async function resolveActor(accessToken: string | null): Promise<Actor | null> {
  if (!accessToken) return null;

  const claims = await verifyAccessToken(accessToken);
  if (!claims) return null;

  return {
    id: claims.sub,
    permissions: new Set(claims.permissions),
    roles: claims.roles,
  };
}

/** Pulls a bearer token out of an Authorization header, if present. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/** Non-throwing check, for resolvers that shape a response rather than reject. */
export function can(actor: Actor | null, permission: Permission): boolean {
  return actor?.permissions.has(permission) ?? false;
}

/**
 * The single authorisation gate. Every guarded resolver calls this, so there is
 * exactly one place to audit and one place to change.
 *
 * The error names the missing permission rather than a role, because that is
 * the thing an administrator has to grant to fix it.
 */
export function requirePermission(actor: Actor | null, permission: Permission): Actor {
  if (!actor) throw unauthenticated();

  if (!actor.permissions.has(permission)) {
    throw forbidden(`This action requires the "${permission}" permission.`, [permission]);
  }

  return actor;
}

/** Requires every listed permission. Used where an action spans two resources. */
export function requireAllPermissions(
  actor: Actor | null,
  permissions: readonly Permission[],
): Actor {
  if (!actor) throw unauthenticated();

  const missing = permissions.filter((permission) => !actor.permissions.has(permission));
  if (missing.length > 0) {
    throw forbidden(
      `This action requires the ${missing.map((p) => `"${p}"`).join(' and ')} permission${
        missing.length > 1 ? 's' : ''
      }.`,
      missing,
    );
  }

  return actor;
}
