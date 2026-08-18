/**
 * API layer — `POST /api/lookup`.
 *
 * The HTTP boundary for a Lookup_Session. It validates input, chooses the region,
 * delegates to the Lookup Orchestrator, and maps the typed `LookupResult` onto a
 * status and body. It contains no business logic of its own: no Riot call, no
 * cache access, no insight computation.
 *
 * Implements:
 *  - 1.2-1.5 / 9.1: the Riot ID is validated here, BEFORE the orchestrator is
 *    invoked, so a malformed Riot ID cannot cause any Riot API call.
 *  - 1.6: an absent or blank region defaults to `DEFAULT_REGION` (`americas`).
 *  - 5.5: a region outside the supported set, or a platform outside the whole
 *    mapping, is rejected without initiating any Riot call.
 *  - 2.4 / 9.2: a missing player is 404 with the submitted Riot ID echoed.
 *  - 9.3, 9.4, 9.5, 9.8, 9.9: each Riot failure becomes its own status and message.
 *  - 11.4 / 11.5: `lastUpdated` is passed through untouched, including its `null`
 *    first-retrieval case.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. VALIDATION ORDER: Riot ID, then region, then platform. Requirement 9.1 makes
 *    the Riot ID the primary input, and it is the field the visitor is most likely
 *    to have got wrong, so reporting it first gives the most useful single error.
 *    The order is fixed and documented rather than incidental, so the same bad
 *    request always produces the same error. All three checks precede the
 *    orchestrator call, which is what satisfies "without initiating any Riot API
 *    calls".
 *
 * 2. HOW REQUIREMENTS 5.4 AND 5.5 SPLIT ON `platform`. They look contradictory —
 *    5.4 says silently replace a platform that does not belong to the selected
 *    region, 5.5 says reject an unsupported platform outright — but they address
 *    different inputs. A platform that exists in `REGION_TO_PLATFORMS` but under a
 *    different region is 5.4's case, and the Region Router's `resolvePlatform`
 *    replaces it with the region's first platform. A platform that appears nowhere
 *    in the mapping at all is 5.5's case, and is rejected here via
 *    `isValidPlatform`. So this route rejects only genuinely unknown platforms and
 *    leaves the region-mismatch substitution to the orchestrator, which is exactly
 *    the division design.md describes when it says callers reject unsupported
 *    input "before this point".
 *
 * 3. A BLANK STRING IS TREATED AS ABSENT. `region: ''` and `platform: '   '` are
 *    what an untouched form control sends, so treating them as "not selected"
 *    (Requirement 1.6's default, and no platform preference) is what the visitor
 *    meant. Treating them as invalid would reject requests the frontend legitimately
 *    produces.
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
 */

import type { RequestHandler } from 'express';
import type { LookupOrchestrator, ProfileReport } from '../orchestrator';
import { DEFAULT_REGION, isValidPlatform, isValidRegion, resolvePlatform } from '../region';
import { validateRiotId } from '../validator';
import {
  RATE_LIMIT_COOLDOWN_SECONDS,
  apiErrorFor,
  malformedRequestError,
  missingFieldError,
  playerNotFoundError,
  playerNotOnPlatformError,
  unsupportedRegionError,
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
  | { ok: true; riotId: { gameName: string; tagLine: string }; region: ReturnType<typeof pickRegion>; platform?: string }
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

  // Requirement 1.6: default when not selected; Requirement 5.5: reject otherwise.
  const rawRegion = readOptionalString(body, 'region');
  if (rawRegion !== undefined && !isValidRegion(rawRegion)) {
    return { ok: false, response: unsupportedRegionError('region') };
  }
  const region = pickRegion(rawRegion);

  // Decision 2: reject only platforms that are absent from the whole mapping.
  const rawPlatform = readOptionalString(body, 'platform');
  if (rawPlatform !== undefined && !isValidPlatform(rawPlatform)) {
    return { ok: false, response: unsupportedRegionError('platform') };
  }

  return { ok: true, riotId: validation.riotId, region, platform: rawPlatform };
}

/** Requirement 1.6. */
function pickRegion(rawRegion: string | undefined) {
  return rawRegion !== undefined && isValidRegion(rawRegion) ? rawRegion : DEFAULT_REGION;
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
        region: parsed.region,
        platform: parsed.platform,
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

      if (result.code === 'PLAYER_NOT_ON_PLATFORM') {
        /**
         * Requirement 9.10 (Finding A). The orchestrator reports the code but not
         * the platform, so it is recomputed here with the SAME pure function the
         * orchestrator used — `resolvePlatform` is deterministic over
         * (region, requestedPlatform), so both arrive at the same answer without
         * widening `LookupResult` to carry it.
         */
        const searchedPlatform = resolvePlatform(parsed.region, parsed.platform);
        const notOnPlatform = playerNotOnPlatformError(
          parsed.riotId.gameName,
          parsed.riotId.tagLine,
          parsed.region,
          searchedPlatform,
        );
        res.status(notOnPlatform.status).json(notOnPlatform.body);
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
