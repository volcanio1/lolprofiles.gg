/**
 * Participant Enricher (live-game Requirement 2).
 *
 * Spectator-V5 gives ten participants as PUUID + champion id and nothing else.
 * This joins onto each the three things that make a Participant_Card readable —
 * Riot ID (Account-V1), ranked entries (League-V4), locked-champion mastery
 * (Champion-Mastery-V4) — and returns exactly one card per participant, in input
 * order.
 *
 *  - 2.4: every enrichment call is read through `readOrNull`, so the enricher has
 *    no failure mode of its own — a failed call degrades one field to `null`,
 *    never the card and never the lobby. A Champion-Mastery 404 (the player has
 *    never played the champion) also becomes `null`, so it reads the same as a
 *    failed call; the Lobby Insight Engine then does not flag them as
 *    off-champion, matching Requirement 3.2's "AND at least one ... mastery
 *    record exists".
 *  - 2.5: bot participants get a card with every enrichment field absent and no
 *    call issued.
 *  - 2.6: an empty League-V4 array is a successful "unranked" result — `[]`, not
 *    `null`.
 *  - 6.3/6.4: each enrichment call goes through `cacheOrFetch` against its own
 *    endpoint's retention (`account` 1h, `league` 10min, `championMastery` 1h) —
 *    NOT the 30-second active-game TTL — so following a game does not re-fetch
 *    ten ranks every poll. `cacheOrFetch` replaces a bare `enrich` wrapper here
 *    only to add that caching; its failure branch is still discarded to `null`,
 *    so the no-failure-mode contract above is unchanged.
 *
 * The fan-out is 3 calls per non-bot participant on a cold lobby, dispatched
 * concurrently; the Rate_Limit_Manager serialises them against its windows like
 * any other burst (design.md: ~0.15% of the granted budget, no batching warranted).
 */

import { TTL_BY_ENDPOINT, type CacheKey, type CacheStore } from '../cache';
import { cacheOrFetch, isCacheOrFetchFailure } from '../orchestrator/cacheOrFetch';
import { toLeagueEntries } from '../orchestrator/mapping';
import type { PlatformRoutingValue, RegionalRoutingValue } from '../region';
import type {
  AccountDto,
  ChampionMasteryDto,
  LeagueEntryDto,
  RiotApiClient,
  RiotApiResult,
} from '../riotApiClient';
import type { CurrentGameParticipant, ParticipantCard } from './types';

export interface ParticipantEnricherOptions {
  client: RiotApiClient;
  cache: CacheStore;
  now: () => number;
}

export interface ParticipantEnricher {
  enrichAll(
    platform: PlatformRoutingValue,
    region: RegionalRoutingValue,
    participants: readonly CurrentGameParticipant[],
  ): Promise<readonly ParticipantCard[]>;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A bot participant, or the shell every card starts from before enrichment. */
function baseCard(participant: CurrentGameParticipant): ParticipantCard {
  return {
    // Spectator-V5 occasionally returns a participant Riot will not identify
    // (`puuid: null` / absent) — a real player, but one the by-puuid enrichment
    // calls cannot resolve. Normalise to `''` so the card shape stays a string.
    puuid: typeof participant.puuid === 'string' ? participant.puuid : '',
    teamId: participant.teamId,
    championId: participant.championId,
    spell1Id: participant.spell1Id,
    spell2Id: participant.spell2Id,
    perkIds: participant.perks?.perkIds ?? [],
    isBot: participant.bot,
    riotId: null,
    rankedEntries: null,
    championMasteryPoints: null,
    championMasteryLevel: null,
  };
}

export function createParticipantEnricher(options: ParticipantEnricherOptions): ParticipantEnricher {
  const { client, cache, now } = options;

  async function readOrNull<T>(
    key: CacheKey,
    ttlMs: number | 'infinite',
    fetch: () => Promise<RiotApiResult<T>>,
  ): Promise<T | null> {
    const outcome = await cacheOrFetch<T>(cache, key, ttlMs, fetch, now);
    return isCacheOrFetchFailure(outcome) ? null : outcome.value;
  }

  async function enrichOne(
    platform: PlatformRoutingValue,
    region: RegionalRoutingValue,
    participant: CurrentGameParticipant,
  ): Promise<ParticipantCard> {
    const card = baseCard(participant);
    if (participant.bot || card.puuid === '') {
      return card; // a bot (2.5), or a participant Riot did not give a puuid for
    }

    const { puuid } = card;
    const { championId } = participant;
    const [account, leagueDtos, mastery] = await Promise.all([
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
      readOrNull<ChampionMasteryDto>(
        { endpoint: 'championMastery', routingValue: platform, params: { puuid, championId: String(championId) } },
        TTL_BY_ENDPOINT.championMastery,
        () => client.getChampionMastery(platform, puuid, championId),
      ),
    ]);

    return {
      ...card,
      riotId:
        account !== null &&
        typeof account.gameName === 'string' &&
        typeof account.tagLine === 'string'
          ? { gameName: account.gameName, tagLine: account.tagLine }
          : null,
      // Requirement 2.6: a successful call with no entries is `[]` (unranked), not `null`.
      rankedEntries: leagueDtos === null ? null : toLeagueEntries(leagueDtos),
      championMasteryPoints: mastery === null ? null : finiteOrNull(mastery.championPoints),
      championMasteryLevel: mastery === null ? null : finiteOrNull(mastery.championLevel),
    };
  }

  return {
    async enrichAll(platform, region, participants) {
      // Requirement 2.4: one card per participant, in input order. Every leaf is
      // failure-swallowing, so `Promise.all` here never rejects.
      return Promise.all(participants.map((participant) => enrichOne(platform, region, participant)));
    },
  };
}
