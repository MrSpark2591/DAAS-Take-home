import { NextResponse } from 'next/server';

/**
 * Same-origin GraphQL proxy.
 *
 * The browser talks to /api/graphql on its own origin; this handler forwards to
 * the API. That is what makes the session cookies first-party: they are set on
 * localhost:3000, not on the API's origin, so they are sent automatically
 * without CORS credential negotiation and without loosening SameSite.
 *
 * The browser never holds a token. Both cookies are httpOnly, so page
 * JavaScript cannot read them even if an XSS bug gets script execution.
 */

const API_URL = process.env.GRAPHQL_API_URL ?? 'http://localhost:4000/';

// Cookies make every request user-specific, so nothing here may be cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The session lives here. Without this the API sees an anonymous call.
        cookie: request.headers.get('cookie') ?? '',
        // Forwarded so the API can record which device a refresh token belongs
        // to; the socket it sees is this server, not the user.
        'user-agent': request.headers.get('user-agent') ?? '',
        'x-forwarded-for': clientIp(request),
      },
      body,
      // Never let a hung API hold a request open indefinitely.
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // Shaped as a GraphQL error so the client's single error path handles it.
    return NextResponse.json(
      {
        errors: [
          {
            message: 'Cannot reach the API. Is it running on port 4000?',
            extensions: { code: 'NETWORK_ERROR' },
          },
        ],
      },
      { status: 502 },
    );
  }

  const response = new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });

  // Relay the API's Set-Cookie headers to the browser. getSetCookie keeps them
  // as separate entries; reading the header as a single string would join them
  // on commas and corrupt the cookie attributes.
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }

  return response;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded;
  return request.headers.get('x-real-ip') ?? '';
}
