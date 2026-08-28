/**
 * API layer — `GET /api/live-game?gameName=<name>&tagLine=<tag>`.
 *
 * The HTTP boundary for the Live Game feature. Validates the Riot ID query
 * parameters through the same validator every other route uses, delegates to the
 * Live Game Orchestrator, and maps the typed `LiveGameResult` onto a status and
 * body. No business logic — no Riot call, no cache access.
 *
 *  - Requirement 1.2/1.3: `GET` (a pure read, so the frontend poll is a plain
 *    conditional fetch); both `in_game` and `not_in_game` are `200` — not being
 *    in a game is a state, never an error.
 *  - Requirement 1.5: two query params, recombined into `gameName#tagLine` and
 *    run through `validateRiotId` unchanged — the same rules as `/api/lookup`,
 *    not a second implementation. No region parameter.
 *  - Error outcomes map through `api/errors.ts`; no error code beyond those the
 *    orchestrator already produces (all inherited from region resolution / the
 *    shared Riot failure table).
 */

import type { RequestHandler } from 'express';
import type { LiveGameLobby } from '../liveGame/types';
import type { LiveGameOrchestrator } from '../liveGame/orchestrator';
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

export interface LiveGameRouteDependencies {
  liveGameOrchestrator: LiveGameOrchestrator;
}

export type LiveGameResponseBody =
  | { kind: 'in_game'; lobby: LiveGameLobby }
  | { kind: 'not_in_game' };

export function createLiveGameHandler(deps: LiveGameRouteDependencies): RequestHandler {
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

      const result = await deps.liveGameOrchestrator.getLiveGame(validation.riotId);

      if (result.kind === 'in_game') {
        const body: LiveGameResponseBody = { kind: 'in_game', lobby: result.lobby };
        res.status(200).json(body);
        return;
      }
      if (result.kind === 'not_in_game') {
        const body: LiveGameResponseBody = { kind: 'not_in_game' };
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
