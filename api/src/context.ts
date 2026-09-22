import type { IncomingMessage, ServerResponse } from 'node:http';
import { ACCESS_COOKIE, parseCookies, REFRESH_COOKIE } from './domains/auth/cookies.js';
import { createLoaders, type Loaders } from './domains/purchasing/loaders.js';
import { type Actor, bearerFromHeader, resolveActor } from './shared/auth.js';
import { prisma } from './shared/prisma.js';

export interface GraphQLContext {
  db: typeof prisma;
  /** Null for anonymous requests. Resolvers gate on it via `requireRole`. */
  actor: Actor | null;
  loaders: Loaders;
  /** Auth mutations set and clear cookies through this. */
  res: ServerResponse;
  /** Present only when the browser sent one; `refreshSession` consumes it. */
  refreshToken: string | null;
  userAgent: string | null;
  ipAddress: string | null;
}

export async function createContext({
  req,
  res,
}: {
  req: IncomingMessage;
  res: ServerResponse;
}): Promise<GraphQLContext> {
  const cookies = parseCookies(req.headers.cookie);

  // The browser authenticates with an httpOnly cookie it cannot read. The
  // Authorization header is accepted too, so curl, the Apollo sandbox and the
  // integration tests can drive the API without a cookie jar.
  const accessToken = bearerFromHeader(req.headers.authorization) ?? cookies[ACCESS_COOKIE] ?? null;

  return {
    db: prisma,
    actor: await resolveActor(accessToken),
    // Fresh per request: a DataLoader cache that outlived a request would
    // serve one user's rows to the next.
    loaders: createLoaders(prisma),
    res,
    refreshToken: cookies[REFRESH_COOKIE] ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    ipAddress: clientIp(req),
  };
}

/**
 * Behind the Next proxy (and, in production, an EKS ingress) the socket address
 * is the proxy's, so the forwarded header is the only useful source. Trusting
 * it is safe here because the only path to this API is through that proxy; if
 * the API were ever exposed directly, this would need a trusted-proxy allowlist.
 */
function clientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return first?.trim() || req.socket.remoteAddress || null;
}
