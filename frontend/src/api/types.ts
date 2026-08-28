/**
 * The backend's wire contract, as the frontend sees it.
 *
 * Types only — no runtime code. These mirror `backend/src/orchestrator`'s
 * `ProfileReport` and `backend/src/api/errors`' `ApiErrorBody`. The workspaces
 * share no code, so this is a hand-maintained copy; `lookupClient.ts` treats
 * every response as untrusted and narrows it before use, so a drift shows up as a
 * rendering gap rather than a crash.
 *
 * NOTE: the Riot API key appears nowhere in this contract, by construction. The
 * backend never returns it (Requirement 4.2), and the frontend has no reason to
 * know it exists.
 */

export interface RiotIdParts {
  gameName: string;
  tagLine: string;
}

/** Requirements 6.1/6.2/6.6: a queue with a ranked entry. */
export interface RankedQueueSummary {
  tier: string;
  division: string;
  /** `'N/A'` exactly when wins + losses is 0 (Requirement 6.6). */
  winRatePercent: number | 'N/A';
  /** Current League Points within the division (standing, not a per-game delta). */
  leaguePoints: number;
}

/** Requirement 6.1: a queue with no entry reads as `'Unranked'`. */
export type RankedQueueStanding = RankedQueueSummary | 'Unranked';

/** Requirement 6.4. */
export interface ChampionSummary {
  championName: string;
  gamesPlayed: number;
  winRatePercent: number;
  averageKda: number;
  averageCs: number;
  averageCsPerMinute: number;
}

export interface ProfileStats {
  rankedByQueue: Record<string, RankedQueueStanding>;
  overallAverageKda: number;
  topChampions: ChampionSummary[];
  mostPlayedRole: string;
}

/**
 * Item_Slots 0-6 at game end — the final inventory, not a purchase sequence.
 * `items` is fixed-length so an empty slot (`0`) stays at its own position
 * rather than shifting later items left; `trinket` is `items[6]` pulled out as
 * its own field since every render site needs the trinket distinguished.
 */
export interface ItemBuild {
  items: readonly [number, number, number, number, number, number];
  trinket: number;
}

/** The opposing participant in the same lane, for a lane-matchup comparison. */
export interface OpponentSummary {
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  csPerMinute: number;
  visionScore: number;
  /** From the same participant row as the rest of this summary. */
  build: ItemBuild;
}

/** `match-detail-tabs` Requirement 6.2. A Participant's complete rune selection. */
export interface RunePage {
  primaryStyle: number;
  secondaryStyle: number;
  /** Four perk ids in Riot's reported slot order (Requirement 4.5). */
  primarySelections: readonly number[];
  /** Two perk ids in Riot's reported slot order. */
  secondarySelections: readonly number[];
  /** offense, flex, defense — in that order, matching Riot's statPerks keys. */
  statShards: readonly [number, number, number];
}

/**
 * `match-detail-tabs` Requirement 6. One of a match's ten Participants, trimmed
 * to what the General and Runes tabs render.
 */
export interface MatchParticipant {
  /** Requirement 6.6/6.7. No participant record carries a PUUID, including the analyzed player's own. */
  isAnalyzedPlayer: boolean;
  /** Requirement 6.7/6.8. Set from the same row the opponent selection chose, never a champion-name match. */
  isEnemyLaner: boolean;
  /** 100 or 200. */
  teamId: number;
  /** From riotIdGameName/riotIdTagline; summonerName is deprecated and empty. */
  riotIdGameName: string;
  riotIdTagline: string;
  championName: string;
  champLevel: number;
  /** '' when Riot could not assign one. */
  teamPosition: string;
  summonerSpells: readonly [number, number];
  runes: RunePage;
  build: ItemBuild;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  visionScore: number;
  damageToChampions: number;
  goldEarned: number;
  win: boolean;
  /** Objective last-hits, for the match-performance rating. */
  turretKills: number;
  dragonKills: number;
  baronKills: number;
  /** Pentakills in this game, for the match-performance rating. */
  pentaKills: number;
  /** Requirement 3.4/3.6. 'N/A' exactly when the team's total kills is 0. */
  killParticipationPercent: number | 'N/A';
  /**
   * `match-detail-tabs` Requirement 12.1/12.2. Zero to six non-zero
   * `playerAugmentN` values, Riot's field order. Always `[]` outside ARAM
   * Mayhem (queue 2400).
   */
  augments: readonly number[];
}

export interface RecentMatchSummary {
  matchId: string;
  championName: string;
  role: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  csPerMinute: number;
  visionScore: number;
  /** Epoch ms. */
  startTimestamp: number;
  durationSeconds: number;
  /** `null` when no opposing participant shared this player's lane. */
  opponent: OpponentSummary | null;
  /** Final inventory at game end, not a purchase order. */
  build: ItemBuild;
  /** `match-detail-tabs` Requirement 6.5. All ten Participants. Empty only if the match carried none. */
  participants: MatchParticipant[];
  /** `match-detail-tabs` Requirement 1.6/6.4. */
  queueType: string;
}

/**
 * `item-timeline`: one item acquisition on the analyzed player's build path.
 * `timestamp` is milliseconds from match start, rendered as `M:SS`.
 */
export interface BuildPathEntry {
  itemId: number;
  /** Milliseconds from match start when the item was bought. */
  timestamp: number;
  /** Milliseconds from match start when it was later sold. Present only if sold. */
  soldAt?: number;
}

/**
 * `item-timeline`: the body of `GET /api/match/:matchId/build-path`. `200` for
 * both variants — a match with no timeline is a normal outcome, not an error.
 */
export type BuildPathResponse =
  | {
      kind: 'build_path';
      buildPath: readonly BuildPathEntry[];
      /** Ability leveled at each level-up, in order: 1=Q, 2=W, 3=E, 4=R. */
      skillOrder: readonly number[];
      reconciled: boolean;
    }
  | { kind: 'unavailable'; reason: 'no_timeline' | 'participant_absent' };

/** Requirement 7.4's four categories. */
export interface FunFact {
  category: 'timeOfDay' | 'championLoyalty' | 'rolePreference' | 'streak';
  text: string;
}

/** Requirement 8.5: every recommendation carries its metric name and value. */
export interface Recommendation {
  category: 'survivability' | 'championSelection' | 'visionControl';
  text: string;
  metricName: string;
  metricValue: number;
}

export interface ProfileReport {
  riotId: RiotIdParts;
  puuid: string;
  /**
   * lookup-pipeline-fixes Requirement 4.2/4.3: null exactly when the
   * Summoner-V4 enrichment call failed. Was unconditionally `number` before.
   */
  summonerLevel: number | null;
  /**
   * Null when no usable icon id was retrieved. `0` is a REAL icon (Data Dragon
   * serves it), so null — never zero — is the absence encoding; render a
   * placeholder for null and a real image for 0.
   */
  profileIconId: number | null;
  /** lookup-pipeline-fixes Requirement 2.3: the platform the data came from. */
  resolvedPlatform: string;
  /** lookup-pipeline-fixes Requirement 2.4: true when a diagnostic override was used. */
  usedPlatformOverride: boolean;
  stats: ProfileStats;
  funFacts: FunFact[];
  /** Requirement 3.4 / 7.5. */
  limitedDataNotice: boolean;
  recommendations: Recommendation[];
  /** Requirement 7.3. */
  averageMatchDurationMinutes: number;
  /**
   * Newest-first, up to the backend's transport limit (wider than the page the
   * UI shows at once — the "Load more" button walks through the rest). Merges
   * laned and laneless (ARAM / ARAM Mayhem) matches. Each carries the lane
   * opponent's stats when known.
   */
  recentMatches: RecentMatchSummary[];
  /** Requirements 11.4/11.5: `null` means "being retrieved for the first time". */
  lastUpdated: string | null;
  /** Requirement 11.3: some data may be outdated. */
  partialDataWarning: boolean;
}

/**
 * The backend's `ErrorCode` union, revised by lookup-pipeline-fixes:
 * `UNSUPPORTED_REGION` and `PLAYER_NOT_ON_PLATFORM` are gone (there is no
 * region input to be unsupported, and no wrong-region symptom to detect
 * anymore — see backend/src/orchestrator/index.ts); `NO_LOL_ACCOUNT` and
 * `UNSUPPORTED_PLATFORM` are the Region Resolver's two failure outcomes.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'PLAYER_NOT_FOUND'
  /** Requirement 5.2: the Riot account exists but has no League play history. */
  | 'NO_LOL_ACCOUNT'
  /** Requirement 5.3: the Region Resolver named a platform this build doesn't support. */
  | 'UNSUPPORTED_PLATFORM'
  | 'RIOT_UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILURE'
  | 'NETWORK_ERROR'
  | 'MATCH_HISTORY_UNAVAILABLE';

export interface ApiErrorPayload {
  code: ErrorCode;
  message: string;
  retriable: boolean;
  /** Requirement 9.8. */
  retryAfterSeconds?: number;
  /** Requirement 9.3. */
  maxRetries?: number;
  /** Requirements 9.2 / 5.2. */
  gameName?: string;
  tagLine?: string;
  /** Requirement 5.3: the platform Riot itself reported, on `UNSUPPORTED_PLATFORM`. */
  platform?: string;
  /** Requirement 9.1. */
  validationRule?: string;
  field?: string;
}

export interface ApiErrorBody {
  error: ApiErrorPayload;
}
