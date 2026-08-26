/**
 * Serves the pinned Data Dragon version to the frontend.
 *
 * PURE: the version is injected, so this module reads no environment and issues no
 * I/O of any kind.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * The frontend resolves every champion, item and profile-icon asset against one
 * Data Dragon version. That version could have been a build-time `VITE_` variable,
 * but then bumping a patch would mean a frontend rebuild and redeploy, and the two
 * workspaces could disagree about the version with nothing to detect it. Serving it
 * makes the backend's configuration the single source of truth and turns a patch
 * bump into a restart.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. NO RIOT CALL, NO CACHE ENTRY, NO RATE-LIMIT RESERVATION. This returns a
 *    configured string. Data Dragon is a public CDN and is not a rate-limited game
 *    API, so routing anything about it through the Rate Limit Manager would consume
 *    reservations against windows Riot does not apply to it.
 *
 * 2. `Cache-Control: no-cache` RATHER THAN A LONG MAX-AGE. The version is the one
 *    value that must change promptly when it changes: a client holding a stale
 *    version renders every asset against a patch that may no longer serve them.
 *    The payload is a few dozen bytes, so revalidation costs nothing.
 */

import type { RequestHandler } from 'express';

export interface StaticDataResponse {
  dataDragonVersion: string;
}

export interface StaticDataHandlerDependencies {
  dataDragonVersion: string;
}

export function createStaticDataHandler(
  deps: StaticDataHandlerDependencies,
): RequestHandler {
  return (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache'); // decision 2
    const body: StaticDataResponse = { dataDragonVersion: deps.dataDragonVersion };
    res.status(200).json(body);
  };
}
