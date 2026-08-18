/**
 * Insight Engine — recent matches list.
 *
 * PURE MODULE, same constraints as `stats.ts`: no I/O, no clock read. Reports the
 * player's most recent included matches with their own line stats (champion,
 * outcome, KDA, CS, vision score) alongside the opposing laner's same stats,
 * where an opponent could be identified (see `orchestrator/mapping.ts`).
 */

import { csPerMinuteOf, type IncludedMatch, type OpponentSummary } from './stats';

/** How many recent matches the report surfaces. */
export const RECENT_MATCH_LIMIT = 10;

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
}

/**
 * Most recent `RECENT_MATCH_LIMIT` matches, newest first. Does not mutate its
 * input.
 */
export function computeRecentMatches(matches: readonly IncludedMatch[]): RecentMatchSummary[] {
  return [...matches]
    .sort((a, b) => b.startTimestamp - a.startTimestamp)
    .slice(0, RECENT_MATCH_LIMIT)
    .map((match) => ({
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
    }));
}
