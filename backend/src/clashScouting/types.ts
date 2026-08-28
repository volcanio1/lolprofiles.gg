/**
 * Data models for the Clash scouting feature (`specs/clash-scouting/design.md`).
 *
 * Split like `liveGame/types.ts`:
 *  - The `Clash*Dto` types are the raw Clash-V1 payloads, trimmed to the fields
 *    the feature reads (client decision 5 — cast, not validated).
 *  - `RosterCard` / `ScoutingReport` are the assembled shapes the API returns and
 *    the Scouting Insight Engine runs over.
 */

import type { RankedQueueStanding } from '../insight/stats';

// ---------------------------------------------------------------------------
// Clash-V1 raw payloads (trimmed)
// ---------------------------------------------------------------------------

export type DeclaredPosition = 'UNSELECTED' | 'FILL' | 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY';

export interface ClashPlayerDto {
  puuid: string;
  teamId: string;
  position: DeclaredPosition;
  /** `CAPTAIN` or `MEMBER`. */
  role: string;
}

export interface ClashTeamPlayerDto {
  puuid: string;
  position: DeclaredPosition;
  role: string;
}

export interface ClashTeamDto {
  id: string;
  tournamentId: number;
  name: string;
  iconId: number;
  tier: number;
  /** PUUID of the captain. */
  captain: string;
  abbreviation: string;
  players: readonly ClashTeamPlayerDto[];
}

export interface ClashTournamentScheduleDto {
  id: number;
  registrationTime: number;
  startTime: number;
  cancelled: boolean;
}

export interface ClashTournamentDto {
  id: number;
  themeId: number;
  nameKey: string;
  nameKeySecondary: string;
  schedule: readonly ClashTournamentScheduleDto[];
}

// ---------------------------------------------------------------------------
// Assembled report
// ---------------------------------------------------------------------------

/** One of a roster member's recent matches, trimmed to what scouting reads. */
export interface RecentFormEntry {
  matchId: string;
  championId: number;
  /** `roleOf` classification (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY), or `''`. */
  role: string;
  win: boolean;
  /** Every participant PUUID in this match — the basis of Stack_Cohesion. */
  participantPuuids: readonly string[];
}

export interface ChampionPoolEntry {
  championId: number;
  masteryPoints: number;
  masteryLevel: number;
}

export interface RosterCard {
  puuid: string;
  declaredPosition: DeclaredPosition;
  isCaptain: boolean;
  /** Absent when the Account-V1 call failed. */
  riotId: { gameName: string; tagLine: string } | null;
  /** `null` when the League-V4 call failed; `[]` / all-`'Unranked'` is a successful result. */
  rankedEntries: readonly RankedQueueStanding[] | null;
  /** `null` when the Champion-Mastery call failed. */
  championPool: readonly ChampionPoolEntry[] | null;
  /** Bounded at `RECENT_FORM_MATCH_LIMIT`; individually-failed matches are excluded. */
  recentForm: readonly RecentFormEntry[];
  /** `null` exactly when `recentForm` is empty (Requirement 3.6). */
  observedRole: string | null;
}

export interface ClashTeamSummary {
  id: string;
  name: string;
  abbreviation: string;
  tier: number;
  iconId: number;
}

export interface BanRecommendation {
  championId: number;
  /** The roster member this champion is most associated with. */
  puuid: string;
  masteryPoints: number;
  recentGames: number;
  recentWins: number;
}

export interface PositionMismatch {
  puuid: string;
  declaredPosition: DeclaredPosition;
  observedRole: string;
}

export interface ScoutingInsights {
  /** At most `MAX_BAN_RECOMMENDATIONS`, strictly ordered (see `compareBanCandidates`). */
  banRecommendations: readonly BanRecommendation[];
  positionMismatches: readonly PositionMismatch[];
  /** 0..5 — how many roster members appear together in some recent match. */
  stackCohesion: number;
}

export interface ScoutingReport {
  team: {
    id: string;
    name: string;
    abbreviation: string;
    tier: number;
    iconId: number;
    captainPuuid: string;
  };
  /** `null` when the Tournament_Schedule was absent or stale (Requirement 4.4). */
  tournament: { id: number; nameKey: string; nameKeySecondary: string } | null;
  roster: readonly RosterCard[];
  insights: ScoutingInsights;
}
