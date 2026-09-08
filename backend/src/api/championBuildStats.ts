/**
 * API layer — `GET /api/champions/:championKey/build-stats?role=&rank=&region=`.
 *
 * The HTTP boundary for the champion build page (specs/champion-build-stats/
 * Requirements 10-12). A pure read of pre-aggregated data through
 * `ChampionStatsStore`:
 *
 *  - Requirement 10.2: no `RateLimitManager`, no Riot client, no lookup
 *    orchestration is injected here — the handler cannot make a rate-limited
 *    call, and tests assert that structurally (the dependency object has no seam
 *    for one).
 *  - Requirement 10.3: an unknown `:championKey` is a 404, decided from the
 *    bundled key set before the store is ever touched.
 *  - Requirement 10.4: an unknown `role` / `rank` / `region` is clamped to that
 *    filter's default and the applied value is reported back in `filtersApplied`
 *    — never a 400.
 *  - Requirement 12.3: a disabled store (the state until the crawler pipeline
 *    lands), a store that has never seen the champion, or a store that throws all
 *    produce a 200 with `popular` / `highestWinRate` null and empty `meta` option
 *    lists. The page then shows Not_Enough_Data everywhere (Requirement 14.1).
 *
 * `popular: null` / `highestWinRate: null` decisions (display floor, `MIN_SAMPLE`
 * gate, modal threshold) are the store's — the handler only serializes.
 */

import type { RequestHandler } from 'express';
import { championDisplayName, isKnownChampionKey } from '../champions/championKeys';
import {
  DEFAULT_RANK,
  DEFAULT_REGION,
  DEFAULT_ROLE,
  clampRank,
  clampRegion,
  clampRole,
  type RankBucket,
  type Role,
} from '../champions/buildStatsConstants';
import type {
  ChampionBuild,
  ChampionStatsMeta,
  ChampionStatsStore,
} from '../db/championStatsStore';
import { readQueryString } from './buildPath';

export interface ChampionBuildStatsRouteDependencies {
  championStatsStore: ChampionStatsStore;
  /** Called once with the rejection before the empty-state 200 (Requirement 12.3). */
  onError?: (error: unknown) => void;
}

export interface ChampionBuildStatsResponseBody {
  champion: { key: string; name: string };
  filtersApplied: { role: Role; rank: RankBucket; region: string };
  meta: ChampionStatsMeta;
  popular: ChampionBuild | null;
  highestWinRate: ChampionBuild | null;
}

/** The `meta` block when the store has nothing for this champion (Requirement 12.3). */
function emptyMeta(): ChampionStatsMeta {
  return {
    patch: '',
    lastUpdatedAt: 0,
    availableRoles: [],
    defaultRole: DEFAULT_ROLE,
    availableRanks: [],
    defaultRank: DEFAULT_RANK,
    availableRegions: [],
    overall: { winRate: 0, pickRate: 0, totalGames: 0 },
  };
}

export function createChampionBuildStatsHandler(
  deps: ChampionBuildStatsRouteDependencies,
): RequestHandler {
  return async (req, res) => {
    const championKey = typeof req.params.championKey === 'string' ? req.params.championKey : '';

    if (!isKnownChampionKey(championKey)) {
      res.status(404).json({
        error: {
          code: 'CHAMPION_NOT_FOUND',
          message: `No champion is known by the key "${championKey}".`,
        },
      });
      return;
    }

    // Requirement 10.4: clamp, never reject. `role` / `rank` clamp against a
    // closed vocabulary; `region` clamps against the regions the store
    // advertises (v1: only `world`).
    const role = clampRole(readQueryString(req.query.role));
    const rank = clampRank(readQueryString(req.query.rank));
    const region = clampRegion(readQueryString(req.query.region), [DEFAULT_REGION]);
    const filtersApplied = { role, rank, region };

    let result: Awaited<ReturnType<ChampionStatsStore['getBuildStats']>>;
    try {
      result = await deps.championStatsStore.getBuildStats(championKey, filtersApplied);
    } catch (error) {
      deps.onError?.(error);
      result = null;
    }

    const body: ChampionBuildStatsResponseBody = {
      champion: { key: championKey, name: championDisplayName(championKey) },
      filtersApplied,
      meta: result?.meta ?? emptyMeta(),
      popular: result?.popular ?? null,
      highestWinRate: result?.highestWinRate ?? null,
    };
    res.status(200).json(body);
  };
}
