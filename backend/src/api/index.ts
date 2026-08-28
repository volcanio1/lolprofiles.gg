/**
 * API layer — router assembly.
 *
 * Mounts the two routes design.md declares and owns the cross-cutting HTTP
 * concerns that neither route should repeat: JSON body parsing with a size bound,
 * turning a malformed body into our own error envelope instead of Express's HTML
 * page, and a terminal handler that converts an unexpected throw into a logged,
 * opaque 500.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE BODY LIMIT IS SMALL AND EXPLICIT. Both routes accept a handful of short
 *    strings, so 16 KB is generous. Express's default is 100 KB, and leaving it
 *    there on an unauthenticated endpoint means accepting arbitrary payloads we
 *    will never read — a free memory-pressure lever for a caller who has no
 *    legitimate use for it.
 *
 * 2. PARSE ERRORS BECOME OUR ENVELOPE, NOT EXPRESS'S DEFAULT. `express.json()`
 *    rejects malformed JSON by delegating to the error chain, whose default
 *    handler returns an HTML page and, when `NODE_ENV` is not `production`, the
 *    stack trace with it. A JSON API must answer in JSON, and it must not hand a
 *    client a stack trace — so the terminal handler classifies body-parse failures
 *    as a 400 and everything else as a 500.
 *
 * 3. AN UNEXPECTED THROW IS A DEFECT, LOGGED SERVER-SIDE AND OPAQUE TO THE CLIENT.
 *    Every expected outcome is already a typed `LookupResult`, so reaching the
 *    terminal handler means a bug. The client gets a generic message with no
 *    internal detail — the same discipline Requirement 9.5 imposes on
 *    authentication failures — while the operator gets the real error in the log.
 *    The logger is injected so tests can assert the logging happened without
 *    writing to the console.
 *
 * 4. THE ERROR HANDLER IS REGISTERED LAST. Express only consults error handlers
 *    that appear after the point where the error was raised, so a handler
 *    registered before the routes would catch parse failures but not route
 *    failures. Registered last, it catches both.
 *
 * 5. REQUIREMENT 9.5's LOGGING OBLIGATION IS ALREADY MET UPSTREAM, and is
 *    deliberately not repeated here. The orchestrator logs every 401/403 at the
 *    stage where it happened, with more context than this layer has; logging it
 *    again on the way out would double-count real incidents in the operator's log
 *    while adding nothing. This layer's job for `AUTH_FAILURE` is the other half
 *    of 9.5 — returning a generic message — which `apiErrorFor` does.
 */

import express, { Router, type ErrorRequestHandler } from 'express';
import type { CacheStore } from '../cache';
import type { RankHistoryStore } from '../db/rankHistoryStore';
import type { LookedUpPlayerStore } from '../db/lookedUpPlayerStore';
import type { ProfileSnapshotStore } from '../db/profileSnapshotStore';
import type { MatchStore } from '../db/matchStore';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import { createBuildPathHandler } from './buildPath';
import { createCorsMiddleware } from './cors';
import { internalError, malformedRequestError } from './errors';
import { createLookupHandler } from './lookup';
import { createPrivacyDeleteHandler } from './privacy';
import { createStaticDataHandler } from './staticData';
import { createSuggestHandler } from './suggest';
import { createCachedReportHandler } from './cachedReport';

export * from './errors';
export { createCorsMiddleware, parseAllowedOrigins, type CorsOptions } from './cors';
export { createLookupHandler, isJsonObject, parseLookupRequest, readOptionalString } from './lookup';
export {
  createBuildPathHandler,
  parseBuildPathRequest,
  readQueryString,
  type BuildPathResponseBody,
} from './buildPath';
export { createPrivacyDeleteHandler, type DeletionConfirmation } from './privacy';
export {
  createSuggestHandler,
  clampLimit,
  isAnswerableQuery,
  MIN_QUERY_LENGTH,
  MAX_SUGGESTIONS,
  type PlayerSuggestion,
  type SuggestRouteDependencies,
} from './suggest';
export {
  createCachedReportHandler,
  SNAPSHOT_MAX_AGE_MS,
  REFRESH_COOLDOWN_MS,
  type CachedReportResponse,
  type CachedReportRouteDependencies,
} from './cachedReport';
export {
  createStaticDataHandler,
  type StaticDataResponse,
  type StaticDataHandlerDependencies,
} from './staticData';

/** Decision 1. */
export const REQUEST_BODY_LIMIT = '16kb';

/**
 * Requirement 9.5's sibling for defects (decision 3). Narrow on purpose: this is
 * not a logging facade, it is the one seam the API layer needs.
 */
export interface ApiLogger {
  unexpectedError(info: { method: string; path: string; error: unknown }): void;
  /**
   * specs/autofill-search/ Requirement 1.8. `searchByNamePrefix` rejected while
   * serving `GET /api/players/suggest`; the autocomplete degraded to "no
   * suggestions". An operational note, not a defect — the request still answered
   * 200.
   */
  suggestFailed(info: { error: unknown }): void;
  /**
   * specs/autofill-search/ Requirement 9.5. A store read failed while serving
   * `GET /api/players/report`; the endpoint degraded to `{ source: "miss" }` and
   * the client will fall through to a live lookup. Operational note, not a defect.
   */
  cachedReportFailed(info: { error: unknown }): void;
}

/** Default sink, so an unhandled defect is never silently discarded. */
export const consoleApiLogger: ApiLogger = {
  unexpectedError({ method, path, error }) {
    // eslint-disable-next-line no-console
    console.error(`[lolprofiles] Unhandled error in ${method} ${path}:`, error);
  },
  suggestFailed({ error }) {
    // eslint-disable-next-line no-console
    console.warn('[lolprofiles] Player suggestion lookup failed (autocomplete degraded to no suggestions):', error);
  },
  cachedReportFailed({ error }) {
    // eslint-disable-next-line no-console
    console.warn('[lolprofiles] Cached-report lookup failed (falling through to a live lookup):', error);
  },
};

export interface ApiDependencies {
  orchestrator: LookupOrchestrator;
  /** item-timeline: serves `GET /api/match/:matchId/build-path`. */
  buildPathOrchestrator: BuildPathOrchestrator;
  cache: CacheStore;
  /**
   * Persistent_Store (specs/database/). Optional — omitted means the no-op
   * stores, which is also the runtime state when `MONGODB_URI` is unset. Today
   * only `POST /api/privacy/delete` consumes them (Requirement 5.1);
   * `autofill-search` will add a read route over `lookedUpPlayerStore`.
   */
  rankHistoryStore?: RankHistoryStore;
  lookedUpPlayerStore?: LookedUpPlayerStore;
  /** autofill-search Requirements 8-10: serves `GET /api/players/report` and is cleared by `POST /api/privacy/delete`. */
  profileSnapshotStore?: ProfileSnapshotStore;
  /** match-cache Requirement 6: cleared by `POST /api/privacy/delete`. The orchestrator gets its own copy directly. */
  matchStore?: MatchStore;
  /** Injected clock, shared with the cache store and the orchestrator. */
  now?: () => number;
  /** Partial: any method not supplied falls back to `consoleApiLogger`. */
  logger?: Partial<ApiLogger>;
  /**
   * Exact origins permitted to call the API cross-origin. Empty (the default)
   * sends no CORS headers, which is correct for a same-origin deployment and for
   * development, where Vite proxies `/api` through the dev server. See `cors.ts`
   * for why this is an allowlist rather than a wildcard.
   */
  allowedOrigins?: readonly string[];
  /**
   * The pinned Data Dragon release served by `GET /api/static-data`. Required
   * rather than defaulted: the frontend resolves every asset against it, and a
   * silently-defaulted version would render assets from a release nobody chose.
   */
  dataDragonVersion: string;
}

/** True when Express's body parser rejected the payload rather than the app failing. */
function isBodyParseError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof candidate.type === 'string' && candidate.type.startsWith('entity.')) {
    return true;
  }
  const status = candidate.status ?? candidate.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Builds the `/api` router. Every dependency is injected, so a test drives the
 * real HTTP stack against fakes without a network, a credential or a real clock.
 */
export function createApiRouter(deps: ApiDependencies): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const logger: ApiLogger = { ...consoleApiLogger, ...deps.logger };

  // Before body parsing, so a preflight is answered without reading a body it
  // does not have.
  router.use(createCorsMiddleware({ allowedOrigins: deps.allowedOrigins }));

  router.use(express.json({ limit: REQUEST_BODY_LIMIT })); // decision 1

  router.post('/lookup', createLookupHandler({ orchestrator: deps.orchestrator }));
  router.get(
    '/match/:matchId/build-path',
    createBuildPathHandler({ buildPathOrchestrator: deps.buildPathOrchestrator }),
  );
  router.post(
    '/privacy/delete',
    createPrivacyDeleteHandler({
      cache: deps.cache,
      now,
      rankHistoryStore: deps.rankHistoryStore,
      lookedUpPlayerStore: deps.lookedUpPlayerStore,
      profileSnapshotStore: deps.profileSnapshotStore,
      matchStore: deps.matchStore,
    }),
  );
  router.get(
    '/static-data',
    createStaticDataHandler({ dataDragonVersion: deps.dataDragonVersion }),
  );
  router.get(
    '/players/suggest',
    createSuggestHandler({
      lookedUpPlayerStore: deps.lookedUpPlayerStore,
      onError: (error) => logger.suggestFailed({ error }),
    }),
  );
  router.get(
    '/players/report',
    createCachedReportHandler({
      lookedUpPlayerStore: deps.lookedUpPlayerStore,
      profileSnapshotStore: deps.profileSnapshotStore,
      now,
      onError: (error) => logger.cachedReportFailed({ error }),
    }),
  );

  // Decision 4: registered last, so it sees both parse and route failures.
  const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) {
      // Nothing useful left to say; the response is already on the wire.
      return;
    }
    if (isBodyParseError(error)) {
      // Decision 2.
      const response = malformedRequestError();
      res.status(response.status).json(response.body);
      return;
    }
    // Decision 3.
    logger.unexpectedError({ method: req.method, path: req.path, error });
    const response = internalError();
    res.status(response.status).json(response.body);
  };
  router.use(errorHandler);

  return router;
}
