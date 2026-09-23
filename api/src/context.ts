import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { ACCESS_COOKIE, parseCookies, REFRESH_COOKIE } from './domains/auth/cookies.js';
import { createLoaders, type Loaders } from './domains/purchasing/loaders.js';
import { type Actor, bearerFromHeader, resolveActor } from './shared/auth.js';
import { requestLogger, resolveRequestId } from './shared/logger.js';
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
  /** Correlates every log line this request produces. */
  requestId: string;
  /** Request-scoped logger. Prefer this over the root logger in resolvers. */
  log: Logger;
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
  const actor = await resolveActor(accessToken);

  // Honours an inbound x-request-id so a trace started at the proxy (or an
  // ingress) continues through the API rather than restarting here.
  const requestId = resolveRequestId(req.headers['x-request-id']);
  const ipAddress = clientIp(req);

  return {
    db: prisma,
    actor,
    // Fresh per request: a DataLoader cache that outlived a request would
    // serve one user's rows to the next.
    loaders: createLoaders(prisma),
    res,
    refreshToken: cookies[REFRESH_COOKIE] ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    ipAddress,
    requestId,
    log: requestLogger({ requestId, userId: actor?.id ?? null, ip: ipAddress }),
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
