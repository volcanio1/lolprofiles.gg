/**
 * Insight Engine — Improvement Recommendations (`computeRecommendations`).
 *
 * PURE MODULE. The only import is `./stats` (types and shared helpers). There is
 * no network, cache, database, `process.env`, HTTP, logging, or wall-clock read
 * anywhere in this file: no `Date.now()`, no `new Date()`. Every value is derived
 * from the `IncludedMatch[]` the caller supplies, which is what makes
 * Requirements 8.1-8.5 property-testable without fakes.
 *
 * Implements:
 *  - 8.1 (AMENDED): at most 5 recommendations; zero is a valid outcome, and no
 *    recommendation is emitted whose triggering condition is not met.
 *  - 8.2: survivability, when average deaths per match across the window EXCEEDS
 *    the average deaths per match for the player's most-played role.
 *  - 8.3: champion selection, when at least 2 distinct champions were played AND
 *    the most-played champion's win rate is more than 10 percentage points below
 *    the second-most-played champion's win rate.
 *  - 8.4: vision control, when average vision score per match across the window
 *    falls BELOW the median vision score per match over the player's own matches
 *    in their most-played role.
 *  - 8.5: every recommendation carries the specific metric name and the player's
 *    corresponding computed value.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE `category` UNION IS NARROWED TO THE THREE LITERALS. design.md declares
 *    `category: 'survivability' | 'championSelection' | 'visionControl' | string`,
 *    but `| string` widens the type to plain `string` and erases every compile-time
 *    guarantee the first three members were there to provide. Requirements 8.2-8.4
 *    define exactly three triggers and 8.1 (as amended) forbids emitting anything
 *    whose triggering condition is not met, so no fourth category can legitimately
 *    exist. The union is therefore closed here. Any value assignable to the narrow
 *    type is assignable to the declared one, so this is a compatible narrowing for
 *    consumers reading the field.
 *
 * 2. THE ROLE BASELINE IS THE PLAYER'S OWN MATCHES IN THAT ROLE. Requirement 8.2
 *    says "the average deaths per match for the player's most-played role" without
 *    naming a population; 8.4 makes the analogous population explicit ("the
 *    player's own matches played in their most-played role"). Per the user's
 *    confirmed reading, 8.2 uses the same population, i.e.
 *    `roleAggregatesOf(matches, mostPlayedRole).averageDeathsPerMatch`. No
 *    cross-player or global baseline is available to a pure module anyway.
 *
 * 3. CONSEQUENCE OF DECISION 2 — A SINGLE-ROLE WINDOW NEVER TRIGGERS
 *    SURVIVABILITY. If every match in the window is in one role, the most-played
 *    role's match set IS the whole window, so the overall average deaths equals
 *    the role average exactly and Requirement 8.2's strict "exceeds" is false.
 *    This is the correct literal reading of the amended requirement, not a defect:
 *    no workaround (epsilon, `>=`, alternate baseline) is invented here. The
 *    property-test oracle encodes the same rule, so the case is asserted rather
 *    than treated as a bug. The recommendation can only fire when the player plays
 *    at least two roles and their non-primary-role play is deadlier on average.
 *
 * 4. WIN RATES ARE COMPARED AS THE ROUNDED WHOLE PERCENTS PRODUCED BY
 *    `topChampionsOf`. "Most-played" and "second-most-played" in Requirement 8.3
 *    are taken from `topChampionsOf`, so they inherit Requirement 6.4's fully
 *    specified total order (games DESC, win rate DESC, name ASC) instead of
 *    introducing a second, possibly conflicting tiebreak. The comparison then uses
 *    the same `winRatePercent` values that ordering ranked by — and that the report
 *    displays — so the trigger is verifiable from the visible output, exactly as
 *    stats.ts decision 5 argues for the 6.4 tiebreak itself. The threshold is
 *    strict: `second.winRatePercent - top.winRatePercent > 10`, so a gap of
 *    exactly 10 points does NOT trigger.
 *
 * 5. AN EMPTY ROLE SAMPLE IS "NO BASELINE", NOT A BASELINE OF ZERO.
 *    `roleAggregatesOf` returns 0 for both statistics when `gamesPlayed === 0`
 *    (see its doc comment in stats.ts). Comparing against that 0 would be
 *    comparing against a value no match produced, and could fire a recommendation
 *    off a nonexistent baseline (any positive average deaths "exceeds" 0). So both
 *    role-baseline triggers (8.2 and 8.4) require `gamesPlayed > 0`.
 *
 * 6. EMPTY MATCH WINDOW -> `[]`. With no matches, `mostPlayedRoleOf` returns
 *    `UNKNOWN_ROLE`, no match has that role, so the role sample is empty and
 *    decision 5 suppresses both role-baseline triggers; there are also 0 distinct
 *    champions, so 8.3 cannot hold. Zero recommendations is the amended
 *    Requirement 8.1's explicitly valid outcome, so this falls out of the general
 *    rules rather than needing a special case. The same reasoning covers the
 *    subtler case where the window is non-empty but the most-played role name does
 *    not match any match's `role` — which cannot happen for a non-empty window,
 *    since the role is derived from the matches themselves.
 *
 * 7. THE CAP OF 5 IS NEVER BINDING. Requirements 8.2-8.4 define exactly three
 *    triggers and at most one recommendation is emitted per category, so the
 *    result length is in 0..3 — always within Requirement 8.1's cap. No filler
 *    recommendations are invented to approach 5: emitting anything not supported
 *    by 8.2-8.4 would violate the amended 8.1. `MAX_RECOMMENDATIONS` is stated as
 *    a constant and enforced by a final `slice` so the bound is expressed in code
 *    rather than merely argued in prose.
 *
 * 8. DETERMINISTIC ORDERING: the fixed category order survivability,
 *    championSelection, visionControl (`RECOMMENDATION_CATEGORY_ORDER`), which is
 *    also the order Requirements 8.2, 8.3, 8.4 are written in. The order does not
 *    depend on metric magnitudes, so the same window always yields a
 *    byte-identical array, and at most one entry per category holds by
 *    construction.
 *
 * 9. METRIC NAMES AND ROUNDING. Each category reports the player's own computed
 *    value — the left-hand side of its trigger comparison — under a stable name:
 *      - survivability:    `averageDeathsPerMatch`, `round2` of the window average.
 *      - championSelection: `mostPlayedChampionWinRatePercent`, the whole-percent
 *        win rate from `topChampionsOf` (already integral via `roundHalfUp`;
 *        `roundHalfUp` is reapplied so the value is integral by construction
 *        rather than by trusting the producer).
 *      - visionControl:    `averageVisionScorePerMatch`, `round2` of the window
 *        average.
 *    `round2` is the module family's 2-decimal helper (stats.ts decision 8);
 *    2 decimals preserve real signal in per-match averages while keeping the
 *    displayed value stable. The comparison itself is performed on the UNROUNDED
 *    averages, so rounding is a presentation step that can never flip a trigger.
 *    Each recommendation's `text` also names the baseline it was compared against,
 *    so a reader can see why it fired without re-deriving anything.
 */

import {
  averageDeathsPerMatchOf,
  averageVisionScoreOf,
  mostPlayedRoleOf,
  round2,
  roundHalfUp,
  roleAggregatesOf,
  topChampionsOf,
  type IncludedMatch,
  type ProfileStats,
} from './stats';

/** Requirement 8.1 (amended): upper bound on recommendations. Never binding (decision 7). */
export const MAX_RECOMMENDATIONS = 5;

/**
 * Requirement 8.3's threshold, in percentage points. The comparison is strict, so
 * a gap of exactly this value does not trigger (decision 4).
 */
export const CHAMPION_WIN_RATE_GAP_THRESHOLD = 10;

/** The three categories defined by Requirements 8.2, 8.3 and 8.4 (decision 1). */
export type RecommendationCategory = 'survivability' | 'championSelection' | 'visionControl';

/** Fixed output order (decision 8). */
export const RECOMMENDATION_CATEGORY_ORDER: readonly RecommendationCategory[] = [
  'survivability',
  'championSelection',
  'visionControl',
];

/** design.md's `Recommendation`, with `category` narrowed per decision 1. */
export interface Recommendation {
  category: RecommendationCategory;
  text: string;
  metricName: string;
  metricValue: number;
}

/** Stable metric names per category (decision 9). */
export const METRIC_NAMES: Readonly<Record<RecommendationCategory, string>> = {
  survivability: 'averageDeathsPerMatch',
  championSelection: 'mostPlayedChampionWinRatePercent',
  visionControl: 'averageVisionScorePerMatch',
};

// ---------------------------------------------------------------------------
// Individual triggers
// ---------------------------------------------------------------------------

/**
 * Requirement 8.2. Fires iff the window's average deaths per match strictly
 * exceeds the average deaths per match over the player's own matches in their
 * most-played role. `undefined` when the role sample is empty (decision 5) or the
 * condition does not hold — including every single-role window (decision 3).
 */
export function survivabilityRecommendationOf(
  matches: readonly IncludedMatch[],
): Recommendation | undefined {
  const role = mostPlayedRoleOf(matches);
  const roleStats = roleAggregatesOf(matches, role);
  if (roleStats.gamesPlayed === 0) {
    return undefined;
  }
  const overall = averageDeathsPerMatchOf(matches);
  if (!(overall > roleStats.averageDeathsPerMatch)) {
    return undefined;
  }
  return {
    category: 'survivability',
    text:
      `Work on survivability: you average ${round2(overall)} deaths per match across these ` +
      `${matches.length} matches, above your ${round2(roleStats.averageDeathsPerMatch)} deaths ` +
      `per match as ${role}, your most-played role.`,
    metricName: METRIC_NAMES.survivability,
    metricValue: round2(overall),
  };
}

/**
 * Requirement 8.3. Fires iff at least 2 distinct champions were played AND the
 * most-played champion's win rate is more than
 * `CHAMPION_WIN_RATE_GAP_THRESHOLD` percentage points below the
 * second-most-played champion's. Both champions and both win rates come from
 * `topChampionsOf`, i.e. from Requirement 6.4's total order (decision 4).
 */
export function championSelectionRecommendationOf(
  matches: readonly IncludedMatch[],
): Recommendation | undefined {
  const champions = topChampionsOf(matches);
  if (champions.length < 2) {
    return undefined;
  }
  const [top, second] = champions;
  const gap = second.winRatePercent - top.winRatePercent;
  if (!(gap > CHAMPION_WIN_RATE_GAP_THRESHOLD)) {
    return undefined;
  }
  return {
    category: 'championSelection',
    text:
      `Reconsider champion selection: your most-played champion ${top.championName} wins ` +
      `${top.winRatePercent}% of ${top.gamesPlayed} games, ${gap} percentage points below ` +
      `${second.championName} at ${second.winRatePercent}% of ${second.gamesPlayed} games.`,
    metricName: METRIC_NAMES.championSelection,
    metricValue: roundHalfUp(top.winRatePercent),
  };
}

/**
 * Requirement 8.4. Fires iff the window's average vision score per match is
 * strictly below the median vision score over the player's own matches in their
 * most-played role. `undefined` when the role sample is empty (decision 5).
 */
export function visionControlRecommendationOf(
  matches: readonly IncludedMatch[],
): Recommendation | undefined {
  const role = mostPlayedRoleOf(matches);
  const roleStats = roleAggregatesOf(matches, role);
  if (roleStats.gamesPlayed === 0) {
    return undefined;
  }
  const overall = averageVisionScoreOf(matches);
  if (!(overall < roleStats.medianVisionScore)) {
    return undefined;
  }
  return {
    category: 'visionControl',
    text:
      `Improve vision control: you average ${round2(overall)} vision score per match across ` +
      `these ${matches.length} matches, below your median of ` +
      `${round2(roleStats.medianVisionScore)} as ${role}, your most-played role.`,
    metricName: METRIC_NAMES.visionControl,
    metricValue: round2(overall),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Requirements 8.1-8.5. Pure: the result depends only on `matches`.
 *
 * Emits one recommendation per triggered category, in
 * `RECOMMENDATION_CATEGORY_ORDER` (decision 8), so there is at most one per
 * category and the length is 0..3 — within Requirement 8.1's cap of 5
 * (decision 7). Zero recommendations is a valid outcome under the amended
 * Requirement 8.1, and nothing is invented to pad toward the cap.
 *
 * `stats` is part of design.md's declared signature and is accepted for interface
 * stability, but is intentionally unused: every quantity Requirements 8.2-8.4
 * compare is a per-match aggregate derived from `matches` (average and median
 * deaths/vision, per-champion win rates), and `ProfileStats` exposes none of them.
 * Deriving them here from `matches` — via the same stats.ts helpers `computeStats`
 * uses — keeps one source of truth and avoids depending on a caller having
 * populated `stats` consistently with `matches`. Named `_stats` to say so.
 */
export function computeRecommendations(
  matches: readonly IncludedMatch[],
  _stats: ProfileStats,
): Recommendation[] {
  const byCategory: Record<RecommendationCategory, Recommendation | undefined> = {
    survivability: survivabilityRecommendationOf(matches),
    championSelection: championSelectionRecommendationOf(matches),
    visionControl: visionControlRecommendationOf(matches),
  };

  const recommendations: Recommendation[] = [];
  for (const category of RECOMMENDATION_CATEGORY_ORDER) {
    const recommendation = byCategory[category];
    if (recommendation !== undefined) {
      recommendations.push(recommendation);
    }
  }
  return recommendations.slice(0, MAX_RECOMMENDATIONS);
}
