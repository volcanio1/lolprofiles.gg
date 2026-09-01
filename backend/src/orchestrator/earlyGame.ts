/**
 * Early-Game Provider (`player-insights` Phase 2, Requirements 15-16).
 *
 * Given ONE already-fetched match (the raw `MatchDto` the main pipeline
 * already has in hand — this never issues its own `getMatchById`) and the
 * analyzed player's puuid, resolves the analyzed player's and their
 * Lane_Opponent's Match-V5 timeline participant ids, fetches the
 * Match_Timeline, derives the lane-phase death count and the gold/CS diff at
 * 10 minutes, and caches ONLY that derived, few-bytes-per-match result
 * indefinitely — keyed `{ matchId, puuid }`, so a repeat lookup of the same
 * player never re-fetches or re-parses the same match's timeline.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE RAW TIMELINE IS NEVER CACHED, ONLY THE DERIVED SLICE — the same
 *    discipline `item-timeline`'s Build Path Orchestrator already established
 *    for `timelineSlice` (its decision 2): a 0.3-1 MB response has no cache
 *    entry type of its own, and is discarded the moment the few numbers this
 *    module needs are read out of it.
 *
 * 2. A FAILED OR MISSING TIMELINE IS NOT CACHED. Mirrors `item-timeline`'s
 *    decision 3 exactly (a `not_found`/failure there never reaches
 *    `cache.set`): a transient Riot failure should be retried on the next
 *    lookup, not permanently remembered as "no data for this match" under an
 *    infinite TTL. Only a genuinely COMPUTED aggregate — even one whose
 *    `goldDiffAt10`/`csDiffAt10` are `null` because no Lane_Opponent exists or
 *    the game ended before 10 minutes — is cached, because those nulls are
 *    facts about the match's own data, not about a Riot API hiccup, and will
 *    never change on a retry.
 *
 * 3. THE LANE OPPONENT IS RESOLVED FROM THE RAW MATCH, NOT THE TIMELINE.
 *    `orchestrator/mapping.ts`'s `opponentRowOf` (exported for this module)
 *    already implements Lane_Opponent selection — by `teamPosition`, never by
 *    champion identity — against the match detail's raw participant rows,
 *    which is where puuid and teamPosition/teamId both live. The timeline's
 *    OWN `info.participants` is then used only to translate that opponent's
 *    puuid (and the analyzed player's own) into the numeric participant id
 *    the timeline's events/frames are keyed by — never to select the
 *    opponent a second time by a different rule.
 */

import { TTL_BY_ENDPOINT, type CacheStore } from '../cache';
import { goldCsAtOf, lanePhaseDeathCountOf } from '../insight/earlyGame';
import type { EarlyGameAggregate } from '../insight/performanceFeedback';
import type { RegionalRoutingValue } from '../region';
import type { MatchDto, MatchTimelineDto, RiotApiClient } from '../riotApiClient';
import { opponentRowOf } from './mapping';

export interface EarlyGameProviderOptions {
  client: RiotApiClient;
  cache: CacheStore;
}

export interface EarlyGameProvider {
  /**
   * `match` is the already-fetched raw match detail. Returns `undefined` only
   * when the analyzed player's own row cannot be found in `match` at all
   * (should not happen for a match already known to include this puuid).
   */
  getAggregate(
    region: RegionalRoutingValue,
    match: MatchDto,
    puuid: string,
  ): Promise<EarlyGameAggregate | undefined>;
}

function nullAggregate(matchId: string): EarlyGameAggregate {
  return { matchId, lanePhaseDeaths: null, goldDiffAt10: null, csDiffAt10: null };
}

function buildAggregate(
  matchId: string,
  timeline: MatchTimelineDto,
  selfPuuid: string,
  rivalPuuid: string | undefined,
): EarlyGameAggregate {
  const participants = Array.isArray(timeline.info?.participants) ? timeline.info.participants : [];
  const frames = Array.isArray(timeline.info?.frames) ? timeline.info.frames : [];
  const selfEntry = participants.find((p) => p.puuid === selfPuuid);
  if (selfEntry === undefined) {
    return nullAggregate(matchId); // decision 3 fallback: no self row in the timeline either
  }

  const allEvents = frames.flatMap((frame) => (Array.isArray(frame.events) ? frame.events : []));
  const lanePhaseDeaths = lanePhaseDeathCountOf(allEvents, selfEntry.participantId);

  let goldDiffAt10: number | null = null;
  let csDiffAt10: number | null = null;
  const rivalEntry = rivalPuuid === undefined ? undefined : participants.find((p) => p.puuid === rivalPuuid);
  if (rivalEntry !== undefined) {
    const selfSnapshot = goldCsAtOf(frames, selfEntry.participantId);
    const rivalSnapshot = goldCsAtOf(frames, rivalEntry.participantId);
    if (selfSnapshot !== undefined && rivalSnapshot !== undefined) {
      goldDiffAt10 = selfSnapshot.gold - rivalSnapshot.gold;
      csDiffAt10 = selfSnapshot.cs - rivalSnapshot.cs;
    }
  }

  return { matchId, lanePhaseDeaths, goldDiffAt10, csDiffAt10 };
}

export function createEarlyGameProvider(options: EarlyGameProviderOptions): EarlyGameProvider {
  const { client, cache } = options;

  async function getAggregate(
    region: RegionalRoutingValue,
    match: MatchDto,
    puuid: string,
  ): Promise<EarlyGameAggregate | undefined> {
    const matchId = match.metadata?.matchId;
    if (typeof matchId !== 'string' || matchId.length === 0) {
      return undefined;
    }

    const cacheKey = { endpoint: 'earlyGameSlice' as const, routingValue: region, params: { matchId, puuid } };
    const cached = await cache.get<EarlyGameAggregate>(cacheKey).catch(() => undefined);
    if (cached !== undefined) {
      return cached.value; // infinite TTL (decision 1): never stale, never re-fetched
    }

    const participants = Array.isArray(match.info?.participants) ? match.info.participants : [];
    const self = participants.find((p) => p.puuid === puuid);
    if (self === undefined) {
      return undefined;
    }
    const rival = opponentRowOf(participants, self); // decision 3

    const timelineResult = await client.getMatchTimeline(region, matchId);
    if (timelineResult.kind !== 'ok') {
      return nullAggregate(matchId); // decision 2: computed but NOT cached
    }

    const aggregate = buildAggregate(matchId, timelineResult.data, puuid, rival?.puuid);
    await cache.set(cacheKey, aggregate, TTL_BY_ENDPOINT.earlyGameSlice).catch(() => undefined);
    return aggregate;
  }

  return { getAggregate };
}
