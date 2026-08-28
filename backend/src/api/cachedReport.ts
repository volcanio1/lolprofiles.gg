/**
 * API layer — `GET /api/players/report`.
 *
 * specs/autofill-search/ Requirement 9: serves the most recent stored
 * `ProfileReport` for a player to a dropdown selection, so the profile renders
 * instantly without a live lookup. It resolves the name to a PUUID from
 * `looked_up_players` (no Riot call), reads that PUUID's Report_Snapshot, and
 * returns it only when it is younger than `SNAPSHOT_MAX_AGE_MS`.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. EVERY NON-HIT IS `{ source: "miss" }` WITH A 200 (Requirement 9.4). A name
 *    nobody has looked up, a player with no snapshot, a stale snapshot, a blank
 *    parameter, a disabled store, and a store failure are all the same outcome to
 *    the caller: "no cached report, do a live lookup." Never a 404, never an error
 *    envelope.
 *
 * 2. THE AGE CHECK IS HERE, NOT LEFT TO THE TTL INDEX (Requirement 8.8 / 9.4).
 *    Mongo's TTL monitor only runs about once a minute, so a snapshot can linger
 *    briefly past 15 days; this endpoint rejects it on `fetchedAt` regardless.
 *
 * 3. NO RIOT CALL, NO RATE-LIMIT RESERVATION, NO ORCHESTRATION (Requirement 9.7).
 *    Two indexed reads and a projection.
 */

import type { RequestHandler } from 'express';
import { PROFILE_REPORT_TTL_SECONDS } from '../db/collections';
import { createNoopLookedUpPlayerStore, type LookedUpPlayerStore } from '../db/lookedUpPlayerStore';
import { createNoopProfileSnapshotStore, type ProfileSnapshotStore } from '../db/profileSnapshotStore';
import type { ProfileReport } from '../orchestrator';

/** specs/autofill-search/ Requirement 9.4 — mirrored by the frontend's own constant. */
export const SNAPSHOT_MAX_AGE_MS = PROFILE_REPORT_TTL_SECONDS * 1000;

/** specs/autofill-search/ Requirement 10.4 — mirrored by the frontend's own constant. */
export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export type CachedReportResponse =
  | { source: 'cache'; report: ProfileReport; fetchedAt: string }
  | { source: 'miss' };

export interface CachedReportRouteDependencies {
  lookedUpPlayerStore?: LookedUpPlayerStore;
  profileSnapshotStore?: ProfileSnapshotStore;
  /** Injected clock, shared with the rest of the app. */
  now: () => number;
  /** Requirement 9.5 sink; called once with a rejection before the miss. */
  onError?: (error: unknown) => void;
}

const MISS: CachedReportResponse = { source: 'miss' };

/**
 * `GET /api/players/report?gameName=<g>&tagLine=<t>`. Always 200: `{ source:
 * "cache", report, fetchedAt }` for a fresh snapshot, `{ source: "miss" }` for
 * anything else (decision 1).
 */
export function createCachedReportHandler(deps: CachedReportRouteDependencies): RequestHandler {
  const lookedUpPlayerStore = deps.lookedUpPlayerStore ?? createNoopLookedUpPlayerStore();
  const profileSnapshotStore = deps.profileSnapshotStore ?? createNoopProfileSnapshotStore();

  return async (req, res) => {
    const gameName = typeof req.query.gameName === 'string' ? req.query.gameName.trim() : '';
    const tagLine = typeof req.query.tagLine === 'string' ? req.query.tagLine.trim() : '';
    if (gameName === '' || tagLine === '') {
      res.status(200).json(MISS); // Requirement 9.6
      return;
    }

    try {
      const player = await lookedUpPlayerStore.findByRiotId(gameName, tagLine);
      if (player === null) {
        res.status(200).json(MISS); // Requirement 9.2/9.4
        return;
      }

      const stored = await profileSnapshotStore.get(player.puuid);
      if (stored === null || deps.now() - stored.fetchedAt >= SNAPSHOT_MAX_AGE_MS) {
        res.status(200).json(MISS); // Requirement 9.4 (decision 2)
        return;
      }

      const body: CachedReportResponse = {
        source: 'cache',
        report: stored.report,
        fetchedAt: new Date(stored.fetchedAt).toISOString(),
      };
      res.status(200).json(body);
    } catch (error) {
      deps.onError?.(error); // Requirement 9.5
      res.status(200).json(MISS);
    }
  };
}
