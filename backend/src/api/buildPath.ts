/**
 * API layer — `GET /api/match/:matchId/build-path`.
 *
 * The HTTP boundary for one match's Build_Path (`item-timeline` feature). It
 * validates the Riot ID query parameters through the same validator the lookup
 * route uses, delegates to the Build Path Orchestrator, and maps the typed
 * `BuildPathResult` onto a status and body. No business logic: no Riot call, no
 * cache access, no replay.
 *
 * Implements:
 *  - Requirement 1.1 / 6.1: `GET`, because it is a pure read; the frontend
 *    fetches it only on Build Path tab selection.
 *  - Requirement 6.1: both `build_path` and `unavailable` are `200` — a match
 *    with no timeline is a normal outcome, not an error, and the match row keeps
 *    rendering everything else.
 *  - Requirement 1.5 / 6.2: `unavailable` (missing timeline, or the player absent
 *    from the timeline's participant list) is a body, never a page-level error.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE RIOT ID ARRIVES AS TWO QUERY PARAMS, NOT ONE `gameName#tagLine` STRING.
 *    A `GET` has no body, and two params are cleaner in a URL than a
 *    percent-encoded `#`. They are recombined into `gameName#tagLine` and run
 *    through `validateRiotId` unchanged, so the validation rules (Requirements
 *    1.2-1.5) are exactly the lookup route's — not a second implementation.
 *
 * 2. THE MATCH ID IS NOT FORMAT-CHECKED HERE. `:matchId` is always a non-empty
 *    path segment, and whether its platform prefix is one this build routes is
 *    the orchestrator's call (it owns `PLATFORM_TO_REGION`). An unrecognised
 *    prefix comes back as `VALIDATION_FAILED`, which this route renders as a 400
 *    with a match-id-specific message — the code is reused, no new one is added
 *    (Requirement 6.1).
 *
 * 3. THE SUCCESS BODY IS A DISCRIMINATED UNION ON `kind`, mirroring the
 *    orchestrator's own result discriminant, so the frontend branches on one
 *    field. Errors keep the `{ error: ... }` envelope every other route uses.
 */

import type { RequestHandler } from 'express';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import type { BuildPathEntry } from '../insight/buildPath';
import { validateRiotId, type RiotIdParts } from '../validator';
import {
  RATE_LIMIT_COOLDOWN_SECONDS,
  apiErrorFor,
  missingFieldError,
  playerNotFoundError,
  validationError,
  type ApiErrorResponse,
} from './errors';

export interface BuildPathRouteDependencies {
  buildPathOrchestrator: BuildPathOrchestrator;
}

export type BuildPathResponseBody =
  | { kind: 'build_path'; buildPath: readonly BuildPathEntry[]; skillOrder: readonly number[]; reconciled: boolean }
  | { kind: 'unavailable'; reason: 'no_timeline' | 'participant_absent' };

/** Reads a query value as a single trimmed string, or `undefined` when absent/blank/repeated. */
export function readQueryString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The pure part of the route: `:matchId` plus the `gameName`/`tagLine` query, in;
 * either an error response or the validated arguments for `getBuildPath`.
 */
export function parseBuildPathRequest(input: {
  matchId: unknown;
  gameName: unknown;
  tagLine: unknown;
}): { ok: true; matchId: string; riotId: RiotIdParts } | { ok: false; response: ApiErrorResponse } {
  const matchId = readQueryString(input.matchId);
  if (matchId === undefined) {
    return { ok: false, response: missingFieldError('matchId', 'A match id is required.') };
  }

  const gameName = readQueryString(input.gameName);
  const tagLine = readQueryString(input.tagLine);
  if (gameName === undefined) {
    return { ok: false, response: missingFieldError('gameName', 'A gameName query parameter is required.') };
  }
  if (tagLine === undefined) {
    return { ok: false, response: missingFieldError('tagLine', 'A tagLine query parameter is required.') };
  }

  const validation = validateRiotId(`${gameName}#${tagLine}`);
  if (!validation.ok || validation.riotId === undefined) {
    return { ok: false, response: validationError(validation.errorCode ?? 'MISSING_HASH') };
  }

  return { ok: true, matchId, riotId: validation.riotId };
}

/** A malformed match id: reuses `VALIDATION_FAILED` (Requirement 6.1, decision 2). */
function malformedMatchIdError(): ApiErrorResponse {
  return {
    status: 400,
    body: {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The match id is not in a recognised format.',
        retriable: false,
        field: 'matchId',
      },
    },
  };
}

/**
 * `GET /api/match/:matchId/build-path?gameName=<name>&tagLine=<tag>`. Returns 200
 * with a `BuildPathResponseBody` for `build_path` and `unavailable`; an error
 * envelope otherwise. A rejection is handed to the router's error handler.
 */
export function createBuildPathHandler(deps: BuildPathRouteDependencies): RequestHandler {
  return async (req, res, next) => {
    try {
      const parsed = parseBuildPathRequest({
        matchId: req.params.matchId,
        gameName: req.query.gameName,
        tagLine: req.query.tagLine,
      });
      if (!parsed.ok) {
        res.status(parsed.response.status).json(parsed.response.body);
        return;
      }

      const result = await deps.buildPathOrchestrator.getBuildPath(parsed.matchId, parsed.riotId);

      if (result.kind === 'build_path') {
        const body: BuildPathResponseBody = {
          kind: 'build_path',
          buildPath: result.slice.buildPath,
          skillOrder: result.slice.skillOrder,
          reconciled: result.slice.reconciled,
        };
        res.status(200).json(body);
        return;
      }

      if (result.kind === 'unavailable') {
        const body: BuildPathResponseBody = { kind: 'unavailable', reason: result.reason };
        res.status(200).json(body);
        return;
      }

      if (result.code === 'PLAYER_NOT_FOUND') {
        const response = playerNotFoundError(parsed.riotId.gameName, parsed.riotId.tagLine);
        res.status(response.status).json(response.body);
        return;
      }

      if (result.code === 'VALIDATION_FAILED') {
        const response = malformedMatchIdError();
        res.status(response.status).json(response.body);
        return;
      }

      const response = apiErrorFor(result.code, result.retriable);
      if (result.code === 'RATE_LIMITED') {
        res.setHeader('Retry-After', String(RATE_LIMIT_COOLDOWN_SECONDS));
      }
      res.status(response.status).json(response.body);
    } catch (error) {
      next(error);
    }
  };
}
