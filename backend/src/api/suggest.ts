/**
 * API layer — `GET /api/players/suggest`.
 *
 * The autocomplete's only backend surface (specs/autofill-search/ Requirement 1).
 * It answers a name-prefix query purely from `looked_up_players` — no Riot API
 * call, no Cache_Store access, no lookup orchestration — and projects each hit to
 * a PUUID-free shape.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. A NOT-YET-USEFUL QUERY IS AN EMPTY 200, NEVER A 400 (Requirement 1.5). An
 *    absent, too-short, or `#`-containing `q` is the normal state of a field being
 *    typed into, not a client error. `q` arriving as an array (`?q=a&q=b`) is
 *    treated as absent for the same reason — there is no single prefix to match.
 *
 * 2. A STORE FAILURE DEGRADES TO "NO SUGGESTIONS", IT DOES NOT SURFACE
 *    (Requirement 1.8). `searchByNamePrefix` rejecting is logged once via the
 *    injected `onError` sink and answered with `[]` and a 200, so a database
 *    problem never turns the search box red.
 *
 * 3. THE DISABLED STORE NEEDS NO SPECIAL CASE (Requirement 1.7). The no-op
 *    `LookedUpPlayerStore` returns `[]` from `searchByNamePrefix`, so an unset
 *    `MONGODB_URI` produces an empty array through the ordinary path.
 *
 * 4. THE RESPONSE IS A BARE JSON ARRAY, not an envelope, matching how the hook
 *    consumes it. Each row carries exactly `gameName`, `tagLine`, `profileIconId`
 *    and `region`; `puuid` and `lastLookedUpAt` are dropped here (Requirements
 *    1.3 / 1.4).
 */

import type { RequestHandler } from 'express';
import { createNoopLookedUpPlayerStore, type LookedUpPlayerStore } from '../db/lookedUpPlayerStore';

/** specs/autofill-search/ design.md — mirrored by the frontend's own constant. */
export const MIN_QUERY_LENGTH = 2;
/** specs/autofill-search/ design.md — the most Suggestions returned or rendered. */
export const MAX_SUGGESTIONS = 8;

/** One dropdown row: a Looked_Up_Player projected to what the UI shows (Requirement 1.3). */
export interface PlayerSuggestion {
  gameName: string;
  tagLine: string;
  profileIconId: number | null;
  region: string;
}

export interface SuggestRouteDependencies {
  /**
   * Optional so existing callers and tests are unaffected; defaults to the no-op
   * store, which is also the runtime state when `MONGODB_URI` is unset.
   */
  lookedUpPlayerStore?: LookedUpPlayerStore;
  /** Requirement 1.8 sink. Called once with the rejection before the empty 200. */
  onError?: (error: unknown) => void;
}

/**
 * Requirement 1.6. Clamps `limit` to `1..MAX_SUGGESTIONS`, defaulting to
 * `MAX_SUGGESTIONS` when it is absent, repeated, or unparseable. A fractional
 * value is truncated toward zero before clamping.
 */
export function clampLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return MAX_SUGGESTIONS;
  }
  const truncated = Math.trunc(parsed);
  if (truncated < 1) {
    return 1;
  }
  return truncated > MAX_SUGGESTIONS ? MAX_SUGGESTIONS : truncated;
}

/** Requirement 1.5. A query worth issuing a store read for. */
export function isAnswerableQuery(query: string): boolean {
  return query.length >= MIN_QUERY_LENGTH && !query.includes('#');
}

/**
 * `GET /api/players/suggest?q=<prefix>&limit=<n>`. Always 200: a bare array of
 * Suggestions on success, `[]` for a not-yet-useful query, a disabled store, or a
 * store failure (decisions 1–3).
 */
export function createSuggestHandler(deps: SuggestRouteDependencies): RequestHandler {
  const store = deps.lookedUpPlayerStore ?? createNoopLookedUpPlayerStore();

  return async (req, res) => {
    const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!isAnswerableQuery(raw)) {
      res.status(200).json([]);
      return;
    }

    const limit = clampLimit(req.query.limit);

    let players;
    try {
      players = await store.searchByNamePrefix(raw, limit);
    } catch (error) {
      deps.onError?.(error);
      res.status(200).json([]);
      return;
    }

    const suggestions: PlayerSuggestion[] = players.map((player) => ({
      gameName: player.gameName,
      tagLine: player.tagLine,
      profileIconId: player.profileIconId,
      region: player.region,
    }));
    res.status(200).json(suggestions);
  };
}
