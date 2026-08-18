/**
 * Frontend runtime configuration.
 *
 * This module holds ONLY the base URL of lolprofiles.gg's own backend API.
 * The Riot API key is a backend-only secret: it MUST NEVER be referenced,
 * imported, or otherwise present in frontend code or the built bundle
 * (Requirement 4.2), because everything shipped to the browser is public.
 * All Riot API access happens server-side, behind the backend API.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT IS A RELATIVE BASE, NOT `http://localhost:3001`
 * ---------------------------------------------------------------------------
 *
 * An absolute default pointing at the backend's port makes every request
 * cross-origin, which the browser then blocks at the CORS preflight — the backend
 * serves no `Access-Control-Allow-Origin` header by default, deliberately, because
 * the lookup endpoint is unauthenticated and spends a shared Riot rate-limit budget.
 *
 * Defaulting to `''` means the client requests `/api/lookup` on its OWN origin:
 *  - in development, Vite's `server.proxy` forwards `/api` to the backend;
 *  - in production, the frontend and API are served behind one origin (or a reverse
 *    proxy routes `/api`), which is the normal deployment for this shape of app.
 *
 * `VITE_API_BASE_URL` remains available for deployments that genuinely need a
 * different origin; those must also add that origin to the backend's
 * `CORS_ALLOWED_ORIGINS`, or the browser will block the request.
 */

/** Same-origin. See the note above for why this is not an absolute URL. */
const DEFAULT_API_BASE_URL = '';

function readApiBaseUrl(rawValue: string | undefined): string {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return DEFAULT_API_BASE_URL;
  }

  // Trailing slashes are stripped so callers can always concatenate `/api/...`.
  return rawValue.trim().replace(/\/+$/, '');
}

export const apiBaseUrl: string = readApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
