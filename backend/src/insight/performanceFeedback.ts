/**
 * Insight Engine — Performance Feedback (`computePerformanceFeedback`).
 *
 * `player-insights` spec. Replaces the removed `recommendations.ts`
 * (survivability, champion selection, vision control — each compared against
 * the player's OWN role baseline) with four coaching signals compared against
 * either a fixed benchmark or the game the player was actually in (their own
 * teammates, or the specific enemy jungler), computed ONLY from a recent,
 * bounded window of ranked games.
 *
 * PURE MODULE, same discipline as every other file in `backend/src/insight/`:
 * no network, cache, database, `process.env`, HTTP, logging, or wall-clock
 * read. Every value is derived from the `IncludedMatch[]` the caller supplies.
 *
 * Implements:
 *  - Requirement 6: the data source is `recentRankedWindowOf(matches)` — only
 *    `'ranked solo/duo'`/`'ranked flex'` queue types, capped to the most
 *    recent `PERFORMANCE_FEEDBACK_WINDOW` (30) by `startTimestamp`, so
 *    feedback tracks current form rather than a stale, months-old average.
 *  - Requirement 7: a category appears only when its trigger holds; zero
 *    triggered categories is a valid, non-padded outcome.
 *  - Requirement 8: CS/min and damage-share are suppressed outright — not
 *    evaluated, not just hidden — for a player whose most-played role over the
 *    Recent_Ranked_Window is Support.
 *  - Requirement 9: CS/min below a flat 8.5 benchmark.
 *  - Requirement 10: damage below 80% of the player's own teammates' average,
 *    over matches that carry a Full_Lobby.
 *  - Requirement 11: kill participation below a flat 50% benchmark, over
 *    matches with a usable (non-`'N/A'`) value.
 *  - Requirement 12: for jungle matches only, camp-clear + objective credits
 *    below 80% of the specific enemy jungler's, over matches where one can be
 *    identified.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. `recentRankedWindowOf` FILTERS THEN CAPS, IN THAT ORDER. Filtering first
 *    means the 30-match cap is 30 RANKED games, not 30 games-of-any-type from
 *    which only some survive filtering — a player who plays mostly normals
 *    still gets a full 30-ranked-game feedback window as long as they have
 *    that many anywhere in their Included_Match history, not just their most
 *    recent 30 games overall.
 *
 * 2. ROLE DETERMINATION REUSES `mostPlayedRoleOf` UNCHANGED, CALLED ON THE
 *    ALREADY-NARROWED WINDOW. `stats.ts`'s `mostPlayedRoleOf` already returns
 *    the DISPLAY-normalized role string (`roleOf`'s `UTILITY` -> `Support`
 *    rename happens upstream, in `orchestrator/mapping.ts`, before this module
 *    ever sees `IncludedMatch.role`), so comparing against the literal string
 *    `'Support'` is correct and needs no second normalization step here.
 *
 * 3. DAMAGE SHARE COMPARES MEAN-OF-MATCH-AVERAGES, NOT A MEAN OF PER-MATCH
 *    RATIOS. Requirement 10 does not specify which; averaging the player's own
 *    damage across contributing matches and separately averaging their
 *    teammates' damage across the SAME matches, then comparing the two means,
 *    is what Requirement 10.5's text ("state the player's own average damage
 *    and their teammates' average damage") directly asks the feedback item to
 *    report — so the numbers the trigger compares are the same numbers the
 *    text shows, with nothing intermediate that Requirement 10.5 doesn't ask
 *    the player to see.
 *
 * 4. JUNGLE OBJECTIVES READS THE SELF ROW'S `teamPosition` — Riot's raw
 *    unrenamed field — NOT `IncludedMatch.role` (which is display-normalized
 *    for `UTILITY` only; `JUNGLE` is unaffected either way, but reading the
 *    Full_Lobby row directly is what Requirement 12.1 literally specifies:
 *    "from their own Full_Lobby row").
 *
 * 5. A CONTRIBUTING-MATCH COUNT OF ZERO NEVER TRIGGERS. Every trigger in this
 *    module requires at least one contributing match before its numeric
 *    comparison is even evaluated — an average of nothing is not "below" a
 *    benchmark, it is undefined, and treating it as 0 would fire every
 *    category for a player with no qualifying data at all (decision 5 in the
 *    removed `recommendations.ts` made the same argument for its own
 *    role-baseline triggers).
 */

import { averageCsPerMinuteOf, mostPlayedRoleOf, round2, type IncludedMatch } from './stats';

// ---------------------------------------------------------------------------
// Requirement 6 — data source
// ---------------------------------------------------------------------------

/** Requirement 6.1: the two Ranked_Match queue types. */
const RANKED_QUEUE_TYPES: ReadonlySet<string> = new Set(['ranked solo/duo', 'ranked flex']);

/** Requirement 6.1: the recency cap, in matches. */
export const PERFORMANCE_FEEDBACK_WINDOW = 30;

/**
 * Requirement 6: Ranked_Matches only (6.2), the most recent
 * `PERFORMANCE_FEEDBACK_WINDOW` by `startTimestamp` descending (6.1/6.3).
 * Fewer than 30 available -> all of them, never padded (6.4). Order-stable
 * for equal timestamps (native `sort` is a stable sort).
 */
export function recentRankedWindowOf(matches: readonly IncludedMatch[]): IncludedMatch[] {
  return matches
    .filter((match) => RANKED_QUEUE_TYPES.has(match.queueType))
    .slice()
    .sort((a, b) => b.startTimestamp - a.startTimestamp)
    .slice(0, PERFORMANCE_FEEDBACK_WINDOW);
}

// ---------------------------------------------------------------------------
// Requirement 8 — Support suppression
// ---------------------------------------------------------------------------

const SUPPORT_ROLE = 'Support';

/** Requirement 8.1: role determination over the Recent_Ranked_Window only (decision 2). */
export function isSupportMajority(rankedMatches: readonly IncludedMatch[]): boolean {
  return mostPlayedRoleOf(rankedMatches) === SUPPORT_ROLE;
}

// ---------------------------------------------------------------------------
// Shared shape
// ---------------------------------------------------------------------------

export type PerformanceFeedbackCategory =
  | 'csPerMinute'
  | 'damageShare'
  | 'killParticipation'
  | 'jungleObjectives'
  | 'lanePhaseDeaths'
  | 'earlyGameDeficit';

export interface PerformanceFeedback {
  category: PerformanceFeedbackCategory;
  text: string;
  metricName: string;
  metricValue: number;
  /** What the value was compared against (Requirement 9.3/10.5/11.5/12.7). */
  benchmarkValue: number;
}

/**
 * Fixed output order (design.md); CS/min and damage share adjacent since
 * Requirement 8's suppression covers exactly those two. The two Phase 2
 * categories are appended last, matching Requirements 15/16's numbering after
 * 9-12.
 */
export const PERFORMANCE_FEEDBACK_CATEGORY_ORDER: readonly PerformanceFeedbackCategory[] = [
  'csPerMinute',
  'damageShare',
  'killParticipation',
  'jungleObjectives',
  'lanePhaseDeaths',
  'earlyGameDeficit',
];

const METRIC_NAMES: Readonly<Record<PerformanceFeedbackCategory, string>> = {
  csPerMinute: 'averageCsPerMinute',
  damageShare: 'averageDamageToChampions',
  killParticipation: 'averageKillParticipationPercent',
  jungleObjectives: 'averageJungleObjectiveScore',
  lanePhaseDeaths: 'averageLanePhaseDeaths',
  earlyGameDeficit: 'averageGoldDiffAt10',
};

// ---------------------------------------------------------------------------
// Requirement 9 — CS per minute
// ---------------------------------------------------------------------------

/** Requirement 9.2: strict benchmark, in CS/min. */
export const CS_PER_MINUTE_BENCHMARK = 8.5;

/** Requirement 9. `undefined` when suppressed (Requirement 8) or not below benchmark. */
export function csPerMinuteFeedbackOf(rankedMatches: readonly IncludedMatch[]): PerformanceFeedback | undefined {
  if (isSupportMajority(rankedMatches)) {
    return undefined; // Requirement 8.2
  }
  if (rankedMatches.length === 0) {
    return undefined; // decision 5
  }
  const average = averageCsPerMinuteOf(rankedMatches);
  if (!(average < CS_PER_MINUTE_BENCHMARK)) {
    return undefined;
  }
  return {
    category: 'csPerMinute',
    text:
      `Your CS/min is behind: you average ${round2(average)} CS/min across your last ${rankedMatches.length} ` +
      `ranked games, below the ${CS_PER_MINUTE_BENCHMARK} CS/min benchmark.`,
    metricName: METRIC_NAMES.csPerMinute,
    metricValue: round2(average),
    benchmarkValue: CS_PER_MINUTE_BENCHMARK,
  };
}

// ---------------------------------------------------------------------------
// Requirement 10 — damage compared to team
// ---------------------------------------------------------------------------

/** Requirement 10.3: the player's average damage must fall below this fraction of their teammates' average. */
export const TEAM_DAMAGE_SHARE_THRESHOLD = 0.8;

interface DamagePair {
  self: number;
  teamAverage: number;
}

function damagePairsOf(rankedMatches: readonly IncludedMatch[]): DamagePair[] {
  const pairs: DamagePair[] = [];
  for (const match of rankedMatches) {
    const participants = match.participants;
    if (participants === undefined) {
      continue; // Requirement 10.2
    }
    const self = participants.find((p) => p.isAnalyzedPlayer);
    if (self === undefined) {
      continue;
    }
    const teammates = participants.filter((p) => p.teamId === self.teamId && !p.isAnalyzedPlayer);
    if (teammates.length === 0) {
      continue;
    }
    const teamAverage = teammates.reduce((sum, p) => sum + p.damageToChampions, 0) / teammates.length;
    pairs.push({ self: self.damageToChampions, teamAverage });
  }
  return pairs;
}

/** Requirement 10. `undefined` when suppressed (Requirement 8), no Full_Lobby data, or not below threshold. */
export function damageShareFeedbackOf(rankedMatches: readonly IncludedMatch[]): PerformanceFeedback | undefined {
  if (isSupportMajority(rankedMatches)) {
    return undefined; // Requirement 8.2
  }
  const pairs = damagePairsOf(rankedMatches);
  if (pairs.length === 0) {
    return undefined; // Requirements 10.4, decision 5
  }
  const averageSelf = pairs.reduce((sum, p) => sum + p.self, 0) / pairs.length;
  const averageTeam = pairs.reduce((sum, p) => sum + p.teamAverage, 0) / pairs.length;
  if (!(averageSelf < TEAM_DAMAGE_SHARE_THRESHOLD * averageTeam)) {
    return undefined;
  }
  return {
    category: 'damageShare',
    text:
      `Your damage is behind your team: you average ${round2(averageSelf)} damage to champions across ` +
      `${pairs.length} ranked games, below ${Math.round(TEAM_DAMAGE_SHARE_THRESHOLD * 100)}% of your ` +
      `teammates' average of ${round2(averageTeam)}.`,
    metricName: METRIC_NAMES.damageShare,
    metricValue: round2(averageSelf),
    benchmarkValue: round2(TEAM_DAMAGE_SHARE_THRESHOLD * averageTeam),
  };
}

// ---------------------------------------------------------------------------
// Requirement 11 — kill participation
// ---------------------------------------------------------------------------

/** Requirement 11.3: strict benchmark, in whole percent. */
export const KILL_PARTICIPATION_BENCHMARK = 50;

/** Requirement 11. `undefined` when no usable data, or not below benchmark. */
export function killParticipationFeedbackOf(rankedMatches: readonly IncludedMatch[]): PerformanceFeedback | undefined {
  const values: number[] = [];
  for (const match of rankedMatches) {
    const self = match.participants?.find((p) => p.isAnalyzedPlayer);
    if (self === undefined || self.killParticipationPercent === 'N/A') {
      continue; // Requirement 11.2
    }
    values.push(self.killParticipationPercent);
  }
  if (values.length === 0) {
    return undefined; // Requirement 11.4, decision 5
  }
  const average = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (!(average < KILL_PARTICIPATION_BENCHMARK)) {
    return undefined;
  }
  return {
    category: 'killParticipation',
    text:
      `Your kill participation is low: you average ${round2(average)}% across ${values.length} ranked games, ` +
      `below the ${KILL_PARTICIPATION_BENCHMARK}% benchmark.`,
    metricName: METRIC_NAMES.killParticipation,
    metricValue: round2(average),
    benchmarkValue: KILL_PARTICIPATION_BENCHMARK,
  };
}

// ---------------------------------------------------------------------------
// Requirement 12 — jungler objective control vs. the enemy jungler
// ---------------------------------------------------------------------------

/** Requirement 12.5: the player's average must fall below this fraction of the enemy jungler's average. */
export const JUNGLE_OBJECTIVE_THRESHOLD = 0.8;

const JUNGLE_TEAM_POSITION = 'JUNGLE';

interface JunglePair {
  self: number;
  enemy: number;
}

/** Requirement 12.4: camp-clear proxy + objective kill-credits, combined into one figure. */
function jungleScoreOf(participant: { neutralMinionsKilled: number; turretKills: number; dragonKills: number; baronKills: number }): number {
  return participant.neutralMinionsKilled + participant.turretKills + participant.dragonKills + participant.baronKills;
}

function junglePairsOf(rankedMatches: readonly IncludedMatch[]): JunglePair[] {
  const pairs: JunglePair[] = [];
  for (const match of rankedMatches) {
    const participants = match.participants;
    if (participants === undefined) {
      continue; // Requirement 12.3
    }
    const self = participants.find((p) => p.isAnalyzedPlayer);
    if (self === undefined || self.teamPosition !== JUNGLE_TEAM_POSITION) {
      continue; // Requirement 12.1: jungle matches only (decision 4)
    }
    const enemyJungler = participants.find((p) => p.teamId !== self.teamId && p.teamPosition === JUNGLE_TEAM_POSITION);
    if (enemyJungler === undefined) {
      continue; // Requirement 12.3
    }
    pairs.push({ self: jungleScoreOf(self), enemy: jungleScoreOf(enemyJungler) });
  }
  return pairs;
}

/** Requirement 12. `undefined` when no qualifying jungle match, or not below threshold. */
export function jungleObjectivesFeedbackOf(rankedMatches: readonly IncludedMatch[]): PerformanceFeedback | undefined {
  const pairs = junglePairsOf(rankedMatches);
  if (pairs.length === 0) {
    return undefined; // Requirement 12.6, decision 5
  }
  const averageSelf = pairs.reduce((sum, p) => sum + p.self, 0) / pairs.length;
  const averageEnemy = pairs.reduce((sum, p) => sum + p.enemy, 0) / pairs.length;
  if (!(averageSelf < JUNGLE_OBJECTIVE_THRESHOLD * averageEnemy)) {
    return undefined;
  }
  return {
    category: 'jungleObjectives',
    text:
      `The enemy jungler is out-farming and out-securing objectives against you: you average ` +
      `${round2(averageSelf)} camp/objective score across ${pairs.length} jungle games, below ` +
      `${Math.round(JUNGLE_OBJECTIVE_THRESHOLD * 100)}% of the enemy jungler's average of ${round2(averageEnemy)}.`,
    metricName: METRIC_NAMES.jungleObjectives,
    metricValue: round2(averageSelf),
    benchmarkValue: round2(JUNGLE_OBJECTIVE_THRESHOLD * averageEnemy),
  };
}

// ---------------------------------------------------------------------------
// Requirements 15-16 — Phase 2: lane-phase deaths, early-game gold/CS deficit
// ---------------------------------------------------------------------------

/**
 * One Ranked_Match's Phase 2 derivation, computed by
 * `orchestrator/earlyGame.ts` from that match's Match_Timeline (fetched and
 * cached separately — this module never fetches anything). Each field is
 * independently nullable: a match can carry a lane-phase death count with no
 * gold/CS diff (no Lane_Opponent identified, or the match ended before 10
 * minutes — Requirement 16.4), or vice versa is simply not possible in
 * practice but is not assumed either way here.
 */
export interface EarlyGameAggregate {
  matchId: string;
  /** `null` when the Match_Timeline could not be retrieved (Requirement 15.4). */
  lanePhaseDeaths: number | null;
  /** `null` when no Lane_Opponent, no timeline, or the match ended before 10:00 (Requirement 16.4). Self minus opponent. */
  goldDiffAt10: number | null;
  /** Same nullability as `goldDiffAt10`, and always computed alongside it (decision below). */
  csDiffAt10: number | null;
}

/** Requirement 15.3: the default is an interpretation choice (design.md Open Question 3) — more than 2 lane-phase deaths per match, on average, is a real pattern. */
export const LANE_PHASE_DEATH_BENCHMARK = 2;

/** Requirement 15. `undefined` when no ranked match has a usable lane-phase-death count, or not above benchmark. */
export function lanePhaseDeathsFeedbackOf(
  rankedMatches: readonly IncludedMatch[],
  earlyGame: readonly EarlyGameAggregate[],
): PerformanceFeedback | undefined {
  const rankedMatchIds = new Set(rankedMatches.map((match) => match.matchId));
  const values = earlyGame
    .filter((entry) => rankedMatchIds.has(entry.matchId) && entry.lanePhaseDeaths !== null)
    .map((entry) => entry.lanePhaseDeaths as number);
  if (values.length === 0) {
    return undefined; // Requirement 15.4, decision 5
  }
  const average = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (!(average > LANE_PHASE_DEATH_BENCHMARK)) {
    return undefined;
  }
  return {
    category: 'lanePhaseDeaths',
    text:
      `You're dying too often in lane: you average ${round2(average)} deaths before 15 minutes across ` +
      `${values.length} ranked games, above the ${LANE_PHASE_DEATH_BENCHMARK}-death benchmark.`,
    metricName: METRIC_NAMES.lanePhaseDeaths,
    metricValue: round2(average),
    benchmarkValue: LANE_PHASE_DEATH_BENCHMARK,
  };
}

/**
 * Requirement 16.3: an interpretation choice (design.md Open Question 3) — the
 * trigger reads the gold diff only. CS is real signal but gold already
 * reflects a meaningful share of it (CS converts to gold) plus kill/objective
 * gold that CS alone would miss, so a single trigger on the more complete
 * number avoids two thresholds that could disagree about whether a game was
 * "behind". CS is still reported in the text, for context, not as a second
 * condition.
 */
export const EARLY_GAME_GOLD_DEFICIT_THRESHOLD = 300;

/** Requirement 16. `undefined` when no ranked match has a usable gold diff, or not behind by more than the threshold. */
export function earlyGameDeficitFeedbackOf(
  rankedMatches: readonly IncludedMatch[],
  earlyGame: readonly EarlyGameAggregate[],
): PerformanceFeedback | undefined {
  const rankedMatchIds = new Set(rankedMatches.map((match) => match.matchId));
  const entries = earlyGame.filter((entry) => rankedMatchIds.has(entry.matchId) && entry.goldDiffAt10 !== null);
  if (entries.length === 0) {
    return undefined; // Requirement 16.4, decision 5
  }
  const averageGoldDiff = entries.reduce((sum, e) => sum + (e.goldDiffAt10 as number), 0) / entries.length;
  if (!(averageGoldDiff < -EARLY_GAME_GOLD_DEFICIT_THRESHOLD)) {
    return undefined;
  }
  const csEntries = entries.filter((entry) => entry.csDiffAt10 !== null);
  const averageCsDiff =
    csEntries.length > 0 ? csEntries.reduce((sum, e) => sum + (e.csDiffAt10 as number), 0) / csEntries.length : null;
  return {
    category: 'earlyGameDeficit',
    text:
      `You're behind at 10 minutes: you average ${round2(averageGoldDiff)} gold` +
      (averageCsDiff !== null ? ` and ${round2(averageCsDiff)} CS` : '') +
      ` relative to your lane opponent across ${entries.length} ranked games, more than ` +
      `${EARLY_GAME_GOLD_DEFICIT_THRESHOLD} gold behind on average.`,
    metricName: METRIC_NAMES.earlyGameDeficit,
    metricValue: round2(averageGoldDiff),
    benchmarkValue: -EARLY_GAME_GOLD_DEFICIT_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Requirements 7, 8, 9, 10, 11, 12, 15, 16. Pure: the result depends only on
 * `rankedMatches` and `earlyGame` — callers pass `recentRankedWindowOf(matches)`
 * for the former, never the full `IncludedMatch[]` window (Requirement 6).
 * `earlyGame` defaults to `[]` so every Phase 1 call site (and every existing
 * test) is unaffected — Phase 2's two categories simply never trigger without
 * it, the same as any other category with no contributing data. Emits one item
 * per triggered category, in `PERFORMANCE_FEEDBACK_CATEGORY_ORDER`, so there is
 * at most one per category and nothing is padded to reach any particular count
 * (7.3); zero is a valid outcome (7.4).
 */
export function computePerformanceFeedback(
  rankedMatches: readonly IncludedMatch[],
  earlyGame: readonly EarlyGameAggregate[] = [],
): PerformanceFeedback[] {
  const byCategory: Record<PerformanceFeedbackCategory, PerformanceFeedback | undefined> = {
    csPerMinute: csPerMinuteFeedbackOf(rankedMatches),
    damageShare: damageShareFeedbackOf(rankedMatches),
    killParticipation: killParticipationFeedbackOf(rankedMatches),
    jungleObjectives: jungleObjectivesFeedbackOf(rankedMatches),
    lanePhaseDeaths: lanePhaseDeathsFeedbackOf(rankedMatches, earlyGame),
    earlyGameDeficit: earlyGameDeficitFeedbackOf(rankedMatches, earlyGame),
  };

  const feedback: PerformanceFeedback[] = [];
  for (const category of PERFORMANCE_FEEDBACK_CATEGORY_ORDER) {
    const item = byCategory[category];
    if (item !== undefined) {
      feedback.push(item);
    }
  }
  return feedback;
}
