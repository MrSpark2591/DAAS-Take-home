import type { IncomingMessage } from 'node:http';
import { createLoaders, type Loaders } from './domains/purchasing/loaders.js';
import { type Actor, parseBearerToken } from './shared/auth.js';
import { prisma } from './shared/prisma.js';

export interface GraphQLContext {
  db: typeof prisma;
  /** Null for anonymous requests. Resolvers gate on it via `requireRole`. */
  actor: Actor | null;
  loaders: Loaders;
}

export function createContext({ req }: { req: IncomingMessage }): GraphQLContext {
  return {
    db: prisma,
    actor: parseBearerToken(req.headers.authorization),
    // Fresh per request: a DataLoader cache that outlived a request would
    // serve one user's rows to the next.
    loaders: createLoaders(prisma),
  };
}
