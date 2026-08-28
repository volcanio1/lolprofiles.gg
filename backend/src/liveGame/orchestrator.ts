/**
 * Live Game Orchestrator (live-game Requirement 1).
 *
 * The pipeline (design.md):
 *  1. Resolve the Riot ID to a PUUID (Account-V1 by-riot-id, Discovery_Region)
 *     then to a Resolved_Platform (Region_Resolver, `lookup-pipeline-fixes`). The
 *     visitor supplies no region (Requirement 1.5).
 *  2. `cacheOrFetch` the active game against the 30-second `activeGame` entry.
 *  3. A Spectator-V5 `not_found` short-circuits to `not_in_game` — a state, not
 *     an error (Requirement 1.2) — and is **not** written to the cache as an
 *     absence. `cacheOrFetch` only writes on success, so this holds structurally:
 *     an immediately following request re-queries Riot.
 *  4. Enrich all participants (Participant Enricher), derive `matchId` as
 *     `${platformId}_${gameId}` (Requirement 5.3, no extra call), and run the
 *     Lobby Insight Engine over the assembled lobby.
 *
 * Error outcomes map through the same table the lookup pipeline uses
 * (`orchestrator/index.ts`'s `errorFor`); no new `ErrorCode` is introduced.
 */

import { TTL_BY_ENDPOINT, type CacheStore } from '../cache';
import type { ErrorCode } from '../orchestrator';
import { cacheOrFetch, isCacheOrFetchFailure, type RiotApiFailure } from '../orchestrator/cacheOrFetch';
import { DEFAULT_REGION, type RegionalRoutingValue } from '../region';
import { createRegionResolver, type RegionResolver } from '../regionResolver';
import type { AccountDto, RiotApiClient } from '../riotApiClient';
import { createParticipantEnricher, type ParticipantEnricher } from './enricher';
import { computeLobbyInsights } from './lobbyInsights';
import type { CurrentGameInfo, LiveGameLobby } from './types';

export type LiveGameResult =
  | { kind: 'in_game'; lobby: LiveGameLobby }
  | { kind: 'not_in_game' }
  | {
      kind: 'error';
      code: ErrorCode;
      retriable: boolean;
      /** Set only for `UNSUPPORTED_PLATFORM` — the platform string Riot named, for the route's message. */
      platform?: string;
    };

export interface LiveGameOrchestrator {
  getLiveGame(riotId: { gameName: string; tagLine: string }): Promise<LiveGameResult>;
}

export interface LiveGameOrchestratorOptions {
  client: RiotApiClient;
  cache: CacheStore;
  now?: () => number;
  /** Any regional host answers Account-V1; fixed once, never a visitor input. */
  discoveryRegion?: RegionalRoutingValue;
  /** Injected in tests; production builds one from `client` / `cache`. */
  regionResolver?: RegionResolver;
  enricher?: ParticipantEnricher;
}

/** Mirrors `orchestrator/index.ts`'s `errorFor` for a non-matchIds stage. */
function failureToError(failure: RiotApiFailure): { kind: 'error'; code: ErrorCode; retriable: boolean } {
  switch (failure.kind) {
    case 'auth_error':
      return { kind: 'error', code: 'AUTH_FAILURE', retriable: false };
    case 'timeout':
      return { kind: 'error', code: 'TIMEOUT', retriable: false };
    case 'rate_limited':
      return { kind: 'error', code: 'RATE_LIMITED', retriable: true };
    case 'network_error':
      return { kind: 'error', code: 'NETWORK_ERROR', retriable: true };
    case 'server_error':
      return { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true };
    case 'not_found':
      return { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: false };
  }
}

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function createLiveGameOrchestrator(options: LiveGameOrchestratorOptions): LiveGameOrchestrator {
  const { client, cache } = options;
  const now = options.now ?? Date.now;
  const discoveryRegion = options.discoveryRegion ?? DEFAULT_REGION;
  const regionResolver =
    options.regionResolver ?? createRegionResolver({ client, cache, discoveryRegion, now });
  const enricher = options.enricher ?? createParticipantEnricher({ client, cache, now });

  async function getLiveGame(riotId: { gameName: string; tagLine: string }): Promise<LiveGameResult> {
    // --- 1a. Riot ID -> PUUID (shares the `account` cache with the profile lookup)
    const account = await cacheOrFetch<AccountDto>(
      cache,
      { endpoint: 'account', routingValue: discoveryRegion, params: { gameName: riotId.gameName, tagLine: riotId.tagLine } },
      TTL_BY_ENDPOINT.account,
      () => client.getAccountByRiotId(discoveryRegion, riotId.gameName, riotId.tagLine),
      now,
    );
    if (isCacheOrFetchFailure(account)) {
      if (account.failure.kind === 'not_found') {
        return { kind: 'error', code: 'PLAYER_NOT_FOUND', retriable: false };
      }
      return failureToError(account.failure);
    }
    const puuid = typeof account.value?.puuid === 'string' ? account.value.puuid : '';
    if (puuid === '') {
      return { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true };
    }

    // --- 1b. PUUID -> Resolved_Platform (Requirement 1.5: no region asked)
    const resolution = await regionResolver.resolve(puuid);
    if (resolution.kind === 'no_lol_account') {
      return { kind: 'error', code: 'NO_LOL_ACCOUNT', retriable: false };
    }
    if (resolution.kind === 'unsupported_platform') {
      return { kind: 'error', code: 'UNSUPPORTED_PLATFORM', retriable: false, platform: resolution.platform };
    }
    if (resolution.kind === 'failed') {
      return failureToError(resolution.cause);
    }
    const { platform, region } = resolution;

    // --- 2/3. active game, 30s entry; `not_found` is a state and is not cached
    const active = await cacheOrFetch<CurrentGameInfo>(
      cache,
      { endpoint: 'activeGame', routingValue: platform, params: { puuid } },
      TTL_BY_ENDPOINT.activeGame,
      () => client.getActiveGameByPuuid(platform, puuid),
      now,
    );
    if (isCacheOrFetchFailure(active)) {
      if (active.failure.kind === 'not_found') {
        return { kind: 'not_in_game' }; // Requirement 1.2
      }
      return failureToError(active.failure);
    }

    // --- 4. assemble + insights
    const game = active.value;
    const participants = await enricher.enrichAll(platform, region, game.participants ?? []);

    const bannedChampionIds = (game.bannedChampions ?? [])
      .map((ban) => ban.championId)
      .filter((id) => typeof id === 'number' && id > 0);

    const withoutInsights: LiveGameLobby = {
      gameId: game.gameId,
      platformId: game.platformId,
      matchId: `${game.platformId}_${game.gameId}`,
      queueId: game.gameQueueConfigId,
      mapId: game.mapId,
      gameStartTime: positiveIntOrNull(game.gameStartTime), // Requirement 4.2: 0/absent => Pre_Game
      bannedChampionIds,
      participants,
      insights: { offChampion: [], oneTricks: [], rankSpread: null },
    };

    return { kind: 'in_game', lobby: { ...withoutInsights, insights: computeLobbyInsights(withoutInsights) } };
  }

  return { getLiveGame };
}
