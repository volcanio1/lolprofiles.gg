/**
 * Scouting Orchestrator (clash-scouting Requirement 1 / design.md task 5.1).
 *
 * The pipeline (design.md):
 *  1. Resolve the Riot ID to a PUUID (Account-V1 by-riot-id, Discovery_Region)
 *     then to a Resolved_Platform (Region_Resolver) — same as the Live Game and
 *     main lookup pipelines; the visitor supplies no region.
 *  2. `cacheOrFetch` Clash-V1 players-by-puuid. An empty array is `not_registered`
 *     — a state, not an error (Requirement 1.3).
 *  3. More than one registration and no `teamId` supplied -> `multiple_teams`,
 *     naming every team the player is registered to (Requirement 1.5).
 *  4. Otherwise resolve the single target team, `cacheOrFetch` it, and enrich its
 *     roster via the Roster Enricher. A team-endpoint 404 for a referenced team
 *     id is also `not_registered` (the registration outlived the team, error
 *     table row 3) rather than an error.
 *  5. Read the Tournament_Schedule from cache ONLY — this module holds no
 *     `ClashTournamentSource` reference, so a request-path tournaments call is a
 *     compile error, not a review finding (Requirement 4.1). A miss or a stale
 *     entry degrades `tournament` to `null` rather than blocking the report
 *     (Requirement 4.4).
 *  6. Run the Scouting Insight Engine over the assembled report.
 *
 * Error outcomes map through the same table the Live Game orchestrator uses;
 * no new `ErrorCode` is introduced (Requirements 1.1, 1.3, 1.5 only add states,
 * not error codes).
 */

import { isStale, TTL_BY_ENDPOINT, type CacheStore } from '../cache';
import type { ErrorCode } from '../orchestrator';
import { cacheOrFetch, isCacheOrFetchFailure, type RiotApiFailure } from '../orchestrator/cacheOrFetch';
import { DEFAULT_REGION, type PlatformRoutingValue, type RegionalRoutingValue } from '../region';
import { createRegionResolver, type RegionResolver } from '../regionResolver';
import type { AccountDto, RiotApiClient } from '../riotApiClient';
import { createRosterEnricher, type RosterEnricher } from './enricher';
import { computeScoutingInsights } from './scoutingInsights';
import type { ClashPlayerDto, ClashTeamDto, ClashTournamentDto, ClashTeamSummary, ScoutingReport } from './types';

export type ScoutingResult =
  | { kind: 'report'; report: ScoutingReport }
  | { kind: 'multiple_teams'; teams: readonly ClashTeamSummary[] }
  | { kind: 'not_registered' }
  | {
      kind: 'error';
      code: ErrorCode;
      retriable: boolean;
      /**
       * Set only for `UNSUPPORTED_PLATFORM` — the platform Riot itself named.
       * Additive beyond design.md's declared `ScoutingResult` (which omits it),
       * matching the same field `LiveGameResult` and `LookupResult` already carry
       * for the identical outcome, so the API layer can name the platform in its
       * error message the same way the other two routes do.
       */
      platform?: string;
    };

export interface ScoutingOrchestrator {
  scout(riotId: { gameName: string; tagLine: string }, teamId?: string): Promise<ScoutingResult>;
}

export interface ScoutingOrchestratorOptions {
  client: RiotApiClient;
  cache: CacheStore;
  now?: () => number;
  /** Any regional host answers Account-V1; fixed once, never a visitor input. */
  discoveryRegion?: RegionalRoutingValue;
  /** Injected in tests; production builds one from `client` / `cache`. */
  regionResolver?: RegionResolver;
  rosterEnricher?: RosterEnricher;
}

/** Mirrors `liveGame/orchestrator.ts`'s `failureToError` / `orchestrator/index.ts`'s `errorFor`. */
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

function teamSummaryOf(team: ClashTeamDto): ClashTeamSummary {
  return { id: team.id, name: team.name, abbreviation: team.abbreviation, tier: team.tier, iconId: team.iconId };
}

export function createScoutingOrchestrator(options: ScoutingOrchestratorOptions): ScoutingOrchestrator {
  const { client, cache } = options;
  const now = options.now ?? Date.now;
  const discoveryRegion = options.discoveryRegion ?? DEFAULT_REGION;
  const regionResolver =
    options.regionResolver ?? createRegionResolver({ client, cache, discoveryRegion, now });
  const rosterEnricher = options.rosterEnricher ?? createRosterEnricher({ client, cache, now });

  async function fetchTeam(
    platform: PlatformRoutingValue,
    teamId: string,
  ): Promise<{ value: ClashTeamDto } | { notRegistered: true } | { error: ReturnType<typeof failureToError> }> {
    const outcome = await cacheOrFetch<ClashTeamDto>(
      cache,
      { endpoint: 'clashTeam', routingValue: platform, params: { teamId } },
      TTL_BY_ENDPOINT.clashTeam,
      () => client.getClashTeam(platform, teamId),
      now,
    );
    if (isCacheOrFetchFailure(outcome)) {
      // error table row 3: a stale registration outliving its team is `not_registered`, not an error.
      if (outcome.failure.kind === 'not_found') {
        return { notRegistered: true };
      }
      return { error: failureToError(outcome.failure) };
    }
    return { value: outcome.value };
  }

  /**
   * Requirement 4.4: read-only, never fetches. A miss or a stale entry (the
   * refresher failed to keep up, or has not run yet) yields `null` rather than
   * blocking the report.
   */
  async function readTournament(
    platform: PlatformRoutingValue,
    tournamentId: number,
  ): Promise<ScoutingReport['tournament']> {
    let entry;
    try {
      entry = await cache.get<ClashTournamentDto[]>({
        endpoint: 'tournamentSchedule',
        routingValue: platform,
        params: {},
      });
    } catch {
      return null;
    }
    if (entry === undefined || isStale(entry, now())) {
      return null;
    }
    const schedule = Array.isArray(entry.value) ? entry.value : [];
    const found = schedule.find((tournament) => tournament.id === tournamentId);
    return found === undefined ? null : { id: found.id, nameKey: found.nameKey, nameKeySecondary: found.nameKeySecondary };
  }

  async function scout(
    riotId: { gameName: string; tagLine: string },
    teamId?: string,
  ): Promise<ScoutingResult> {
    // --- 1a. Riot ID -> PUUID (shares the `account` cache with every other orchestrator)
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

    // --- 1b. PUUID -> Resolved_Platform (visitor supplies no region)
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

    // --- 2. Clash-V1 players-by-puuid
    const registrations = await cacheOrFetch<ClashPlayerDto[]>(
      cache,
      { endpoint: 'clashPlayers', routingValue: platform, params: { puuid } },
      TTL_BY_ENDPOINT.clashPlayers,
      () => client.getClashPlayersByPuuid(platform, puuid),
      now,
    );
    if (isCacheOrFetchFailure(registrations)) {
      return failureToError(registrations.failure);
    }
    const active = Array.isArray(registrations.value) ? registrations.value : [];
    if (active.length === 0) {
      return { kind: 'not_registered' }; // Requirement 1.3
    }

    // --- 3. multiple registrations, no teamId -> a picker
    if (teamId === undefined && active.length > 1) {
      const outcomes = await Promise.all(active.map((registration) => fetchTeam(platform, registration.teamId)));
      const teams = outcomes
        .filter((outcome): outcome is { value: ClashTeamDto } => 'value' in outcome)
        .map((outcome) => teamSummaryOf(outcome.value));
      if (teams.length === 0) {
        // every referenced team was stale (error table row 3) — the whole
        // picker degrades to the same state a single stale registration would.
        return { kind: 'not_registered' };
      }
      return { kind: 'multiple_teams', teams };
    }

    // --- 4. single target team
    const targetTeamId = teamId ?? active[0].teamId;
    const teamOutcome = await fetchTeam(platform, targetTeamId);
    if ('notRegistered' in teamOutcome) {
      return { kind: 'not_registered' };
    }
    if ('error' in teamOutcome) {
      return teamOutcome.error;
    }
    const team = teamOutcome.value;

    // --- roster enrichment + tournament + insights
    const [roster, tournament] = await Promise.all([
      rosterEnricher.enrichAll(platform, region, team.players),
      readTournament(platform, team.tournamentId),
    ]);

    const withoutInsights: ScoutingReport = {
      team: {
        id: team.id,
        name: team.name,
        abbreviation: team.abbreviation,
        tier: team.tier,
        iconId: team.iconId,
        captainPuuid: team.captain,
      },
      tournament,
      roster,
      insights: { banRecommendations: [], positionMismatches: [], stackCohesion: 0 },
    };

    return { kind: 'report', report: { ...withoutInsights, insights: computeScoutingInsights(withoutInsights) } };
  }

  return { scout };
}
