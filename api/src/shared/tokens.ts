import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@prisma/client';
import { jwtVerify, SignJWT } from 'jose';
import { readInt } from './env.js';

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
  role: Role;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return await new SignJWT({ role: claims.role })
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

    const role = payload.role;
    if (typeof payload.sub !== 'string' || !isRole(role)) return null;

    return { sub: payload.sub, role };
  } catch {
    return null;
  }
}

function isRole(value: unknown): value is Role {
  return value === 'ADMIN' || value === 'WAREHOUSE' || value === 'VIEWER';
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
