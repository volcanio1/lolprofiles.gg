/**
 * Roster Enricher (clash-scouting Requirement 2 / design.md task 4.1).
 *
 * Clash-V1's roster gives five PUUIDs, declared positions and a captain flag.
 * This joins onto each member the same three enrichment calls the live-game
 * Participant Enricher already makes (Account-V1, League-V4, Champion-Mastery),
 * plus a bounded Recent_Form fetched from Match-V5, and derives an Observed_Role
 * from it.
 *
 *  - 2.4/2.5: every enrichment call goes through `readOrNull`, so a failed call
 *    degrades exactly one `RosterCard` field to `null`, never the card and never
 *    the report — the same no-failure-mode contract as `liveGame/enricher.ts`.
 *  - 2.4: Recent_Form is capped at `RECENT_FORM_MATCH_LIMIT` (10) match-ids per
 *    member, matching design.md's stated worst case of 55 Match-V5 calls.
 *  - 2.6: an individual match-detail failure within a member's Recent_Form
 *    excludes that match and continues — `readOrNull` already gives this for
 *    free, exactly as the main lookup orchestrator's match-detail fan-out does.
 *  - 2.7: an empty League-V4 array is a successful "unranked" result: `[]`, not
 *    `null`. Reuses `rankedByQueueOf`/`toLeagueEntries` from the main pipeline
 *    rather than re-deriving win-rate math.
 *
 * `Observed_Role` is derived as the most frequent raw `teamPosition` (falling
 * back to `role`) across Recent_Form, tie-broken toward whichever role appears
 * first in the (newest-first) match-id order — an interpretation choice, since
 * design.md specifies only that it is "derived from Recent_Form" and leaves the
 * exact rule open. Deliberately NOT `orchestrator/mapping.ts`'s `roleOf`: that
 * helper renames `UTILITY` to the display string `Support`, which would never
 * equal `DeclaredPosition`'s raw `'UTILITY'` and would make every support's
 * position mismatch un-detectable.
 *
 * Match details are shared cache with the main lookup and with other scouted
 * members (design.md: "scouting a five-stack is much cheaper than scouting five
 * strangers"), since `matchDetail` is retained indefinitely and keyed only by
 * match id.
 */

import { TTL_BY_ENDPOINT, type CacheKey, type CacheStore } from '../cache';
import { rankedByQueueOf, type RankedQueueStanding } from '../insight/stats';
import { cacheOrFetch, isCacheOrFetchFailure } from '../orchestrator/cacheOrFetch';
import { toLeagueEntries } from '../orchestrator/mapping';
import type { PlatformRoutingValue, RegionalRoutingValue } from '../region';
import type {
  AccountDto,
  ChampionMasteryDto,
  LeagueEntryDto,
  MatchDto,
  RiotApiClient,
  RiotApiResult,
} from '../riotApiClient';
import type { ChampionPoolEntry, ClashTeamPlayerDto, RecentFormEntry, RosterCard } from './types';

/** design.md: bounds the worst case to 55 Match-V5 calls for a five-member roster (Requirement 2.4). */
export const RECENT_FORM_MATCH_LIMIT = 10;

/**
 * Champion-Mastery-V4's top-masteries-by-puuid `count`. Not specified by the
 * spec beyond "top champion masteries" — 5 mirrors the size a Clash captain
 * would actually scan before a draft.
 */
export const CHAMPION_POOL_SIZE = 5;

export interface RosterEnricherOptions {
  client: RiotApiClient;
  cache: CacheStore;
  now: () => number;
}

export interface RosterEnricher {
  enrichAll(
    platform: PlatformRoutingValue,
    region: RegionalRoutingValue,
    members: readonly ClashTeamPlayerDto[],
  ): Promise<readonly RosterCard[]>;
}

/**
 * Raw `teamPosition`/`role`, deliberately NOT `orchestrator/mapping.ts`'s
 * display-normalized `roleOf` (see module docblock).
 */
function rawRoleOf(participant: { teamPosition?: string; role?: string }): string {
  const teamPosition = typeof participant.teamPosition === 'string' ? participant.teamPosition.trim() : '';
  if (teamPosition.length > 0) {
    return teamPosition;
  }
  return typeof participant.role === 'string' ? participant.role.trim() : '';
}

/** Most frequent non-blank role, tie-broken toward the earliest (most recent) match. */
function observedRoleOf(recentForm: readonly RecentFormEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const entry of recentForm) {
    if (entry.role === '') {
      continue;
    }
    counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const entry of recentForm) {
    if (entry.role === '') {
      continue;
    }
    const count = counts.get(entry.role) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = entry.role;
    }
  }
  return best;
}

export function createRosterEnricher(options: RosterEnricherOptions): RosterEnricher {
  const { client, cache, now } = options;

  async function readOrNull<T>(
    key: CacheKey,
    ttlMs: number | 'infinite',
    fetch: () => Promise<RiotApiResult<T>>,
  ): Promise<T | null> {
    const outcome = await cacheOrFetch<T>(cache, key, ttlMs, fetch, now);
    return isCacheOrFetchFailure(outcome) ? null : outcome.value;
  }

  /** Requirement 2.4/2.6: bounded match-id window, individually-failing details excluded. */
  async function fetchRecentForm(region: RegionalRoutingValue, puuid: string): Promise<RecentFormEntry[]> {
    const matchIds = await readOrNull<string[]>(
      { endpoint: 'matchIds', routingValue: region, params: { puuid } },
      TTL_BY_ENDPOINT.matchIds,
      () => client.getMatchIdsByPuuid(region, puuid, RECENT_FORM_MATCH_LIMIT),
    );
    const ids = (Array.isArray(matchIds) ? matchIds : []).slice(0, RECENT_FORM_MATCH_LIMIT);

    const matches = await Promise.all(
      ids.map((matchId) =>
        readOrNull<MatchDto>(
          { endpoint: 'matchDetail', routingValue: region, params: { matchId } },
          TTL_BY_ENDPOINT.matchDetail,
          () => client.getMatchById(region, matchId),
        ),
      ),
    );

    const entries: RecentFormEntry[] = [];
    for (const match of matches) {
      if (match === null) {
        continue; // Requirement 2.6: exclude, keep going.
      }
      const participant = match.info.participants.find((candidate) => candidate.puuid === puuid);
      if (participant === undefined) {
        continue;
      }
      entries.push({
        matchId: match.metadata.matchId,
        championId: typeof participant.championId === 'number' ? participant.championId : 0,
        role: rawRoleOf(participant),
        win: participant.win,
        participantPuuids: match.metadata.participants,
      });
    }
    return entries;
  }

  async function enrichOne(
    platform: PlatformRoutingValue,
    region: RegionalRoutingValue,
    member: ClashTeamPlayerDto,
  ): Promise<RosterCard> {
    const { puuid } = member;

    const [account, leagueDtos, masteryDtos, recentForm] = await Promise.all([
      readOrNull<AccountDto>(
        { endpoint: 'account', routingValue: region, params: { puuid } },
        TTL_BY_ENDPOINT.account,
        () => client.getAccountByPuuid(region, puuid),
      ),
      readOrNull<LeagueEntryDto[]>(
        { endpoint: 'league', routingValue: platform, params: { puuid } },
        TTL_BY_ENDPOINT.league,
        () => client.getLeagueEntriesByPuuid(platform, puuid),
      ),
      readOrNull<ChampionMasteryDto[]>(
        { endpoint: 'championMasteryTop', routingValue: platform, params: { puuid, count: String(CHAMPION_POOL_SIZE) } },
        TTL_BY_ENDPOINT.championMasteryTop,
        () => client.getChampionMasteryTop(platform, puuid, CHAMPION_POOL_SIZE),
      ),
      fetchRecentForm(region, puuid),
    ]);

    const rankedEntries: readonly RankedQueueStanding[] | null =
      leagueDtos === null ? null : Object.values(rankedByQueueOf(toLeagueEntries(leagueDtos)));

    const championPool: readonly ChampionPoolEntry[] | null =
      masteryDtos === null
        ? null
        : masteryDtos.map((dto) => ({
            championId: dto.championId,
            masteryPoints: dto.championPoints,
            masteryLevel: dto.championLevel,
          }));

    return {
      puuid,
      declaredPosition: member.position,
      isCaptain: member.role === 'CAPTAIN',
      riotId:
        account !== null && typeof account.gameName === 'string' && typeof account.tagLine === 'string'
          ? { gameName: account.gameName, tagLine: account.tagLine }
          : null,
      rankedEntries,
      championPool,
      recentForm,
      observedRole: recentForm.length === 0 ? null : observedRoleOf(recentForm), // Requirement 3.6
    };
  }

  return {
    async enrichAll(platform, region, members) {
      // Requirement 2.5: one card per member, in roster order. Every leaf is
      // failure-swallowing, so `Promise.all` here never rejects.
      return Promise.all(members.map((member) => enrichOne(platform, region, member)));
    },
  };
}
