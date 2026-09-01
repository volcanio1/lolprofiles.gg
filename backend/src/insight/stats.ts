/**
 * Insight Engine — Stats (`computeStats`).
 *
 * PURE MODULE. No network, no cache, no database, no `process.env`, no HTTP, no
 * logging, and no wall-clock reads: there is no `Date.now()` / `new Date()` in
 * this file and no import that could perform I/O. Every time-derived value comes
 * from `IncludedMatch.startTimestamp`, i.e. from data the caller supplies. That
 * is what makes Requirements 6.1-6.7 property-testable without fakes.
 *
 * Implements:
 *  - 2.8 / 6.1: tier + division per queue type returned by League-V4; a queue
 *    type with no ranked entry is `'Unranked'`, never a failure.
 *  - 6.2: win rate = wins / (wins + losses) as a whole-number percentage.
 *  - 6.6: `wins + losses === 0` renders the string `'N/A'`, not a number.
 *  - 6.3: average KDA = (avgKills + avgAssists) / avgDeaths, 2 decimal places.
 *  - 6.7: avgDeaths === 0 -> avgKills + avgAssists, 2dp, without division.
 *  - 6.4: up to 5 top champions, ordered games DESC, win rate DESC, name ASC.
 *  - 6.5: most-played role by match count, ties broken by chronological recency.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. INPUT SHAPE: `IncludedMatch`, NOT Riot's `MatchDto`. This module consumes an
 *    already-filtered (Requirement 3.5), already-flattened per-player view of a
 *    match. Flattening a `MatchDto` into an `IncludedMatch` — locating the
 *    requester's row in `info.participants` by PUUID, classifying `info.queueId`
 *    into a queue type, converting `gameStartTimestamp`/`gameDuration` — is the
 *    ORCHESTRATOR's job (task 13.4). Keeping that boundary outside this module is
 *    what keeps the Insight Engine pure and independent of Riot's wire schema.
 *
 * 2. `LeagueEntry`, NOT `LeagueEntryDto`. This module takes design.md's
 *    `LeagueEntry`, whose division field is named `division`. The Riot client's
 *    `LeagueEntryDto` uses Riot's field name `rank` for the same value. The
 *    ORCHESTRATOR (task 13.4) performs the one-line `rank -> division` mapping,
 *    for the same reason as (1): the Insight Engine should not encode Riot's
 *    field naming. `LeagueEntry` is otherwise field-compatible with
 *    `LeagueEntryDto`, so the mapping is a rename and nothing else.
 *
 * 3. `rankedByQueue` KEYS ARE MATERIALIZED FROM THE INPUT. Requirement 6.1 scopes
 *    display to "each queue type returned by League-V4", so the key set is
 *    exactly the queue types present in `league`. No hardcoded list of Riot queue
 *    types is invented here — such a list would be a second source of truth that
 *    drifts whenever Riot adds a queue. The complementary rule, which callers
 *    must honor, is that an ABSENT KEY MEANS `'Unranked'`; `standingForQueue`
 *    below is the documented accessor that applies it, so a caller asking about a
 *    queue type with no entry gets `'Unranked'` rather than `undefined`.
 *    An explicitly-present entry is never `'Unranked'`.
 *
 * 4. ALPHABETICAL TIEBREAK USES UTF-16 CODE-UNIT ORDER (`<` / `>`), not
 *    `localeCompare`. Locale-aware comparison depends on ICU data and the ambient
 *    locale, which would make the ordering environment-dependent and therefore
 *    neither reproducible nor property-testable. Code-unit comparison is total
 *    and deterministic everywhere. See `compareStrings`.
 *
 * 5. THE WIN-RATE TIEBREAK COMPARES THE ROUNDED, DISPLAYED PERCENTAGE, not the
 *    exact fraction. Requirement 6.4 defines the order over the value it also
 *    tells us to display, so the ordering is verifiable from the output alone
 *    (2 wins of 3 and 20 of 30 rank equally, as a reader would expect).
 *
 * 6. EMPTY MATCH LIST -> `mostPlayedRole === UNKNOWN_ROLE` (`'Unknown'`). With no
 *    matches there is no role; a sentinel is preferable to `''` (indistinguishable
 *    from a blank role in the data) or to `null` (which would push the absent case
 *    into every consumer's type). `overallAverageKda` is `0` and `topChampions` is
 *    empty in that case.
 *
 * 7. SAME-TIMESTAMP TIEBREAK FOR THE MOST-PLAYED ROLE. Requirement 6.5 breaks a
 *    match-count tie by "the role played in the most recent match". If two tied
 *    roles share the same greatest `startTimestamp`, the code-unit-smallest role
 *    name wins. That rule is deterministic AND independent of the input array's
 *    order, so shuffling the match list can never change the answer.
 *
 * 8. ROUNDING. Two helpers, used everywhere:
 *      - `roundHalfUp(x)` = `Math.round(x)` — halfway cases go toward +Infinity
 *        (0.5 -> 1). This differs from "round half away from zero" for negative
 *        values (-0.5 -> -0-, not -1), which is irrelevant here because every
 *        rounded quantity (percentages, KDA) is non-negative, but is stated so the
 *        property-test oracles agree by definition rather than by luck.
 *      - `round2(x)` = `Math.round(x * 100) / 100`, the same half-up rule scaled
 *        to 2 decimal places.
 *
 * 9. DUPLICATE LEAGUE ENTRIES FOR ONE QUEUE TYPE: the FIRST occurrence wins.
 *    League-V4 returns at most one entry per queue type, so this only fixes a
 *    deterministic answer for malformed input instead of leaving it to iteration
 *    order.
 */

/** Requirement 6.4: cap on the number of top champions reported. */
export const TOP_CHAMPION_LIMIT = 5;

/**
 * Requirement 7.5 (pre-`player-insights`): a window with fewer than this many
 * successfully retrieved matches is "limited data" for `ProfileReport.limitedDataNotice`.
 * Moved here from the now-removed `funFacts.ts` — `limitedDataNotice` is an
 * existing report field this spec does not touch, so it needed a home that
 * outlives that module's deletion.
 */
export const LIMITED_DATA_MATCH_THRESHOLD = 5;

/** `ProfileReport.limitedDataNotice`'s source of truth (see `LIMITED_DATA_MATCH_THRESHOLD`). */
export function isLimitedData(matches: readonly IncludedMatch[]): boolean {
  return matches.length < LIMITED_DATA_MATCH_THRESHOLD;
}

/**
 * Decision 6: reported as the most-played role when there are no matches at all.
 */
export const UNKNOWN_ROLE = 'Unknown';

/**
 * A single match, already flattened to the analyzed player's own perspective and
 * already filtered to an allowed queue type (Requirement 3.5). See decision 1 for
 * where the `MatchDto` -> `IncludedMatch` flattening lives.
 */
/**
 * Item_Slots 0-6 at game end, per Requirement 3.6/3.9 (visual-assets).
 *
 * `items` is a fixed-length tuple rather than a filtered array so that a gap
 * (an empty slot) stays at its own position instead of shifting every later
 * item left. `trinket` is `items[6]` pulled out as its own field, per
 * design.md's "modelled as a slot, not special-cased at the render site" —
 * every call site needs the trinket distinction, so it is not re-derived.
 */
export interface ItemBuild {
  items: readonly [number, number, number, number, number, number];
  trinket: number;
}

/** All slots empty. Used where a match predates item capture. */
export const EMPTY_ITEM_BUILD: ItemBuild = { items: [0, 0, 0, 0, 0, 0], trinket: 0 };

/** The opposing participant in the same lane, for a lane-matchup comparison. */
export interface OpponentSummary {
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  /** 2 decimal places, using the shared match duration. */
  csPerMinute: number;
  visionScore: number;
  /** Requirement 3.2/3.9 — from the SAME participant row this summary describes. */
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
 * `match-detail-tabs` Requirement 6. One of a match's Participants, trimmed to
 * what the General and Runes tabs render. Constructed by `mapping.ts`'s
 * `toMatchParticipant`, which is why this type lives beside `ItemBuild` and
 * `OpponentSummary` rather than in `mapping.ts` — the same domain-output-type
 * placement those two already use.
 */
export interface MatchParticipant {
  /** Requirement 6.6/6.7. No participant record carries a PUUID, including the analyzed player's own. */
  isAnalyzedPlayer: boolean;
  /** Requirement 6.7/6.8. Set from the same row `opponentOf`/`opponentRowOf` chose, never from a champion-name match. */
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
   * Requirement 12.1/12.2. Zero to six non-zero `playerAugmentN` values, Riot's
   * field order. Always `[]` outside queue 2400 — reading the fields is
   * unconditional; only ARAM Mayhem ever has a non-zero value to find.
   */
  augments: readonly number[];
  /**
   * player-insights Requirement 12.4. Neutral-monster (jungle camp) kills only,
   * distinct from `cs` (which already combines this with lane minions) — needed
   * on every participant, not only the analyzed player's own row, so a jungler's
   * camp clear can be compared against the enemy jungler's.
   */
  neutralMinionsKilled: number;
  /**
   * player-insights Requirement 14.1. Fourteen per-participant ping counts,
   * Riot's field order. Only the analyzed player's own row is read today
   * (`funFactsV2.ts`'s most-used-ping fact), but the field lives on every
   * participant for the same reason `killParticipationPercent` does — the
   * analyzed player's row is just one row of a `Full_Lobby`, found by
   * `isAnalyzedPlayer`, not re-derived from a separate top-level field.
   */
  onMyWayPings: number;
  enemyMissingPings: number;
  enemyVisionPings: number;
  needVisionPings: number;
  pushPings: number;
  holdPings: number;
  getBackPings: number;
  assistMePings: number;
  allInPings: number;
  retreatPings: number;
  dangerPings: number;
  basicPings: number;
  commandPings: number;
  visionClearedPings: number;
}

/**
 * Requirement 11. A match played in queue 450 (ARAM) or 2400 (ARAM Mayhem) —
 * admitted to the recent-matches list through `toLanelessMatch`, disjoint from
 * `QUEUE_TYPE_BY_QUEUE_ID` and never fed to a role-relative computation
 * (`computeStats`, `roleAggregatesOf`, `topChampionsOf`, `mostPlayedRoleOf`).
 * Deliberately its own type, not `IncludedMatch`/`RawMatch` — see
 * `match-detail-tabs` design.md decision 14: keeping the two types structurally
 * distinct means a role-relative function simply does not compile against a
 * `LanelessMatch[]`, rather than relying on every future call site to remember
 * a runtime filter.
 */
export interface LanelessMatch {
  matchId: string;
  startTimestamp: number;
  durationSeconds: number;
  win: boolean;
  queueType: 'aram' | 'aram mayhem';
  championName: string;
  /** champion-mastery sidebar section: joins this match to a Champion-Mastery-V4 entry by id. Optional — absent on older cached matches. */
  championId?: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  visionScore: number;
  build: ItemBuild;
  /** All ten. `isEnemyLaner` is `false` on every one — a Laneless_Match has no lane. */
  participants: MatchParticipant[];
}

export interface RawMatch {
  matchId: string;
  queueType: string;
  /** Epoch ms. Supplied by the caller; this module never reads a clock. */
  startTimestamp: number;
  durationSeconds: number;
  championName: string;
  /** champion-mastery sidebar section: joins this match to a Champion-Mastery-V4 entry by id. Optional — absent on older cached matches. */
  championId?: number;
  role: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  visionScore: number;
  /** Minion + neutral-monster kills. Optional so existing fixtures need no change; absent reads as 0. */
  cs?: number;
  /** `undefined` when no opposing participant shares this player's lane. */
  opponent?: OpponentSummary;
  /**
   * Requirement 3.1. Optional so existing fixtures that predate visual-assets need
   * no change; absent reads as an all-zero build, the same as a genuinely empty one.
   */
  build?: ItemBuild;
  /**
   * `match-detail-tabs` Requirement 6.5. All ten Participants, threaded through
   * unchanged by `computeRecentMatches`. Optional so every fixture written before
   * this feature needs no change; absent reads as an empty list, not a failure.
   */
  participants?: MatchParticipant[];
}

export type IncludedMatch = RawMatch;

/** design.md's `LeagueEntry`. See decision 2 on `division` vs Riot's `rank`. */
export interface LeagueEntry {
  queueType: string;
  tier: string;
  division: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

/** A queue type that has a ranked entry (Requirements 6.1, 6.2, 6.6). */
export interface RankedQueueSummary {
  tier: string;
  division: string;
  /** `'N/A'` exactly when `wins + losses === 0` (Requirement 6.6). */
  winRatePercent: number | 'N/A';
  /**
   * Current League Points within the division, 0-100 below Master and unbounded
   * at Master+ — the player's standing, not a per-game delta. Carried straight
   * from League-V4's `leaguePoints`. Consumed by `specs/database/`'s rank-snapshot
   * write hook and `specs/profile-sidebar/`'s rank-history graph.
   */
  leaguePoints: number;
}

/** Requirement 6.1 / 2.8: no entry for a queue type is a valid unranked state. */
export type RankedQueueStanding = RankedQueueSummary | 'Unranked';

export interface ChampionSummary {
  championName: string;
  gamesPlayed: number;
  /** Whole percent (Requirement 6.4). */
  winRatePercent: number;
  /** 2 decimal places, zero-deaths rule of Requirement 6.7 applied. */
  averageKda: number;
  /** 2 decimal places. */
  averageCs: number;
  /** Average of each game's own CS/min, 2 decimal places. */
  averageCsPerMinute: number;
}

export interface ProfileStats {
  /** Keyed by queue type; absent key means `'Unranked'` (decision 3). */
  rankedByQueue: Record<string, RankedQueueStanding>;
  overallAverageKda: number;
  topChampions: ChampionSummary[];
  mostPlayedRole: string;
  /** Requirement 7.3: average match length in minutes over this slice's matches, 2dp. */
  averageMatchDurationMinutes: number;
}

// ---------------------------------------------------------------------------
// Rounding and ordering helpers (decisions 4 and 8)
// ---------------------------------------------------------------------------

/** Half-up rounding to an integer; halfway cases go toward +Infinity. */
export function roundHalfUp(value: number): number {
  return Math.round(value);
}

/** Half-up rounding to 2 decimal places. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Total, locale-independent UTF-16 code-unit comparison (decision 4). */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Requirements 6.2 / 6.6: whole-percent win rate, or `'N/A'` when the
 * denominator is zero. Negative counts are not expected from League-V4; they are
 * not special-cased, so a caller passing them gets the arithmetic result.
 */
export function winRatePercentOf(wins: number, losses: number): number | 'N/A' {
  const total = wins + losses;
  if (total === 0) {
    return 'N/A';
  }
  return roundHalfUp((100 * wins) / total);
}

/**
 * Requirements 6.3 / 6.7: average KDA over a match set, to 2 decimal places.
 * When average deaths is 0 the sum of average kills and assists is returned
 * WITHOUT division. An empty match set yields 0 (there is nothing to average).
 */
export function averageKdaOf(matches: readonly IncludedMatch[]): number {
  if (matches.length === 0) {
    return 0;
  }
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  for (const match of matches) {
    kills += match.kills;
    deaths += match.deaths;
    assists += match.assists;
  }
  const count = matches.length;
  const avgKills = kills / count;
  const avgDeaths = deaths / count;
  const avgAssists = assists / count;
  if (avgDeaths === 0) {
    return round2(avgKills + avgAssists);
  }
  return round2((avgKills + avgAssists) / avgDeaths);
}

/**
 * Requirement 7.3: average match duration over the window, in minutes, to 2
 * decimal places. 0 for an empty window. Lives here (not in `funFacts.ts`, which
 * imports this module) so `computeStats` can include it per queue without a
 * circular import; `funFacts.ts` re-exports it for its existing callers.
 */
export function averageMatchDurationMinutesOf(matches: readonly IncludedMatch[]): number {
  if (matches.length === 0) {
    return 0;
  }
  const totalSeconds = matches.reduce((total, match) => total + match.durationSeconds, 0);
  return round2(totalSeconds / matches.length / 60);
}

// ---------------------------------------------------------------------------
// Per-queue ranked standings
// ---------------------------------------------------------------------------

/**
 * Requirements 2.8 / 6.1 / 6.2 / 6.6. Key set is exactly the queue types present
 * in `league` (decision 3); duplicates resolve to the first occurrence
 * (decision 9). An empty `league` yields an empty record — a valid unranked
 * state, not a failure.
 */
export function rankedByQueueOf(league: readonly LeagueEntry[]): Record<string, RankedQueueStanding> {
  const rankedByQueue: Record<string, RankedQueueStanding> = {};
  for (const entry of league) {
    if (Object.prototype.hasOwnProperty.call(rankedByQueue, entry.queueType)) {
      continue;
    }
    rankedByQueue[entry.queueType] = {
      tier: entry.tier,
      division: entry.division,
      winRatePercent: winRatePercentOf(entry.wins, entry.losses),
      leaguePoints: entry.leaguePoints,
    };
  }
  return rankedByQueue;
}

/**
 * The documented accessor for decision 3: a queue type with no ranked entry
 * reads as `'Unranked'`. Callers rendering a specific queue type should go
 * through this rather than indexing `rankedByQueue` directly.
 */
export function standingForQueue(stats: ProfileStats, queueType: string): RankedQueueStanding {
  return Object.prototype.hasOwnProperty.call(stats.rankedByQueue, queueType)
    ? stats.rankedByQueue[queueType]
    : 'Unranked';
}

/** Average CS (minion + neutral-monster kills) per match, to 2 decimal places. */
export function averageCsOf(matches: readonly IncludedMatch[]): number {
  if (matches.length === 0) {
    return 0;
  }
  const totalCs = matches.reduce((total, match) => total + (match.cs ?? 0), 0);
  return round2(totalCs / matches.length);
}

/** A single game's CS/min; 0 for a non-positive duration rather than a division blow-up. */
export function csPerMinuteOf(cs: number, durationSeconds: number): number {
  return durationSeconds > 0 ? round2(cs / (durationSeconds / 60)) : 0;
}

/**
 * `match-detail-tabs` Requirements 3.4/3.6. A participant's share of their own
 * team's total kills, as a whole-number percentage, or `'N/A'` exactly when the
 * team's total kills is 0 — the same `number | 'N/A'` encoding `winRatePercentOf`
 * already uses for a zero denominator. Negative or non-finite inputs are not
 * expected from a caller that has already coerced them (mapping.ts's `finiteOrZero`
 * runs first); they are not special-cased here, matching `winRatePercentOf`.
 */
export function killParticipationOf(kills: number, assists: number, teamKills: number): number | 'N/A' {
  if (teamKills === 0) {
    return 'N/A';
  }
  return roundHalfUp((100 * (kills + assists)) / teamKills);
}

/** Average, across matches, of each game's own CS/min (decision matches `averageCsOf`'s per-game averaging). */
export function averageCsPerMinuteOf(matches: readonly IncludedMatch[]): number {
  if (matches.length === 0) {
    return 0;
  }
  const total = matches.reduce((sum, match) => sum + csPerMinuteOf(match.cs ?? 0, match.durationSeconds), 0);
  return round2(total / matches.length);
}

// ---------------------------------------------------------------------------
// Top champions (Requirement 6.4)
// ---------------------------------------------------------------------------

/**
 * The total order of Requirement 6.4: games played DESC, then win rate DESC,
 * then champion name ASC by code unit. Champion names are unique across
 * summaries, so the third key makes the order total (no two distinct entries
 * compare as equal).
 */
export function compareChampionSummaries(a: ChampionSummary, b: ChampionSummary): number {
  if (a.gamesPlayed !== b.gamesPlayed) {
    return b.gamesPlayed - a.gamesPlayed;
  }
  if (a.winRatePercent !== b.winRatePercent) {
    return b.winRatePercent - a.winRatePercent;
  }
  return compareStrings(a.championName, b.championName);
}

/** Groups matches by an extracted key, preserving first-seen insertion order. */
function groupBy<K>(
  matches: readonly IncludedMatch[],
  keyOf: (match: IncludedMatch) => K,
): Map<K, IncludedMatch[]> {
  const groups = new Map<K, IncludedMatch[]>();
  for (const match of matches) {
    const key = keyOf(match);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [match]);
    } else {
      bucket.push(match);
    }
  }
  return groups;
}

/**
 * Requirement 6.4. Summarizes every distinct champion, orders them by the total
 * order above, and truncates to `TOP_CHAMPION_LIMIT`. Fewer entries are returned
 * when fewer distinct champions were played.
 */
export function topChampionsOf(matches: readonly IncludedMatch[]): ChampionSummary[] {
  const summaries: ChampionSummary[] = [];
  for (const [championName, championMatches] of groupBy(matches, (match) => match.championName)) {
    const wins = championMatches.reduce((total, match) => total + (match.win ? 1 : 0), 0);
    summaries.push({
      championName,
      gamesPlayed: championMatches.length,
      // Every champion group is non-empty, so this denominator is never 0 and
      // the 'N/A' branch of `winRatePercentOf` is unreachable here.
      winRatePercent: roundHalfUp((100 * wins) / championMatches.length),
      averageKda: averageKdaOf(championMatches),
      averageCs: averageCsOf(championMatches),
      averageCsPerMinute: averageCsPerMinuteOf(championMatches),
    });
  }
  summaries.sort(compareChampionSummaries);
  return summaries.slice(0, TOP_CHAMPION_LIMIT);
}

// ---------------------------------------------------------------------------
// Most-played role (Requirement 6.5)
// ---------------------------------------------------------------------------

/**
 * Requirement 6.5. Highest match count wins; a count tie is broken by the role
 * whose most recent match has the greatest `startTimestamp`; a timestamp tie
 * among those roles is broken by code-unit-smallest role name (decision 7). The
 * result is independent of the order of `matches`. Returns `UNKNOWN_ROLE` for an
 * empty match list (decision 6).
 */
export function mostPlayedRoleOf(matches: readonly IncludedMatch[]): string {
  if (matches.length === 0) {
    return UNKNOWN_ROLE;
  }

  const stats = new Map<string, { count: number; latestTimestamp: number }>();
  for (const match of matches) {
    const current = stats.get(match.role);
    if (current === undefined) {
      stats.set(match.role, { count: 1, latestTimestamp: match.startTimestamp });
    } else {
      current.count += 1;
      if (match.startTimestamp > current.latestTimestamp) {
        current.latestTimestamp = match.startTimestamp;
      }
    }
  }

  let bestRole = '';
  let best: { count: number; latestTimestamp: number } | undefined;
  for (const [role, candidate] of stats) {
    if (
      best === undefined ||
      candidate.count > best.count ||
      (candidate.count === best.count && candidate.latestTimestamp > best.latestTimestamp) ||
      (candidate.count === best.count &&
        candidate.latestTimestamp === best.latestTimestamp &&
        compareStrings(role, bestRole) < 0)
    ) {
      bestRole = role;
      best = candidate;
    }
  }
  return bestRole;
}

// ---------------------------------------------------------------------------
// Per-role aggregates consumed by the recommendation engine (task 11.1)
// ---------------------------------------------------------------------------

/**
 * Aggregates over the player's OWN matches in one role.
 *
 * Exported as a standalone pure helper rather than folded into `ProfileStats`,
 * because it exists for a named consumer — `computeRecommendations` (task 11.1) —
 * and `ProfileStats` is the report-facing shape fixed by design.md. Its two
 * fields are exactly the role baselines Requirements 8.2 and 8.4 need:
 *  - 8.2: average deaths per match for the most-played role. Per the user's
 *    confirmed reading, the "role baseline" is the player's own matches in that
 *    role, consistent with 8.4's explicit "the player's own matches" wording.
 *  - 8.4: the median vision score per match over the player's own matches in
 *    their most-played role.
 *
 * `gamesPlayed === 0` yields zeros for both statistics; task 11.1 must treat an
 * empty role sample as "no baseline" rather than as a baseline of 0.
 */
export interface RoleAggregates {
  role: string;
  gamesPlayed: number;
  averageDeathsPerMatch: number;
  /** Median over the role's matches; even counts average the two middle values. */
  medianVisionScore: number;
  /** Ascending vision scores for the role, so callers need not re-derive them. */
  visionScoresAscending: number[];
}

/** Median of a numeric sample; 0 for an empty sample. Does not mutate its input. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Per-role aggregates over the player's own matches in `role` (see above). */
export function roleAggregatesOf(matches: readonly IncludedMatch[], role: string): RoleAggregates {
  const inRole = matches.filter((match) => match.role === role);
  const visionScoresAscending = inRole.map((match) => match.visionScore).sort((a, b) => a - b);
  const deaths = inRole.reduce((total, match) => total + match.deaths, 0);
  return {
    role,
    gamesPlayed: inRole.length,
    averageDeathsPerMatch: inRole.length === 0 ? 0 : deaths / inRole.length,
    medianVisionScore: medianOf(visionScoresAscending),
    visionScoresAscending,
  };
}

/** Average deaths per match across the whole window; 0 for an empty window. */
export function averageDeathsPerMatchOf(matches: readonly IncludedMatch[]): number {
  if (matches.length === 0) {
    return 0;
  }
  return matches.reduce((total, match) => total + match.deaths, 0) / matches.length;
}

/** Average vision score per match across the whole window; 0 for an empty window. */
export function averageVisionScoreOf(matches: readonly IncludedMatch[]): number {
  if (matches.length === 0) {
    return 0;
  }
  return matches.reduce((total, match) => total + match.visionScore, 0) / matches.length;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Requirements 2.8, 6.1-6.7. Pure: the result depends only on the arguments.
 *
 * `puuid` is part of design.md's declared signature and is accepted for
 * interface stability, but is intentionally unused: the matches handed to this
 * module are already flattened to that player's perspective (decision 1), so
 * there is nothing left to select by PUUID. Named `_puuid` to say so.
 */
export function computeStats(
  matches: readonly IncludedMatch[],
  league: readonly LeagueEntry[],
  _puuid: string,
): ProfileStats {
  return {
    rankedByQueue: rankedByQueueOf(league),
    overallAverageKda: averageKdaOf(matches),
    topChampions: topChampionsOf(matches),
    mostPlayedRole: mostPlayedRoleOf(matches),
    averageMatchDurationMinutes: averageMatchDurationMinutesOf(matches),
  };
}
