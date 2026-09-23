import { createServer } from 'node:http';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import cors from 'cors';
import express from 'express';
import type { GraphQLContext } from './context.js';
import { createContext, resolveRequestActor } from './context.js';
import { schema } from './schema.js';
import { logger } from './shared/logger.js';
import { loggingPlugin } from './shared/logging-plugin.js';
import { prismaUnscoped } from './shared/prisma.js';
import { withTenant } from './shared/tenancy.js';

const PORT = Number(process.env.PORT ?? 4000);

const server = new ApolloServer<GraphQLContext>({
  // Authorisation is applied to every root field as the schema is built, so it
  // cannot be forgotten on a new resolver. See src/shared/authorize.ts.
  schema,
  plugins: [loggingPlugin],
  // The UI branches on `extensions.code`, so stack traces add nothing and leak
  // schema internals. Known codes pass through untouched; anything else is a
  // bug on our side and is reported without detail.
  formatError: (formatted) => {
    const code = formatted.extensions?.code;
    const isExpected =
      typeof code === 'string' &&
      [
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'FEATURE_DISABLED',
        'NOT_FOUND',
        'BAD_USER_INPUT',
        'OVER_RECEIPT',
        'CONFLICT',
        'GRAPHQL_VALIDATION_FAILED',
        'GRAPHQL_PARSE_FAILED',
      ].includes(code);

    if (isExpected) {
      const { stacktrace: _stacktrace, ...extensions } = formatted.extensions ?? {};
      return { ...formatted, extensions };
    }

    // The logging plugin has already recorded this with the request id; here
    // we only decide what the client is allowed to see.
    return {
      message: 'Something went wrong. Please try again.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    };
  },
});

await server.start();

const app = express();

/**
 * Binds the tenant to the request before GraphQL executes.
 *
 * This is Express rather than `startStandaloneServer` for one reason: the
 * tenant lives in `AsyncLocalStorage`, and the store has to cover the whole
 * execution, not just context creation. `enterWith` inside the context function
 * looked like it would do, and did not -- the store was gone by the time
 * resolvers ran, so every query threw "no tenant context". Wrapping `next()` in
 * `storage.run` is the version that actually holds, and `tenancy.test.ts` runs
 * interleaved requests from two tenants to prove it.
 */
app.use(cors(), express.json({ limit: '1mb' }), (req, _res, next) => {
  void (async () => {
    const actor = await resolveRequestActor(req);
    if (!actor) return next();

    // Everything downstream -- resolvers, services, loaders -- runs inside the
    // tenant, so no query has to remember to scope itself.
    await withTenant({ tenantId: actor.tenantId, slug: '' }, () => {
      next();
    });
  })().catch(next);
});

app.use(
  '/',
  expressMiddleware(server, {
    context: async ({ req, res }) => createContext({ req, res }),
  }),
);

const httpServer = createServer(app);
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));

logger.info({ url: `http://localhost:${PORT}/` }, 'DaaS API ready');

if (process.env.DEV_AUTH_DEBUG === 'true') {
  // Unscoped on purpose: this boot diagnostic spans every tenant, and there is
  // no request context to scope it to. The extension would reject the scoped
  // client here, which is the correct behaviour.
  const users = await prismaUnscoped.user.findMany({
    where: { deletedAt: null },
    orderBy: [{ tenant: { slug: 'asc' } }, { email: 'asc' }],
    select: {
      email: true,
      tenant: { select: { slug: true } },
      roles: { select: { role: { select: { key: true } } } },
    },
  });
  if (users.length > 0) {
    console.log('\nSeeded sign-ins (dev only) — password is the same for all:');
    for (const user of users) {
      const roles = user.roles.map((r) => r.role.key).join(', ') || 'no roles';
      console.log(`  ${user.tenant.slug.padEnd(11)} ${user.email.padEnd(22)} ${roles}`);
    }
    console.log(`  password: ${process.env.SEED_PASSWORD ?? 'daas-dev-password'}\n`);
  }
}

// Let Postgres connections close cleanly so `docker compose down` and nodemon
// restarts do not leave sockets hanging.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      logger.info({ signal }, 'shutting down');
      httpServer.close();
      await server.stop();
      await prismaUnscoped.$disconnect();
      process.exit(0);
    })();
  });
}
