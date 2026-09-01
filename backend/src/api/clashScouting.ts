/**
 * API layer — `GET /api/clash/scout?gameName=<name>&tagLine=<tag>&teamId=<id>`.
 *
 * The HTTP boundary for the Clash Scouting feature. Validates the Riot ID query
 * parameters through the same validator every other route uses, delegates to the
 * Scouting Orchestrator, and maps the typed `ScoutingResult` onto a status and
 * body. No business logic — no Riot call, no cache access.
 *
 *  - Requirement 1.1/1.3/1.5: `200` for `report`, `multiple_teams` and
 *    `not_registered` alike — all three are successful outcomes, not errors.
 *  - `teamId` is an optional third query param, read the same way `gameName` and
 *    `tagLine` are; only meaningful when the player holds more than one
 *    registration.
 *  - Error outcomes map through `api/errors.ts`; no new error code beyond those
 *    the orchestrator already produces (all inherited from region resolution /
 *    the shared Riot failure table) — same discipline as `api/liveGame.ts`.
 */

import type { RequestHandler } from 'express';
import type { ScoutingOrchestrator } from '../clashScouting/orchestrator';
import type { ClashTeamSummary, ScoutingReport } from '../clashScouting/types';
import { validateRiotId } from '../validator';
import {
  RATE_LIMIT_COOLDOWN_SECONDS,
  apiErrorFor,
  missingFieldError,
  noLolAccountError,
  playerNotFoundError,
  unsupportedPlatformError,
  validationError,
} from './errors';
import { readQueryString } from './buildPath';

export interface ClashScoutingRouteDependencies {
  scoutingOrchestrator: ScoutingOrchestrator;
}

export type ClashScoutResponseBody =
  | { kind: 'report'; report: ScoutingReport }
  | { kind: 'multiple_teams'; teams: readonly ClashTeamSummary[] }
  | { kind: 'not_registered' };

export function createClashScoutingHandler(deps: ClashScoutingRouteDependencies): RequestHandler {
  return async (req, res, next) => {
    try {
      const gameName = readQueryString(req.query.gameName);
      const tagLine = readQueryString(req.query.tagLine);
      if (gameName === undefined) {
        const response = missingFieldError('gameName', 'A gameName query parameter is required.');
        res.status(response.status).json(response.body);
        return;
      }
      if (tagLine === undefined) {
        const response = missingFieldError('tagLine', 'A tagLine query parameter is required.');
        res.status(response.status).json(response.body);
        return;
      }

      const validation = validateRiotId(`${gameName}#${tagLine}`);
      if (!validation.ok || validation.riotId === undefined) {
        const response = validationError(validation.errorCode ?? 'MISSING_HASH');
        res.status(response.status).json(response.body);
        return;
      }

      const teamId = readQueryString(req.query.teamId);
      const result = await deps.scoutingOrchestrator.scout(validation.riotId, teamId);

      if (result.kind === 'report') {
        const body: ClashScoutResponseBody = { kind: 'report', report: result.report };
        res.status(200).json(body);
        return;
      }
      if (result.kind === 'multiple_teams') {
        const body: ClashScoutResponseBody = { kind: 'multiple_teams', teams: result.teams };
        res.status(200).json(body);
        return;
      }
      if (result.kind === 'not_registered') {
        const body: ClashScoutResponseBody = { kind: 'not_registered' };
        res.status(200).json(body);
        return;
      }

      if (result.code === 'PLAYER_NOT_FOUND') {
        const response = playerNotFoundError(validation.riotId.gameName, validation.riotId.tagLine);
        res.status(response.status).json(response.body);
        return;
      }
      if (result.code === 'NO_LOL_ACCOUNT') {
        const response = noLolAccountError(validation.riotId.gameName, validation.riotId.tagLine);
        res.status(response.status).json(response.body);
        return;
      }
      if (result.code === 'UNSUPPORTED_PLATFORM') {
        const response = unsupportedPlatformError(result.platform ?? '');
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
