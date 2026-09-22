import type { User } from '@prisma/client';
import { z } from 'zod';
import { unauthenticated } from '../../shared/errors.js';
import { hashPassword, verifyPassword } from '../../shared/password.js';
import { live, prisma } from '../../shared/prisma.js';
import {
  accessTokenTtlSeconds,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenTtlSeconds,
  signAccessToken,
} from '../../shared/tokens.js';

/**
 * Login, refresh with rotation, and logout.
 *
 * The interesting part is `refresh`: every use retires the presented token and
 * issues a new one, and presenting an already-retired token is treated as
 * theft. See the comment there.
 */

export interface SessionContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface IssuedSession {
  user: User;
  accessToken: string;
  /** Returned to the caller once, then only its hash exists. */
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login(rawInput: unknown, context: SessionContext): Promise<IssuedSession> {
  const parsed = loginSchema.safeParse(rawInput);
  // Even a malformed email gets the generic failure: distinguishing "not an
  // email" from "wrong password" tells an attacker which half to vary.
  if (!parsed.success) throw invalidCredentials();

  const { email, password } = parsed.data;
  const user = await prisma.user.findFirst({ where: { email, ...live } });

  // Always run a verification, even when the user does not exist, so the
  // response time does not reveal which emails are registered.
  const storedHash = user?.passwordHash ?? DUMMY_HASH;
  const passwordMatches = await verifyPassword(password, storedHash);

  if (!user || !passwordMatches) throw invalidCredentials();

  return issueSession(user, crypto.randomUUID(), context);
}

/**
 * A structurally valid hash that nothing can match, used to keep the timing of
 * "no such user" close to "wrong password". Generated once at module load.
 */
const DUMMY_HASH = await hashPassword(generateRefreshToken());

const invalidCredentials = () => unauthenticated('Email or password is incorrect.');

// ---------------------------------------------------------------------------
// Refresh, with rotation and reuse detection
// ---------------------------------------------------------------------------

export async function refresh(
  presentedToken: string | null,
  context: SessionContext,
): Promise<IssuedSession> {
  if (!presentedToken) throw unauthenticated('No refresh token.');

  const tokenHash = hashRefreshToken(presentedToken);

  // Claim the token with a conditional update: a compare-and-swap that only
  // succeeds if it is still unrotated, unrevoked and unexpired. Doing it as one
  // statement is what makes concurrent refreshes safe -- exactly one caller can
  // win, because only one UPDATE can find `rotated_at IS NULL`.
  //
  // This deliberately does NOT run inside a transaction that later throws.
  // Reuse detection has to revoke the token family and then reject the caller,
  // and a rollback would undo the revocation it just wrote -- the detection
  // would fire and leave the stolen session working.
  const claimed = await prisma.refreshToken.updateMany({
    where: {
      tokenHash,
      rotatedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { rotatedAt: new Date() },
  });

  if (claimed.count === 0) {
    await rejectUnclaimableToken(tokenHash);
  }

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  // Unreachable in practice: the claim above succeeded, so the row exists.
  if (!existing) throw unauthenticated('Session not recognised. Please sign in again.');

  if (existing.user.deletedAt) {
    await revokeFamily(existing.familyId);
    throw unauthenticated('This account is no longer active.');
  }

  return issueSession(existing.user, existing.familyId, context);
}

/**
 * Works out why a token could not be claimed, and reacts. Always throws.
 */
async function rejectUnclaimableToken(tokenHash: string): Promise<never> {
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { familyId: true, rotatedAt: true, revokedAt: true, expiresAt: true },
  });

  if (!row) throw unauthenticated('Session not recognised. Please sign in again.');

  // Reuse detection.
  //
  // A rotated token has already been exchanged, so the legitimate client holds
  // its replacement and has no reason to present this one. Seeing it again
  // means a copy leaked. We cannot tell the thief from the victim, so the whole
  // family -- every token descended from that sign-in -- is revoked and both
  // parties must sign in again. This is the entire reason rotation is worth
  // doing; without it a stolen token simply works until it expires.
  //
  // The cost is that a client refreshing twice concurrently looks identical to
  // theft. That is why the web client single-flights refreshes behind a mutex
  // (see web/src/lib/api.ts).
  if (row.rotatedAt) {
    await revokeFamily(row.familyId);
    throw unauthenticated('Session reuse detected. All sessions have been signed out.');
  }

  if (row.revokedAt) {
    throw unauthenticated('Session has been signed out. Please sign in again.');
  }

  throw unauthenticated('Session has expired. Please sign in again.');
}

function revokeFamily(familyId: string) {
  return prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Revokes the presented token's whole family, so signing out on one device ends
 * that login everywhere it was rotated to. Returns quietly for an unknown token:
 * logging out is idempotent and should never error.
 */
export async function logout(presentedToken: string | null): Promise<void> {
  if (!presentedToken) return;

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(presentedToken) },
    select: { familyId: true },
  });
  if (!existing) return;

  await prisma.refreshToken.updateMany({
    where: { familyId: existing.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Ends every session for a user, regardless of device. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

// ---------------------------------------------------------------------------

async function issueSession(
  user: User,
  familyId: string,
  context: SessionContext,
): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + refreshTokenTtlSeconds() * 1000),
      userAgent: context.userAgent?.slice(0, 400) ?? null,
      ipAddress: context.ipAddress?.slice(0, 64) ?? null,
    },
  });

  return {
    user,
    accessToken: await signAccessToken({ sub: user.id, role: user.role }),
    refreshToken,
    expiresIn: accessTokenTtlSeconds(),
    refreshExpiresIn: refreshTokenTtlSeconds(),
  };
}
