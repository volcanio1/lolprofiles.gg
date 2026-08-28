/**
 * Data models for the Live Game feature (`specs/live-game/design.md`).
 *
 * Split three ways:
 *  - `CurrentGameInfo` / `CurrentGameParticipant` — the raw Spectator-V5 payload,
 *    trimmed to the fields the feature reads.
 *  - `ParticipantCard` — one Spectator-V5 participant joined with the enrichment
 *    the Participant Enricher fetches per player (Riot ID, ranked entries,
 *    mastery). Every joined field is nullable: an enrichment call that fails
 *    degrades a field, never the card (design.md, Requirement 2.4).
 *  - `LiveGameLobby` — the assembled lobby the API returns and the Lobby Insight
 *    Engine runs over.
 */

import type { LeagueEntry } from '../insight/stats';

// ---------------------------------------------------------------------------
// Spectator-V5 raw payload (trimmed)
// ---------------------------------------------------------------------------

export interface CurrentGameParticipantPerks {
  perkIds: readonly number[];
  perkStyle: number;
  perkSubStyle: number;
}

export interface CurrentGameParticipant {
  puuid: string;
  teamId: number;
  championId: number;
  spell1Id: number;
  spell2Id: number;
  /** `true` for a co-op-vs-AI bot; the enricher skips every call for it (Requirement 2.5). */
  bot: boolean;
  perks?: CurrentGameParticipantPerks;
}

export interface CurrentGameBannedChampion {
  championId: number;
  teamId: number;
  pickTurn: number;
}

export interface CurrentGameInfo {
  gameId: number;
  /** e.g. `NA1`. Combined with `gameId` to form the finished-match id (Requirement 5.3). */
  platformId: string;
  /** Epoch ms. Zero or absent means Pre_Game (Requirement 4.2). */
  gameStartTime: number;
  gameLength: number;
  gameMode: string;
  gameType: string;
  mapId: number;
  gameQueueConfigId: number;
  bannedChampions: readonly CurrentGameBannedChampion[];
  participants: readonly CurrentGameParticipant[];
}

// ---------------------------------------------------------------------------
// Assembled lobby
// ---------------------------------------------------------------------------

export interface ParticipantCard {
  puuid: string;
  teamId: number;
  championId: number;
  spell1Id: number;
  spell2Id: number;
  perkIds: readonly number[];
  isBot: boolean;
  /** Absent when enrichment failed or the participant is a bot. */
  riotId: { gameName: string; tagLine: string } | null;
  /**
   * Every ranked queue entry League-V4 returned for the player, or `null` when
   * the call failed. An empty array is a successful "this player is unranked"
   * result (Requirement 2.6) and is distinct from `null`.
   */
  rankedEntries: readonly LeagueEntry[] | null;
  /** `null` when the mastery call failed. */
  championMasteryPoints: number | null;
  championMasteryLevel: number | null;
}

export interface LobbyInsights {
  /** puuids flagged as playing a champion they barely have mastery on. */
  offChampion: readonly string[];
  /** puuids flagged as a one-trick on the locked champion. */
  oneTricks: readonly string[];
  /**
   * `null` when fewer than two participants hold a ranked entry in the game's
   * queue (Requirement 3.5) — a spread from one entry is not a spread.
   */
  rankSpread: { highest: RankedTier; lowest: RankedTier } | null;
}

export interface LiveGameLobby {
  gameId: number;
  platformId: string;
  /** `${platformId}_${gameId}` — the id the finished game is published under (Requirement 5.3). */
  matchId: string;
  queueId: number;
  mapId: number;
  /** Epoch ms, or `null` for Pre_Game (Requirement 4.2). */
  gameStartTime: number | null;
  bannedChampionIds: readonly number[];
  participants: readonly ParticipantCard[];
  insights: LobbyInsights;
}

// ---------------------------------------------------------------------------
// Ranked tiers
// ---------------------------------------------------------------------------

/** League-V4 `tier` values, lowest to highest. */
export const RANKED_TIERS = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
  'MASTER',
  'GRANDMASTER',
  'CHALLENGER',
] as const;

export type RankedTier = (typeof RANKED_TIERS)[number];

const RANKED_TIER_ORDINAL: ReadonlyMap<string, number> = new Map(
  RANKED_TIERS.map((tier, index) => [tier, index]),
);

/** The 0-based rank of a League-V4 tier string, or `null` when it is not a real tier. */
export function rankedTierOrdinal(tier: string): number | null {
  const ordinal = RANKED_TIER_ORDINAL.get(tier.toUpperCase());
  return ordinal === undefined ? null : ordinal;
}

/**
 * Riot `gameQueueConfigId` -> the League-V4 `queueType` whose ranked entries the
 * rank spread is computed from. Only the two ranked Summoner's Rift queues have
 * one; every other queue id yields no ranked queue, so its rank spread is always
 * `null` (Requirement 3.4/3.5).
 */
export const RANKED_LEAGUE_QUEUE_TYPE_BY_QUEUE_ID: Readonly<Record<number, string>> = {
  420: 'RANKED_SOLO_5x5',
  440: 'RANKED_FLEX_SR',
};
