/**
 * Cross-origin access control for the API.
 *
 * PURE-ISH: the allowlist is injected, so this module reads no environment and can
 * be exercised without one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN ALLOWLIST AND NOT `Access-Control-Allow-Origin: *`
 * ---------------------------------------------------------------------------
 *
 * Both routes are unauthenticated, and `POST /api/lookup` spends the application's
 * SHARED Riot rate-limit budget on a cache miss (Requirement 4.3's per-key windows).
 * A wildcard would therefore let any page on the internet consume the budget that
 * every other visitor's lookups depend on, and let any page trigger
 * `POST /api/privacy/delete` for an arbitrary PUUID. The Rate Limit Manager keeps
 * the API key in good standing either way — it will never let us exceed Riot's
 * windows — but it cannot stop the budget being spent by whoever asks first.
 *
 * So: no origin is allowed unless it is named explicitly. The default allowlist is
 * EMPTY, which means no CORS headers are sent at all and browsers refuse
 * cross-origin calls. Development does not need CORS, because Vite proxies `/api`
 * through the dev server and the request is same-origin from the browser's point of
 * view. Only a deployment that genuinely serves the frontend from a different
 * origin needs to populate `CORS_ALLOWED_ORIGINS`.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. AN UNKNOWN ORIGIN GETS NO HEADERS, RATHER THAN A REJECTION. The request still
 *    reaches the route and is answered normally; the browser is what refuses to
 *    hand the response to the calling page, because the header it requires is
 *    absent. That is how CORS is designed to work, and it keeps non-browser callers
 *    (curl, server-to-server, the health check) working — CORS is not an
 *    authorization mechanism and pretending otherwise would give false assurance.
 *
 * 2. THE PREFLIGHT IS ANSWERED HERE, NOT LEFT TO EXPRESS. Express's default OPTIONS
 *    handler replies `200 Allow: POST` with no CORS headers, which reads as success
 *    but fails the preflight. An allowed origin gets an explicit `204` with the
 *    methods and headers it asked about; a disallowed one falls through.
 *
 * 3. `Vary: Origin` IS ALWAYS SET when an allowlist is configured. The response
 *    differs by request origin, so without it a shared cache could serve an
 *    allowed origin's headers to a disallowed one, or the reverse.
 *
 * 4. NO `Access-Control-Allow-Credentials`. Nothing in this API uses cookies or
 *    session credentials, so allowing them would widen the surface for no benefit —
 *    and it is the setting that makes a permissive origin genuinely dangerous.
 */

import type { RequestHandler } from 'express';

/** Methods the API actually serves. */
const ALLOWED_METHODS = 'GET,POST,OPTIONS';

/** Headers a browser client legitimately sends. */
const ALLOWED_HEADERS = 'Content-Type';

/** How long a browser may cache a successful preflight, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

export interface CorsOptions {
  /**
   * Exact origins permitted to make cross-origin requests, e.g.
   * `['https://lolprofiles.gg']`. Empty (the default) sends no CORS headers at all.
   */
  allowedOrigins?: readonly string[];
}

/**
 * Parses a comma-separated origin list, as read from `CORS_ALLOWED_ORIGINS`.
 * Blank entries are dropped and trailing slashes stripped, because an `Origin`
 * header never carries a trailing slash and a mismatch would silently fail.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
}

/**
 * Express middleware implementing the decisions above. When `allowedOrigins` is
 * empty it is a pass-through, so the default deployment behaves exactly as it did
 * before CORS existed.
 */
export function createCorsMiddleware(options: CorsOptions = {}): RequestHandler {
  const allowed = new Set(options.allowedOrigins ?? []);

  return (req, res, next) => {
    if (allowed.size === 0) {
      next();
      return;
    }

    // Decision 3.
    res.setHeader('Vary', 'Origin');

    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));

      // Decision 2: answer the preflight ourselves.
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }

    // Decision 1: an unknown origin simply gets no CORS headers.
    next();
  };
}
