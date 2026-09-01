/**
 * Insight Engine — recent matches list.
 *
 * PURE MODULE, same constraints as `stats.ts`: no I/O, no clock read. Reports the
 * player's most recent included matches with their own line stats (champion,
 * outcome, KDA, CS, vision score) alongside the opposing laner's same stats,
 * where an opponent could be identified (see `orchestrator/mapping.ts`).
 */

import {
  EMPTY_ITEM_BUILD,
  csPerMinuteOf,
  type IncludedMatch,
  type ItemBuild,
  type LanelessMatch,
  type MatchParticipant,
  type OpponentSummary,
} from './stats';

/** How many recent matches the frontend shows in one page, before "Load more". */
export const RECENT_MATCH_LIMIT = 10;

/**
 * How many recent matches the report transports. Larger than `RECENT_MATCH_LIMIT`
 * so the frontend can page through history ("Load more") and filter by queue —
 * including down to ARAM / ARAM Mayhem, which share the pool with every laned
 * queue — without a second Riot call. The orchestrator has already fetched and
 * cached up to `MATCH_HISTORY_COUNT` (100), so this only widens the slice.
 */
export const RECENT_MATCH_TRANSPORT_LIMIT = 30;

export interface RecentMatchSummary {
  matchId: string;
  championName: string;
  role: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  /** 2 decimal places. */
  csPerMinute: number;
  visionScore: number;
  /** Epoch ms. */
  startTimestamp: number;
  durationSeconds: number;
  /** `null` when no opposing participant shared this player's lane. */
  opponent: OpponentSummary | null;
  /** Requirement 3.1. Final inventory at game end, not a purchase sequence. */
  build: ItemBuild;
  /**
   * `match-detail-tabs` Requirement 6.5. All ten Participants. Empty only if the
   * match carried none (Requirement 6.11).
   */
  participants: MatchParticipant[];
  /**
   * `match-detail-tabs` Requirement 1.6/6.4. Present on `IncludedMatch` already;
   * this is the first consumer to carry it through to the transport shape.
   */
  queueType: string;
  /**
   * LP gained (positive) or lost (negative) in this match, for a ranked
   * solo/duo or ranked flex game only. `null` when not computable — no other
   * queue type, no checkpoint data, or the checkpoints bracketing this match
   * also bracket another ranked match of the same queue (ambiguous — see
   * `insight/lpDelta.ts`'s decision 1). Applied by the caller after this
   * function runs (`applyLpDeltas`), not computed here — this module never
   * gains a dependency on rank-checkpoint data.
   */
  lpDelta: number | null;
}

/**
 * Most recent `RECENT_MATCH_TRANSPORT_LIMIT` matches, newest first, merged from
 * both sources on equal footing. Does not mutate its input. The frontend applies
 * the smaller `RECENT_MATCH_LIMIT` display cap after filtering by queue.
 *
 * `match-detail-tabs` Requirement 11.1: `lanelessMatches` (ARAM, ARAM Mayhem —
 * see `mapping.ts`'s `toLanelessMatch`) competes for a recent-matches slot the
 * same way an `IncludedMatch` does. It is a SEPARATE array, not folded into
 * `matches`, precisely so nothing upstream of this function (`computeStats`,
 * `roleAggregatesOf`, `topChampionsOf`, `mostPlayedRoleOf`) ever sees one.
 */
export function computeRecentMatches(
  matches: readonly IncludedMatch[],
  lanelessMatches: readonly LanelessMatch[] = [],
): RecentMatchSummary[] {
  const laned: RecentMatchSummary[] = matches.map((match) => ({
    matchId: match.matchId,
    championName: match.championName,
    role: match.role,
    win: match.win,
    kills: match.kills,
    deaths: match.deaths,
    assists: match.assists,
    cs: match.cs ?? 0,
    csPerMinute: csPerMinuteOf(match.cs ?? 0, match.durationSeconds),
    visionScore: match.visionScore,
    startTimestamp: match.startTimestamp,
    durationSeconds: match.durationSeconds,
    opponent: match.opponent ?? null,
    build: match.build ?? EMPTY_ITEM_BUILD,
    participants: match.participants ?? [],
    queueType: match.queueType,
    lpDelta: null,
  }));

  // Requirement 11.4/11.5: no lane means no Enemy_Laner (ever `null`, not merely
  // absent) and no determinable role — `''` is the EXISTING "role could not be
  // determined" sentinel (`roleOf`'s decision 6 in `mapping.ts`), reused here
  // rather than invented, so nothing downstream needs a new case to handle it.
  const laneless: RecentMatchSummary[] = lanelessMatches.map((match) => ({
    matchId: match.matchId,
    championName: match.championName,
    role: '',
    win: match.win,
    kills: match.kills,
    deaths: match.deaths,
    assists: match.assists,
    cs: match.cs,
    csPerMinute: csPerMinuteOf(match.cs, match.durationSeconds),
    visionScore: match.visionScore,
    startTimestamp: match.startTimestamp,
    durationSeconds: match.durationSeconds,
    opponent: null,
    build: match.build,
    participants: match.participants,
    queueType: match.queueType,
    lpDelta: null,
  }));

  return [...laned, ...laneless]
    .sort((a, b) => b.startTimestamp - a.startTimestamp)
    .slice(0, RECENT_MATCH_TRANSPORT_LIMIT);
}

/**
 * Fills in `lpDelta` for whichever entries `deltas` has a value for (keyed by
 * `matchId`, from `insight/lpDelta.ts#computeLpDeltas`). Does not mutate
 * `summaries` — kept as a separate pass, after `computeRecentMatches`, so this
 * module stays free of any dependency on rank-checkpoint data; the caller
 * (`orchestrator/index.ts`) is the one place that has both.
 */
export function applyLpDeltas(
  summaries: readonly RecentMatchSummary[],
  deltas: ReadonlyMap<string, number>,
): RecentMatchSummary[] {
  if (deltas.size === 0) {
    return [...summaries];
  }
  return summaries.map((summary) => {
    const delta = deltas.get(summary.matchId);
    return delta === undefined ? summary : { ...summary, lpDelta: delta };
  });
}
