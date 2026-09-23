import type { Role as RoleRow, User as UserRow } from '@prisma/client';
import type { GraphQLContext } from '../../context.js';
import { requirePermission } from '../../shared/auth.js';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS, type Permission } from '../../shared/permissions.js';
import { live } from '../../shared/prisma.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';
import * as service from './service.js';

/**
 * Thin, like the purchasing resolvers: translate to and from HTTP (cookies in,
 * cookies out) and delegate. The rotation and reuse rules live in `service.ts`.
 */
type Ctx = GraphQLContext;

export const resolvers = {
  Query: {
    // Resolved through the loader rather than the token, so a user renamed or
    // deleted mid-session reflects reality rather than stale claims.
    me: async (_p: unknown, _a: unknown, { actor, loaders }: Ctx) =>
      actor ? loaders.userById.load(actor.id) : null,

    roles: (_p: unknown, _a: unknown, { actor, db }: Ctx) => {
      requirePermission(actor, PERMISSIONS.ROLE_MANAGE);
      return db.role.findMany({ where: live, orderBy: { name: 'asc' } });
    },

    // Static catalogue, so no database round trip and no permission gate:
    // knowing what permissions exist reveals nothing about who holds them.
    permissions: () =>
      Object.values(PERMISSIONS).map((key) => ({
        key,
        description: PERMISSION_DESCRIPTIONS[key],
      })),
  },

  Mutation: {
    login: async (_p: unknown, args: { input: unknown }, ctx: Ctx) => {
      const session = await service.login(args.input, {
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
      });

      setSessionCookies(ctx.res, session);
      // Security-relevant: a burst of failures followed by a success is what an
      // account takeover looks like in the log.
      ctx.log.info({ event: 'auth.login', userId: session.user.id }, 'user signed in');
      return { user: session.user, expiresIn: session.expiresIn };
    },

    refreshSession: async (_p: unknown, _a: unknown, ctx: Ctx) => {
      try {
        const session = await service.refresh(ctx.refreshToken, {
          userAgent: ctx.userAgent,
          ipAddress: ctx.ipAddress,
        });

        setSessionCookies(ctx.res, session);
        ctx.log.debug({ event: 'auth.refresh', userId: session.user.id }, 'session refreshed');
        return { user: session.user, expiresIn: session.expiresIn };
      } catch (error) {
        // Any failed refresh ends the session in the browser too. Leaving a
        // dead cookie in place makes the client retry forever against a token
        // that will never work again.
        clearSessionCookies(ctx.res);

        // Reuse detection means a refresh token was replayed -- either a leak or
        // a client bug. Either way it warrants a louder line than an expiry.
        const message = error instanceof Error ? error.message : '';
        if (message.includes('reuse detected')) {
          ctx.log.warn(
            { event: 'auth.refresh_reuse' },
            'refresh token reuse detected; token family revoked',
          );
        }
        throw error;
      }
    },

    logout: async (_p: unknown, _a: unknown, ctx: Ctx) => {
      await service.logout(ctx.refreshToken);
      clearSessionCookies(ctx.res);
      ctx.log.info({ event: 'auth.logout' }, 'user signed out');
      return true;
    },
  },

  User: {
    roles: (user: UserRow, _a: unknown, { loaders }: Ctx) => loaders.rolesByUserId.load(user.id),

    permissions: async (user: UserRow, _a: unknown, { loaders }: Ctx) => {
      const roles = await loaders.rolesByUserId.load(user.id);
      const grants = await Promise.all(
        roles.map((role) => loaders.permissionsByRoleId.load(role.id)),
      );
      // Union, sorted, so the UI gets a stable list regardless of role order.
      return [...new Set(grants.flat().map((p) => p.key))].sort();
    },
  },

  Role: {
    permissions: (role: RoleRow, _a: unknown, { loaders }: Ctx) =>
      loaders.permissionsByRoleId.load(role.id),
  },

  Permission: {
    description: (permission: { key: string; description?: string }) =>
      permission.description ??
      PERMISSION_DESCRIPTIONS[permission.key as Permission] ??
      permission.key,
  },
};
