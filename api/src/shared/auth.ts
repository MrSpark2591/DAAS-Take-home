import type { Role } from '@prisma/client';
import { forbidden, unauthenticated } from './errors.js';
import { verifyAccessToken } from './tokens.js';

/**
 * Authentication and authorisation.
 *
 * Authentication is a signed JWT (HS256) carrying the subject and role, valid
 * for 15 minutes. It is verified by signature alone -- no database round trip
 * on the hot path -- which is exactly why it is short-lived: a stateless token
 * cannot be revoked, so the expiry window bounds the damage. Longer-lived
 * sessions come from rotating refresh tokens, which are stateful and revocable
 * (see `domains/auth/service.ts`).
 *
 * Authorisation is `requireRole`, and nothing inspects `actor.role` directly.
 */

export interface Actor {
  id: string;
  role: Role;
}

/**
 * Resolves the actor for a request, or null when it carries no usable access
 * token. Never throws: an expired token is indistinguishable from no token as
 * far as the schema is concerned, and the client's answer to both is the same
 * -- call `refreshSession` and retry.
 */
export async function resolveActor(accessToken: string | null): Promise<Actor | null> {
  if (!accessToken) return null;

  const claims = await verifyAccessToken(accessToken);
  if (!claims) return null;

  return { id: claims.sub, role: claims.role };
}

/** Pulls a bearer token out of an Authorization header, if present. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * The single authorisation gate. Every guarded resolver calls this, so there is
 * exactly one place to audit and one place to change when roles grow into
 * permissions.
 */
export function requireRole(actor: Actor | null, allowed: readonly Role[]): Actor {
  if (!actor) throw unauthenticated();

  if (!allowed.includes(actor.role)) {
    throw forbidden(
      `Your role (${actor.role}) cannot perform this action. Requires: ${allowed.join(' or ')}.`,
      allowed,
    );
  }

  return actor;
}

/** Role sets, named by intent so resolvers read as policy rather than plumbing. */
export const CAN_RECEIVE_STOCK: readonly Role[] = ['ADMIN', 'WAREHOUSE'];
export const CAN_MANAGE_PURCHASE_ORDERS: readonly Role[] = ['ADMIN'];
export const CAN_READ: readonly Role[] = ['ADMIN', 'WAREHOUSE', 'VIEWER'];
