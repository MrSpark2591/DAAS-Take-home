import type { ServerResponse } from 'node:http';
import { accessTokenTtlSeconds, refreshTokenTtlSeconds } from '../../shared/tokens.js';

/**
 * Both tokens travel as httpOnly cookies, so no browser JavaScript ever holds
 * a credential -- an XSS bug cannot read what it cannot see.
 *
 * The web app reaches this API through a same-origin Next route handler, which
 * forwards `cookie` and relays `set-cookie` back. That is what keeps these
 * first-party and lets SameSite stay strict enough to be worth having.
 */

export const ACCESS_COOKIE = 'daas_at';
export const REFRESH_COOKIE = 'daas_rt';

const isProduction = process.env.NODE_ENV === 'production';

function serialise(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: Strict would drop the cookie on a cross-site
    // navigation into the app, logging people out when they follow a link in.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  // Only over TLS in production; localhost is plain HTTP, and a Secure cookie
  // there would simply never be sent.
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookies(
  res: ServerResponse,
  tokens: { accessToken: string; refreshToken: string },
): void {
  appendCookie(res, serialise(ACCESS_COOKIE, tokens.accessToken, accessTokenTtlSeconds()));
  appendCookie(res, serialise(REFRESH_COOKIE, tokens.refreshToken, refreshTokenTtlSeconds()));
}

/** Max-Age=0 tells the browser to drop the cookie immediately. */
export function clearSessionCookies(res: ServerResponse): void {
  appendCookie(res, serialise(ACCESS_COOKIE, '', 0));
  appendCookie(res, serialise(REFRESH_COOKIE, '', 0));
}

/** Appends rather than replaces, so setting the second cookie keeps the first. */
function appendCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('set-cookie');
  const all = Array.isArray(existing)
    ? [...existing, cookie]
    : typeof existing === 'string'
      ? [existing, cookie]
      : [cookie];
  res.setHeader('set-cookie', all);
}

/**
 * Minimal Cookie-header parser. Node has no built-in, and pulling a dependency
 * in for one `split` is not worth it. Values are percent-decoded because that
 * is what browsers send; both our tokens are already url-safe.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};

  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name) continue;

    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
