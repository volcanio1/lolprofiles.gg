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
}

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
  summonerLevel: number;
  /**
   * Null when no usable icon id was retrieved. `0` is a REAL icon (Data Dragon
   * serves it), so null — never zero — is the absence encoding; render a
   * placeholder for null and a real image for 0.
   */
  profileIconId: number | null;
  stats: ProfileStats;
  funFacts: FunFact[];
  /** Requirement 3.4 / 7.5. */
  limitedDataNotice: boolean;
  recommendations: Recommendation[];
  /** Requirement 7.3. */
  averageMatchDurationMinutes: number;
  /** Newest-first; each carries the lane opponent's stats when known. */
  recentMatches: RecentMatchSummary[];
  /** Requirements 11.4/11.5: `null` means "being retrieved for the first time". */
  lastUpdated: string | null;
  /** Requirement 11.3: some data may be outdated. */
  partialDataWarning: boolean;
}

/** The backend's `ErrorCode` union. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_REGION'
  | 'PLAYER_NOT_FOUND'
  /** Requirement 9.10: the account exists, but not on the selected region. */
  | 'PLAYER_NOT_ON_PLATFORM'
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
  /** Requirements 9.2 / 9.10. */
  gameName?: string;
  tagLine?: string;
  /** Requirement 9.10: the region and platform that were actually searched. */
  region?: string;
  platform?: string;
  /** Requirement 9.1. */
  validationRule?: string;
  field?: string;
}

export interface ApiErrorBody {
  error: ApiErrorPayload;
}
