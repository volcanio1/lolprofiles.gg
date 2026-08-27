/**
 * API layer — `POST /api/lookup`.
 *
 * The HTTP boundary for a Lookup_Session. It validates input, delegates to the
 * Lookup Orchestrator, and maps the typed `LookupResult` onto a status and body.
 * It contains no business logic of its own: no Riot call, no cache access, no
 * insight computation.
 *
 * lookup-pipeline-fixes: this route no longer accepts or validates a region or
 * a platform selection at all — the platform is now DISCOVERED by the
 * orchestrator's Region Resolver from the resolved PUUID. The only routing-
 * related input left is `platformOverride`, an optional diagnostic field never
 * exposed by the default search UI (Requirement 2.4).
 *
 * Implements:
 *  - 1.2-1.5 / 9.1: the Riot ID is validated here, BEFORE the orchestrator is
 *    invoked, so a malformed Riot ID cannot cause any Riot API call.
 *  - 2.4 / 9.2: a missing player is 404 with the submitted Riot ID echoed.
 *  - 5.2 / 5.3: the Region Resolver's `no_lol_account` and `unsupported_platform`
 *    outcomes each get their own message, built here since only the route
 *    (for gameName/tagLine) or the `LookupResult` (for the platform Riot named)
 *    has what each message needs.
 *  - 9.3, 9.4, 9.5, 9.8, 9.9: each Riot failure becomes its own status and message.
 *  - 11.4 / 11.5: `lastUpdated` is passed through untouched, including its `null`
 *    first-retrieval case.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. VALIDATION ORDER: Riot ID, then `platformOverride`. Requirement 9.1 makes
 *    the Riot ID the primary input, and it is the field the visitor is most likely
 *    to have got wrong, so reporting it first gives the most useful single error.
 *    Both checks precede the orchestrator call, which is what satisfies "without
 *    initiating any Riot API calls".
 *
 * 2. AN UNRECOGNIZED `platformOverride` DEGRADES TO "NO OVERRIDE", RATHER THAN
 *    BEING REJECTED. It is a diagnostic-only field with no default-UI exposure
 *    (Requirement 2.4), so there is no visitor-facing form to validate against —
 *    silently falling through to correct, automatic resolution is strictly safer
 *    than a fatal 400 over a field nobody sees. This replaces the old region/
 *    platform rejection this route used to perform (removed Requirement 5.5),
 *    which existed for a visitor-facing selector that no longer exists.
 *
 * 3. A BLANK STRING IS TREATED AS ABSENT. `platformOverride: '   '` is what an
 *    untouched or programmatically-cleared field sends, so treating it as "no
 *    override" is what the caller meant. Treating it as invalid would reject
 *    requests a legitimate diagnostic caller might send.
 *
 * 4. THE SUCCESS BODY IS THE `ProfileReport` ITSELF, unwrapped, per design.md's
 *    declared route contract. Errors are wrapped in an `{ error: ... }` envelope,
 *    so the two are unambiguous to a client: presence of `error` means failure,
 *    and no field of `ProfileReport` is named `error`.
 *
 * 5. THIS ROUTE IS UNAUTHENTICATED, AND THAT IS A DELIBERATE, FLAGGED GAP. The
 *    requirements describe a public profile lookup and define no authentication,
 *    so none is invented here. The consequence worth stating: on a cache miss this
 *    endpoint spends the application's SHARED Riot rate-limit budget
 *    (Requirement 4.3's per-key windows), so an unauthenticated caller can degrade
 *    every other visitor's lookups by requesting many distinct Riot IDs. The Rate
 *    Limit Manager keeps the API key in good standing — it will never let us
 *    exceed Riot's windows — but it cannot stop the budget being consumed by
 *    whoever asks first. Per-IP throttling is the mitigation and is not in scope
 *    for this task; see the implementation log's open items.
 *
 * 6. `region`/`platform` ARE REJECTED, NOT SILENTLY DROPPED (lookup-pipeline-fixes
 *    Requirement 2.1). A body-shape-tolerant parser would default to ignoring a
 *    field it doesn't recognize, which is exactly wrong here: a caller still
 *    sending `region` (an old frontend build, a stale integration, someone's
 *    saved API script) would otherwise get silently different routing behavior
 *    with no signal that anything changed. An explicit 400 makes the contract
 *    change loud instead of quiet. `platformOverride` is deliberately NOT
 *    subject to this — see decision 2 above — because it is a still-supported,
 *    if diagnostic-only, field, not a removed one.
 */

import type { RequestHandler } from 'express';
import type { LookupOrchestrator, ProfileReport } from '../orchestrator';
import { isSupportedPlatform, type PlatformRoutingValue } from '../region';
import { validateRiotId } from '../validator';
import {
  RATE_LIMIT_COOLDOWN_SECONDS,
  apiErrorFor,
  malformedRequestError,
  missingFieldError,
  noLolAccountError,
  playerNotFoundError,
  unknownFieldError,
  unsupportedPlatformError,
  validationError,
  type ApiErrorResponse,
} from './errors';

export interface LookupRouteDependencies {
  orchestrator: LookupOrchestrator;
}

/**
 * Reads a field as a trimmed string, or `undefined` when it is absent, blank, or
 * not a string (decision 3). Never throws for a hostile body shape.
 */
export function readOptionalString(body: unknown, field: string): string | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const value: unknown = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** True for a body that is a JSON object rather than an array, string or null. */
export function isJsonObject(body: unknown): boolean {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

/**
 * The pure part of the route: request body in, either an error response or the
 * validated arguments for `runLookup`. Separated from the handler so the
 * validation rules can be asserted without an HTTP round trip.
 */
export function parseLookupRequest(
  body: unknown,
):
  | { ok: true; riotId: { gameName: string; tagLine: string }; platformOverride?: PlatformRoutingValue }
  | { ok: false; response: ApiErrorResponse } {
  if (!isJsonObject(body)) {
    return { ok: false, response: malformedRequestError() };
  }

  // Decision 1: Riot ID first, and always before any Riot call (Requirement 9.1).
  const rawRiotId = (body as Record<string, unknown>).riotId;
  if (typeof rawRiotId !== 'string' || rawRiotId.trim().length === 0) {
    return {
      ok: false,
      response: missingFieldError('riotId', 'Enter a Riot ID in the format gameName#tagLine, for example Faker#KR1.'),
    };
  }

  const validation = validateRiotId(rawRiotId);
  if (!validation.ok || validation.riotId === undefined) {
    // `errorCode` is always present when `ok` is false.
    return { ok: false, response: validationError(validation.errorCode ?? 'MISSING_HASH') };
  }

  // lookup-pipeline-fixes Requirement 2.1: `region` and `platform` are no longer
  // part of the contract at all — rejected outright (decision 4 below) rather
  // than silently ignored, so a caller still sending either gets a clear signal
  // instead of an unexplained behavior change.
  if ((body as Record<string, unknown>).region !== undefined) {
    return { ok: false, response: unknownFieldError('region') };
  }
  if ((body as Record<string, unknown>).platform !== undefined) {
    return { ok: false, response: unknownFieldError('platform') };
  }

  // lookup-pipeline-fixes Requirement 2.4: a diagnostic escape hatch, absent from
  // the default UI. An unrecognized value is treated as no override at all
  // (falls through to the Region Resolver) rather than a rejected request —
  // it's a field visitors never see, so silently resolving correctly is safer
  // than a fatal error over a debug affordance (mirrors the orchestrator's own
  // choice; see its `LookupInput` doc).
  const rawPlatformOverride = readOptionalString(body, 'platformOverride');
  const platformOverride =
    rawPlatformOverride !== undefined && isSupportedPlatform(rawPlatformOverride) ? rawPlatformOverride : undefined;

  return { ok: true, riotId: validation.riotId, platformOverride };
}

/**
 * `POST /api/lookup`. Returns 200 with the `ProfileReport`, or an error envelope
 * (decision 4). Rejections are handed to the router's error handler rather than
 * being swallowed, so a defect surfaces as a logged 500 and not as a plausible
 * business error.
 */
export function createLookupHandler(deps: LookupRouteDependencies): RequestHandler {
  return async (req, res, next) => {
    try {
      const parsed = parseLookupRequest(req.body);
      if (!parsed.ok) {
        res.status(parsed.response.status).json(parsed.response.body);
        return;
      }

      const result = await deps.orchestrator.runLookup({
        riotId: parsed.riotId,
        platformOverride: parsed.platformOverride,
      });

      if (result.kind === 'success') {
        // Decision 4 / Requirements 11.4-11.5: the report passes through as-is.
        const report: ProfileReport = result.report;
        res.status(200).json(report);
        return;
      }

      if (result.kind === 'not_found') {
        // Requirements 2.4 / 9.2.
        const response = playerNotFoundError(result.gameName, result.tagLine);
        res.status(response.status).json(response.body);
        return;
      }

      if (result.code === 'NO_LOL_ACCOUNT') {
        // lookup-pipeline-fixes Requirement 5.2.
        const response = noLolAccountError(parsed.riotId.gameName, parsed.riotId.tagLine);
        res.status(response.status).json(response.body);
        return;
      }

      if (result.code === 'UNSUPPORTED_PLATFORM') {
        // Requirement 5.3. `result.platform` is the platform RIOT reported, not
        // something this route could recompute — see `LookupResult`'s doc.
        const response = unsupportedPlatformError(result.platform ?? '');
        res.status(response.status).json(response.body);
        return;
      }

      const response = apiErrorFor(result.code, result.retriable);
      if (result.code === 'RATE_LIMITED') {
        // Requirement 9.8, also as a standard header so ordinary client tooling
        // and proxies honor the cooldown without reading our envelope.
        res.setHeader('Retry-After', String(RATE_LIMIT_COOLDOWN_SECONDS));
      }
      res.status(response.status).json(response.body);
    } catch (error) {
      next(error);
    }
  };
}
