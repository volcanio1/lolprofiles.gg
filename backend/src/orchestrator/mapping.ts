/**
 * Lookup Orchestrator — Riot wire schema to domain model mapping.
 *
 * PURE MODULE. No network, no cache, no `process.env`, no logging, no clock read.
 * The only imports are types.
 *
 * This is the boundary the Insight Engine was deliberately kept clear of (see
 * `insight/stats.ts` decisions 1 and 2): the Insight Engine consumes design.md's
 * `IncludedMatch` and `LeagueEntry`, while Riot speaks `MatchDto` and
 * `LeagueEntryDto`. Both translations live here, so Riot's field naming and queue
 * numbering are known in exactly one place.
 *
 * Implements:
 *  - 3.5: a match whose queue type is not "ranked solo/duo", "ranked flex" or
 *    "normal" is excluded from the Profile_Report and from the count that drives
 *    the limited-data notice.
 *  - 2.3 / 6.1: League-V4's `rank` field is the division the report displays.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. QUEUE CLASSIFICATION IS AN EXPLICIT ALLOWLIST OVER RIOT'S NUMERIC QUEUE IDS.
 *    Requirement 3.5 names three queue types, but Match-V5 reports
 *    `info.queueId`, a number. A mapping is therefore unavoidable. It is written
 *    as an allowlist rather than a denylist because the requirement is phrased as
 *    an exclusion rule: anything not recognized is excluded. That makes an
 *    unrecognized or newly introduced queue fail SAFE (dropped from analysis)
 *    rather than fail open (silently analyzed as if it were a standard game).
 *
 *    This does not contradict `insight/stats.ts` decision 3's refusal to hardcode
 *    a queue list. That decision concerns `rankedByQueue`'s KEY SET, which
 *    Requirement 6.1 scopes to "each queue type returned by League-V4" and which
 *    must therefore follow Riot's data. Here the requirement itself fixes a closed
 *    set of three, so the mapping is transcribing a requirement, not inventing a
 *    parallel source of truth.
 *
 * 2. WHICH QUEUE IDS COUNT AS "normal". The included ids and their descriptions
 *    in Riot's published queue table (queues.json) are:
 *      - 420 "5v5 Ranked Solo games"   (Summoner's Rift) -> ranked solo/duo
 *      - 440 "5v5 Ranked Flex games"   (Summoner's Rift) -> ranked flex
 *      - 400 "5v5 Draft Pick games"    (Summoner's Rift) -> normal
 *      - 430 "5v5 Blind Pick games"    (Summoner's Rift) -> normal
 *      - 480 "Swiftplay Games"         (Summoner's Rift) -> normal
 *      - 490 "Normal (Quickplay)"      (Summoner's Rift) -> normal
 *    The operational reading of "normal" is: a non-ranked 5v5 queue on Summoner's
 *    Rift with standard role assignment. That is what makes a match comparable to
 *    the ranked ones for the analysis the requirements ask for — Requirements 6.5,
 *    8.2 and 8.4 are all role-relative, so a mode without roles or lanes would
 *    corrupt them rather than add signal.
 *
 *    Consequently ARAM (450, Howling Abyss), Clash (700/720), Co-op vs AI, and
 *    every rotating game mode are excluded, as are all queue ids Riot marks
 *    deprecated. A newly introduced casual Summoner's Rift queue must be added
 *    here deliberately; until then its matches are excluded, per decision 1.
 *
 * 3. A MATCH WITH NO PARTICIPANT ROW FOR THE REQUESTER IS EXCLUDED. Every
 *    per-match statistic is read from the requester's own row in
 *    `info.participants`, located by PUUID. If that row is absent the match yields
 *    no usable data about this player, so it is excluded exactly as a fetch
 *    failure would be (Requirement 3.3).
 *
 *    This is defensive rather than routine, and deliberately so. It used to be a
 *    routinely reachable case: `deleteByPuuid` originally redacted the requester's
 *    PUUID out of RETAINED match details, so after a deletion request every one of
 *    that player's cached matches silently lost its row and was excluded forever —
 *    their report came back empty. Deletion now EVICTS those entries instead, so a
 *    later lookup re-fetches a complete match detail and the row is present again.
 *    The guard stays because Riot data can still surprise us (an anonymized or
 *    malformed participant list), and excluding one match is the right response to
 *    that; it should simply no longer fire because of a deletion.
 *
 * 4. RESPONSE SHAPES ARE VALIDATED HERE, NOT IN THE CLIENT. The Riot API Client
 *    casts response bodies without validating them, and explicitly defers
 *    field-level validation to "downstream, where a missing field has a meaning"
 *    (its decision 5). This module is that downstream: a malformed match is
 *    excluded, which is a meaning Requirement 3.3 already defines. `undefined` is
 *    returned instead of throwing, so one bad match can never fail a lookup.
 *
 * 5. `gameStartTimestamp` MUST BE FINITE; OTHER NUMBERS ARE COERCED TO 0. The
 *    start timestamp drives Requirement 7.1's time-of-day windows and 7.2's
 *    chronological ordering, and a non-finite value would silently corrupt both
 *    (NaN comparisons are false, so it would land in an arbitrary sort position),
 *    so such a match is excluded. A missing kill/death/assist/vision count, by
 *    contrast, has a well-defined neutral reading of 0 and cannot distort
 *    ordering, so it is coerced rather than causing an exclusion.
 *
 * 6. ROLE PREFERS `teamPosition`. Riot's `teamPosition` is the normalized lane
 *    assignment (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY); `role` is the older, coarser
 *    field (SOLO/CARRY/SUPPORT/DUO/NONE). `teamPosition` is used when non-blank,
 *    with `role` as a fallback and `''` if neither is usable. A blank role is
 *    handled downstream: `computeFunFacts` skips the role-preference statement for
 *    a blank role name rather than emitting a sentence about nothing.
 */

import type { IncludedMatch, LeagueEntry } from '../insight/stats';
import type { LeagueEntryDto, MatchDto } from '../riotApiClient';

/** The exact set Requirement 3.5 permits. */
export const ALLOWED_QUEUE_TYPES = ['ranked solo/duo', 'ranked flex', 'normal'] as const;

export type AllowedQueueType = (typeof ALLOWED_QUEUE_TYPES)[number];

/**
 * Riot `info.queueId` -> Requirement 3.5 queue type. See decision 2 for the
 * membership rule and the descriptions these ids carry in Riot's queue table.
 */
export const QUEUE_TYPE_BY_QUEUE_ID: Readonly<Record<number, AllowedQueueType>> = {
  400: 'normal', // 5v5 Draft Pick
  420: 'ranked solo/duo', // 5v5 Ranked Solo
  430: 'normal', // 5v5 Blind Pick
  440: 'ranked flex', // 5v5 Ranked Flex
  480: 'normal', // Swiftplay
  490: 'normal', // Normal (Quickplay)
};

/**
 * Requirement 3.5. Returns the allowed queue type for a Riot queue id, or
 * `undefined` when the queue is not one of the three permitted types — in which
 * case the match must be excluded from the report and from the limited-data count.
 */
export function queueTypeForQueueId(queueId: unknown): AllowedQueueType | undefined {
  if (typeof queueId !== 'number' || !Number.isFinite(queueId)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(QUEUE_TYPE_BY_QUEUE_ID, queueId)
    ? QUEUE_TYPE_BY_QUEUE_ID[queueId]
    : undefined;
}

/** Decision 5: a neutral 0 for any value that is not a finite number. */
function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Decision 6: normalized lane, falling back to Riot's older `role` field. */
function roleOf(participant: { teamPosition?: string; role?: string }): string {
  const teamPosition = typeof participant.teamPosition === 'string' ? participant.teamPosition.trim() : '';
  if (teamPosition.length > 0) {
    return teamPosition;
  }
  const role = typeof participant.role === 'string' ? participant.role.trim() : '';
  return role;
}

/**
 * Flattens a Match-V5 match detail into the analyzed player's own
 * `IncludedMatch`, or returns `undefined` when the match must be EXCLUDED:
 *
 *  - the queue type is not one of Requirement 3.5's three (decision 1/2)
 *  - the requester has no participant row in the match (decision 3)
 *  - the payload is not shaped like a `MatchDto`, or its start timestamp is not
 *    a finite number (decisions 4/5)
 *
 * Never throws: an unusable match is an exclusion, not a failure (Requirement 3.3).
 */
export function toIncludedMatch(match: MatchDto | undefined, puuid: string): IncludedMatch | undefined {
  if (match === null || typeof match !== 'object') {
    return undefined;
  }

  const info: unknown = match.info;
  if (info === null || typeof info !== 'object') {
    return undefined;
  }
  const typedInfo = info as MatchDto['info'];

  const queueType = queueTypeForQueueId(typedInfo.queueId);
  if (queueType === undefined) {
    return undefined;
  }

  const startTimestamp = typedInfo.gameStartTimestamp;
  if (typeof startTimestamp !== 'number' || !Number.isFinite(startTimestamp)) {
    return undefined;
  }

  const participants: unknown = typedInfo.participants;
  if (!Array.isArray(participants)) {
    return undefined;
  }
  const participant = (participants as MatchDto['info']['participants']).find(
    (candidate) => candidate !== null && typeof candidate === 'object' && candidate.puuid === puuid,
  );
  if (participant === undefined) {
    return undefined;
  }

  const metadata: unknown = match.metadata;
  const matchId =
    metadata !== null && typeof metadata === 'object' && typeof (metadata as MatchDto['metadata']).matchId === 'string'
      ? (metadata as MatchDto['metadata']).matchId
      : '';

  return {
    matchId,
    queueType,
    startTimestamp,
    durationSeconds: finiteOrZero(typedInfo.gameDuration),
    championName: typeof participant.championName === 'string' ? participant.championName : '',
    role: roleOf(participant),
    win: participant.win === true,
    kills: finiteOrZero(participant.kills),
    deaths: finiteOrZero(participant.deaths),
    assists: finiteOrZero(participant.assists),
    visionScore: finiteOrZero(participant.visionScore),
  };
}

/**
 * League-V4 `rank` -> design.md's `LeagueEntry.division`. The rename is the whole
 * mapping; every other field is already field-compatible (`insight/stats.ts`
 * decision 2).
 *
 * Non-string tier/division/queueType values become `''` and non-finite counts
 * become 0, for the same reason as decision 5: a malformed ranked entry should
 * render as an incomplete standing, never crash a report.
 */
export function toLeagueEntry(dto: LeagueEntryDto): LeagueEntry {
  return {
    queueType: typeof dto.queueType === 'string' ? dto.queueType : '',
    tier: typeof dto.tier === 'string' ? dto.tier : '',
    division: typeof dto.rank === 'string' ? dto.rank : '',
    leaguePoints: finiteOrZero(dto.leaguePoints),
    wins: finiteOrZero(dto.wins),
    losses: finiteOrZero(dto.losses),
  };
}

/**
 * Requirement 2.3 / 2.8. Maps a League-V4 response body to `LeagueEntry[]`.
 * A body that is not an array (malformed response) yields `[]`, which the
 * Insight Engine renders as Unranked — the same valid state Requirement 2.8
 * defines for a genuinely empty entry list, and never a failure.
 */
export function toLeagueEntries(dtos: LeagueEntryDto[] | undefined): LeagueEntry[] {
  if (!Array.isArray(dtos)) {
    return [];
  }
  return dtos
    .filter((dto): dto is LeagueEntryDto => dto !== null && typeof dto === 'object')
    .map(toLeagueEntry);
}
