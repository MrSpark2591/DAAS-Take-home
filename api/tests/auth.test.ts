import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { login, logout, refresh, revokeAllSessions } from '../src/domains/auth/service.js';
import { PERMISSIONS } from '../src/shared/permissions.js';
import { verifyAccessToken } from '../src/shared/tokens.js';
import { FIXTURE_PASSWORD, type Fixtures, prisma, seedFixtures } from './helpers.js';

/**
 * Tests for the session lifecycle, aimed at the ways it could quietly fail
 * open: credentials that should not work, tokens that should stop working, and
 * the theft scenario rotation exists to catch.
 */

let fx: Fixtures;
const noContext = { userAgent: null, ipAddress: null };

beforeEach(async () => {
  fx = await seedFixtures();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('signing in', () => {
  it('issues an access token carrying effective permissions, not a role', async () => {
    const session = await login(
      { email: fx.warehouse.email, password: FIXTURE_PASSWORD },
      noContext,
    );

    const claims = await verifyAccessToken(session.accessToken);
    expect(claims?.sub).toBe(fx.warehouse.id);
    // The role key rides along for display and audit, but authorisation reads
    // the permissions -- so those are what must be in the token.
    expect(claims?.roles).toContain('warehouse');
    expect(claims?.permissions).toContain(PERMISSIONS.STOCK_RECEIVE);
    expect(claims?.permissions).not.toContain(PERMISSIONS.PURCHASE_ORDER_CREATE);
  });

  it('reflects a role’s permission change on the next sign-in', async () => {
    const before = await login({ email: fx.viewer.email, password: FIXTURE_PASSWORD }, noContext);
    const beforeClaims = await verifyAccessToken(before.accessToken);
    expect(beforeClaims?.permissions).not.toContain(PERMISSIONS.STOCK_RECEIVE);

    // Grant the viewer role a new permission -- pure data, no deploy.
    const viewerRole = await prisma.role.findFirstOrThrow({ where: { key: 'viewer' } });
    const permission = await prisma.permission.findFirstOrThrow({
      where: { key: PERMISSIONS.STOCK_RECEIVE },
    });
    await prisma.rolePermission.create({
      data: { roleId: viewerRole.id, permissionId: permission.id },
    });

    try {
      const after = await login({ email: fx.viewer.email, password: FIXTURE_PASSWORD }, noContext);
      const afterClaims = await verifyAccessToken(after.accessToken);
      expect(afterClaims?.permissions).toContain(PERMISSIONS.STOCK_RECEIVE);
    } finally {
      // Shared reference data: leaving this behind would widen every later test.
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: viewerRole.id, permissionId: permission.id },
        },
      });
    }
  });

  it('rejects a wrong password and an unknown email identically', async () => {
    const wrongPassword = await login(
      { email: fx.admin.email, password: 'not-the-password' },
      noContext,
    ).catch((error: Error) => error.message);

    const unknownEmail = await login(
      { email: 'nobody@test.local', password: FIXTURE_PASSWORD },
      noContext,
    ).catch((error: Error) => error.message);

    // Identical wording on purpose: a different message for "no such user"
    // turns the login form into an account-enumeration oracle.
    expect(wrongPassword).toBe(unknownEmail);
    expect(wrongPassword).toMatch(/incorrect/i);
  });

  it('does not sign in a soft-deleted user', async () => {
    await prisma.user.update({
      where: { id: fx.viewer.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      login({ email: fx.viewer.email, password: FIXTURE_PASSWORD }, noContext),
    ).rejects.toThrow(/incorrect/i);
  });

  it('stores only a hash of the refresh token', async () => {
    const session = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);

    // The raw token must not be recoverable from the database.
    const stored = await prisma.refreshToken.findMany({ where: { userId: fx.admin.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(session.refreshToken);
    expect(stored[0]?.tokenHash).toHaveLength(64);
  });
});

describe('refreshing a session', () => {
  it('rotates the refresh token and keeps the user signed in', async () => {
    const first = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);
    const second = await refresh(first.refreshToken, noContext);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.user.id).toBe(fx.admin.id);

    // The replacement works, so the user never notices the rotation.
    const third = await refresh(second.refreshToken, noContext);
    expect(third.refreshToken).not.toBe(second.refreshToken);
  });

  it('treats a replayed token as theft and kills the whole family', async () => {
    const first = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);
    const second = await refresh(first.refreshToken, noContext);

    // The attacker replays the token they copied before it was rotated.
    await expect(refresh(first.refreshToken, noContext)).rejects.toThrow(/reuse detected/i);

    // And the victim's current token dies with it. Both parties must sign in
    // again, because there is no way to tell which one was the thief.
    await expect(refresh(second.refreshToken, noContext)).rejects.toThrow(/signed out/i);
  });

  it('rejects an expired refresh token', async () => {
    const session = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);

    // Both timestamps move: the `expires_at > created_at` check constraint
    // rejects a row that expired before it was issued, so the token has to be
    // aged rather than just given a past expiry.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await prisma.refreshToken.updateMany({
      where: { userId: fx.admin.id },
      data: { createdAt: twoDaysAgo, expiresAt: dayAgo },
    });

    await expect(refresh(session.refreshToken, noContext)).rejects.toThrow(/expired/i);
  });

  it('rejects a token that was never issued', async () => {
    await expect(refresh('completely-made-up-token', noContext)).rejects.toThrow(/not recognised/i);
  });

  it('stops refreshing once the account is deactivated', async () => {
    const session = await login({ email: fx.viewer.email, password: FIXTURE_PASSWORD }, noContext);

    await prisma.user.update({ where: { id: fx.viewer.id }, data: { deletedAt: new Date() } });

    // The access token stays valid until it expires -- that is the accepted
    // cost of stateless tokens -- but the session cannot be extended.
    await expect(refresh(session.refreshToken, noContext)).rejects.toThrow(/no longer active/i);
  });

  it('serialises concurrent refreshes so only one can win', async () => {
    const session = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);

    // Two requests race with the same token. The conditional update means
    // exactly one claims it; the loser is treated as reuse. This is precisely
    // why the web client single-flights refreshes behind a mutex.
    const results = await Promise.allSettled([
      refresh(session.refreshToken, noContext),
      refresh(session.refreshToken, noContext),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('signing out', () => {
  it('revokes every token rotated from that sign-in', async () => {
    const first = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);
    const second = await refresh(first.refreshToken, noContext);

    await logout(second.refreshToken);

    await expect(refresh(second.refreshToken, noContext)).rejects.toThrow(/signed out/i);
  });

  it('is idempotent and never throws on an unknown token', async () => {
    await expect(logout('never-issued')).resolves.toBeUndefined();
    await expect(logout(null)).resolves.toBeUndefined();
  });

  it('leaves other devices alone', async () => {
    // Two separate sign-ins are two separate families.
    const phone = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);
    const laptop = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);

    await logout(phone.refreshToken);

    await expect(refresh(laptop.refreshToken, noContext)).resolves.toBeDefined();
  });

  it('can end every session for a user at once', async () => {
    const phone = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);
    const laptop = await login({ email: fx.admin.email, password: FIXTURE_PASSWORD }, noContext);

    const revoked = await revokeAllSessions(fx.admin.id);
    expect(revoked).toBe(2);

    await expect(refresh(phone.refreshToken, noContext)).rejects.toThrow(/signed out/i);
    await expect(refresh(laptop.refreshToken, noContext)).rejects.toThrow(/signed out/i);
  });
});
