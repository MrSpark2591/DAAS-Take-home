import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import type { GraphQLContext } from './context.js';
import { createContext } from './context.js';
import { resolvers, typeDefs } from './schema.js';
import { logger } from './shared/logger.js';
import { loggingPlugin } from './shared/logging-plugin.js';
import { prisma } from './shared/prisma.js';

const PORT = Number(process.env.PORT ?? 4000);

const server = new ApolloServer<GraphQLContext>({
  typeDefs,
  resolvers,
  plugins: [loggingPlugin],
  // The UI branches on `extensions.code`, so stack traces add nothing and leak
  // schema internals. Known codes pass through untouched; anything else is a
  // bug on our side and is reported without detail.
  formatError: (formatted, error) => {
    const code = formatted.extensions?.code;
    const isExpected =
      typeof code === 'string' &&
      [
        'UNAUTHENTICATED',
        'FORBIDDEN',
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
    void error;
    return {
      message: 'Something went wrong. Please try again.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    };
  },
});

const { url } = await startStandaloneServer(server, {
  listen: { port: PORT },
  context: async ({ req, res }) => createContext({ req, res }),
});

logger.info({ url }, 'DaaS API ready');

if (process.env.DEV_AUTH_DEBUG === 'true') {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { email: 'asc' },
    select: { email: true, roles: { select: { role: { select: { key: true } } } } },
  });
  if (users.length > 0) {
    console.log('\nSeeded sign-ins (dev only) — password is the same for all:');
    for (const user of users) {
      const roles = user.roles.map((r) => r.role.key).join(', ') || 'no roles';
      console.log(`  ${user.email.padEnd(16)} ${roles}`);
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
      await server.stop();
      await prisma.$disconnect();
      process.exit(0);
    })();
  });
}
