import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { readInt } from './env.js';
import { isPermission, type Permission } from './permissions.js';

/**
 * Token primitives. Deliberately two different shapes:
 *
 *   Access  -- a signed JWT. Verified by signature alone, so the hot path (every
 *              query and mutation) costs no database round trip. Short-lived,
 *              because a stateless token cannot be revoked.
 *   Refresh -- opaque random bytes. It must be revocable, which makes it
 *              stateful regardless, so signing it would buy nothing. Only its
 *              SHA-256 hash is stored.
 */

const ISSUER = 'daas-api';
const AUDIENCE = 'daas-web';

/**
 * Read at call time, not at module load. A module-level const would capture
 * whatever `process.env` held the instant this file was first imported, which
 * depends on import order -- and would quietly use the default if `.env` had
 * not been loaded yet.
 */

/** Short by design: this is the window in which a stolen access token works. */
export const accessTokenTtlSeconds = () => readInt('ACCESS_TOKEN_TTL_SECONDS', 900);

/** How long a session survives without re-entering a password. */
export const refreshTokenTtlSeconds = () => readInt('REFRESH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30);

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters. See api/.env.example.');
  }
  return new TextEncoder().encode(value);
}

export interface AccessTokenClaims {
  sub: string;
  /**
   * The user's effective permissions, flattened from every role they hold.
   *
   * Carrying these in the token is what keeps authorisation free of a database
   * round trip. The cost is that a permission change takes effect on the next
   * access token, not instantly -- the same bounded staleness already accepted
   * for the session itself, and the reason the access TTL is short.
   */
  permissions: Permission[];
  /** Carried for display and audit only. Nothing authorises on a role key. */
  roles: string[];
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return await new SignJWT({ perms: claims.permissions, roles: claims.roles })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${accessTokenTtlSeconds()}s`)
    .sign(secret());
}

/**
 * Returns the claims, or null for any token that is not currently valid --
 * bad signature, expired, wrong issuer or audience. Callers treat null as
 * "anonymous" rather than distinguishing the reasons, which keeps the failure
 * modes from leaking to an attacker.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });

    if (typeof payload.sub !== 'string') return null;

    // Unknown permission strings are dropped rather than trusted. A token minted
    // before a permission was renamed should lose that grant, not carry a claim
    // nothing in this build understands.
    const permissions = Array.isArray(payload.perms) ? payload.perms.filter(isPermission) : [];
    const roles = Array.isArray(payload.roles)
      ? payload.roles.filter((role): role is string => typeof role === 'string')
      : [];

    return { sub: payload.sub, permissions, roles };
  } catch {
    return null;
  }
}

/** 256 bits of entropy, url-safe. Returned to the client exactly once. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Refresh tokens are looked up by hash, so this is a fast digest rather than a
 * password KDF. That is correct here: the input is 256 random bits, so there is
 * no dictionary to attack and nothing for a slow hash to defend against.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
