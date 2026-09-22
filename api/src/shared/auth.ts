import type { Role } from '@prisma/client';
import { forbidden, unauthenticated } from './errors.js';

/**
 * Deliberately minimal auth: a bearer token that carries a user id and a role.
 *
 *   daas_<base64url({"sub": "<uuid>", "role": "WAREHOUSE"})>
 *
 * There is no signature, so this is a stand-in for a real IdP, not a security
 * boundary -- anyone can mint one. It exists so the slice can demonstrate the
 * thing that *does* matter here: that authorisation is enforced in one place on
 * the server and the UI only mirrors it. Swapping this for a verified JWT means
 * replacing `parseBearerToken` and nothing else; every caller goes through
 * `requireRole`, which keeps working unchanged.
 */

export interface Actor {
  id: string;
  role: Role;
}

const TOKEN_PREFIX = 'daas_';

export function mintToken(actor: Actor): string {
  const payload = JSON.stringify({ sub: actor.id, role: actor.role });
  return TOKEN_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Returns the actor for an Authorization header, or null when the request is
 * anonymous. Throws only when a token is present but unusable, so that
 * "no token" and "broken token" are distinguishable to the caller.
 */
export function parseBearerToken(header: string | undefined): Actor | null {
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return null;

  const raw = match[1];
  if (!raw.startsWith(TOKEN_PREFIX)) {
    throw unauthenticated('Malformed bearer token.');
  }

  // Decode and parse first; validate after, so a malformed payload and an
  // undecodable token produce different messages.
  let parsed: unknown;
  try {
    const json = Buffer.from(raw.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw unauthenticated('Bearer token could not be decoded.');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { sub?: unknown }).sub !== 'string' ||
    !isRole((parsed as { role?: unknown }).role)
  ) {
    throw unauthenticated('Bearer token is missing a subject or role.');
  }

  const claims = parsed as { sub: string; role: Role };
  return { id: claims.sub, role: claims.role };
}

function isRole(value: unknown): value is Role {
  return value === 'ADMIN' || value === 'WAREHOUSE' || value === 'VIEWER';
}

/**
 * The single authorisation gate. Every guarded resolver calls this; nothing
 * inspects `actor.role` directly, so there is exactly one place to audit and
 * one place to change when roles grow into permissions.
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
