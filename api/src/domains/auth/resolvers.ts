import type { GraphQLContext } from '../../context.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';
import * as service from './service.js';

/**
 * Thin, like the purchasing resolvers: translate to and from HTTP (cookies in,
 * cookies out) and delegate. The rotation and reuse rules live in `service.ts`.
 */
type Ctx = GraphQLContext;

export const resolvers = {
  Query: {
    // Resolved through the loader rather than the token, so a user deleted or
    // renamed mid-session reflects reality rather than stale claims.
    me: async (_p: unknown, _a: unknown, { actor, loaders }: Ctx) =>
      actor ? loaders.userById.load(actor.id) : null,
  },

  Mutation: {
    login: async (_p: unknown, args: { input: unknown }, ctx: Ctx) => {
      const session = await service.login(args.input, {
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
      });

      setSessionCookies(ctx.res, session);
      return { user: session.user, expiresIn: session.expiresIn };
    },

    refreshSession: async (_p: unknown, _a: unknown, ctx: Ctx) => {
      try {
        const session = await service.refresh(ctx.refreshToken, {
          userAgent: ctx.userAgent,
          ipAddress: ctx.ipAddress,
        });

        setSessionCookies(ctx.res, session);
        return { user: session.user, expiresIn: session.expiresIn };
      } catch (error) {
        // Any failed refresh ends the session in the browser too. Leaving a
        // dead cookie in place makes the client retry forever against a token
        // that will never work again.
        clearSessionCookies(ctx.res);
        throw error;
      }
    },

    logout: async (_p: unknown, _a: unknown, ctx: Ctx) => {
      await service.logout(ctx.refreshToken);
      clearSessionCookies(ctx.res);
      return true;
    },
  },
};
