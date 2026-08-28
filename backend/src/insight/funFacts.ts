/**
 * Insight Engine — Fun Facts (`computeFunFacts`).
 *
 * PURE MODULE. The only import is `./stats` (types and shared helpers). There is
 * no network, cache, database, `process.env`, HTTP, logging, or wall-clock read
 * anywhere in this file: no `Date.now()`, no `new Date()`. Every time-derived
 * value comes from `IncludedMatch.startTimestamp` / `durationSeconds`, i.e. from
 * data the caller supplies. That is what makes Requirements 7.1-7.6
 * property-testable without fakes.
 *
 * Implements:
 *  - 7.1: most common time-of-day window over four fixed UTC windows
 *    (Night 00:00-05:59, Morning 06:00-11:59, Afternoon 12:00-17:59,
 *    Evening 18:00-23:59), reporting ALL windows tied for the highest count.
 *  - 7.2: longest win streak and longest loss streak as maximum runs of
 *    consecutive results in `startTimestamp` order, 0 when absent.
 *  - 7.3: average match duration across the window, expressed in minutes.
 *  - 7.4: 3 to 4 distinct fun-fact statements drawn from four categories
 *    (rolePreference, championLoyalty, timeOfDay, streak), at most one each.
 *  - 7.5: fewer than 5 matches omits timeOfDay and streak and signals the
 *    limited-data notice.
 *  - 7.6: when fewer than 3 statements remain eligible, only the eligible ones
 *    are produced — never padded from an excluded category.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. UTC HOUR DERIVATION, ARITHMETIC RATHER THAN VIA `Date`. Requirement 7.1 (as
 *    amended) fixes the four windows in UTC, because Riot supplies
 *    `gameStartTimestamp` as epoch milliseconds and a pure module cannot read a
 *    server timezone or a visitor locale without breaking purity. The hour is
 *    computed as `((floor(ms / 3_600_000) % 24) + 24) % 24` — plain integer
 *    arithmetic, no `Date` construction at all, so there is no path through
 *    locale or ICU data.
 *
 * 2. NEGATIVE EPOCH VALUES ARE HANDLED WITH A PROPER MODULO. `%` in JavaScript
 *    keeps the sign of the dividend, so a pre-1970 timestamp would otherwise
 *    yield a negative "hour". The `+ 24) % 24` wrapper maps every input onto
 *    `0..23`, and `Math.floor` (not truncation) makes the division a true floor
 *    division, so e.g. `-1` ms is 23:59:59.999 UTC of 1969-12-31 and classifies
 *    as Evening. Riot never emits such timestamps; the rule exists so the
 *    function is total and its property-test oracle can be stated without
 *    carve-outs.
 *
 * 3. STREAK ORDERING AND EQUAL TIMESTAMPS. Requirement 7.2 orders the window by
 *    match start timestamp. Sorting is done with a STABLE sort on
 *    `startTimestamp` alone (`Array.prototype.sort` is required to be stable),
 *    so matches sharing a timestamp keep their input order. That is a
 *    deterministic total order for a given input array. Note that equal
 *    timestamps CAN in principle change a maximum run length (W L W with all
 *    three at the same instant orders differently than W W L), so the rule is
 *    fixed explicitly rather than left implicit: same-timestamp matches are
 *    consumed in input order. Riot timestamps are per-match and effectively
 *    unique, so this only pins down behavior for degenerate input.
 *
 * 4. DURATION ROUNDING USES `round2`. Requirement 7.3 asks for minutes without
 *    naming a precision. Minutes are a coarse unit, so an integer would throw
 *    away real signal (a 28.5-minute average is meaningfully different from 28),
 *    and `round2` is already the module family's 2-decimal helper used for KDA.
 *    `roundHalfUp` is reserved for whole percentages, which is what the share
 *    figures in the champion-loyalty and role-preference statements use.
 *
 * 5. WHERE THE LIMITED-DATA NOTICE LIVES. design.md declares
 *    `computeFunFacts(matches: IncludedMatch[]): FunFact[]` and puts
 *    `limitedDataNotice: boolean` on `ProfileReport`. That signature is kept
 *    unchanged, and `isLimitedData(matches)` is exported alongside it so the
 *    orchestrator can populate `limitedDataNotice` from the SAME threshold
 *    constant (`LIMITED_DATA_MATCH_THRESHOLD`) that drives the 7.5 exclusions.
 *    One source of truth, no signature drift.
 *
 * 6. CATEGORY ELIGIBILITY. There are exactly four categories, so 7.4's "between
 *    3 and 4" means at least three of the four must be produced whenever all are
 *    eligible; this implementation produces one statement for every eligible
 *    category, in the fixed order rolePreference, championLoyalty, timeOfDay,
 *    streak. A category is eligible only when the data actually supports a
 *    statement:
 *      - `rolePreference`: at least one match AND the derived most-played role is
 *        a non-blank name. Riot can report an empty role string for some queues;
 *        a sentence naming an empty role would be noise, not a fun fact.
 *      - `championLoyalty`: at least one match AND the top champion name is
 *        non-blank, for the same reason.
 *      - `timeOfDay`, `streak`: at least `LIMITED_DATA_MATCH_THRESHOLD` matches
 *        (Requirement 7.5).
 *    Nothing is ever substituted for an ineligible category (Requirement 7.6).
 *
 * 7. "CHAMPION LOYALTY" AND "ROLE PREFERENCE" DEFINITIONS. Requirement 7.4 names
 *    both categories without giving a formula, so the formula below is a
 *    presentation choice WITHIN the category the requirement mandates, chosen to
 *    be the simplest defensible reading:
 *      - loyalty = the most-played champion's share of the window, i.e.
 *        `games on that champion / total matches`, as a whole percent. The
 *        champion is the first entry of `topChampionsOf`, so it inherits
 *        Requirement 6.4's fully specified total order (games DESC, win rate
 *        DESC, name ASC) instead of introducing a second tiebreak rule.
 *      - preference = the most-played role's share of the window, on the same
 *        `count / total` basis, with the role taken from `mostPlayedRoleOf` so it
 *        inherits Requirement 6.5's recency tiebreak.
 *    Both reuse stats.ts rather than re-deriving anything.
 *
 * 8. EMPTY MATCH LIST. `computeFunFacts([])` returns `[]` — no category has data
 *    to speak about — and `isLimitedData([])` is `true`, so the report shows the
 *    notice and no statements. This is the extreme case of Requirement 7.6, not a
 *    special case bolted on beside it.
 *
 * 9. AVERAGE MATCH DURATION IS EXPORTED, NOT PACKAGED AS A FUN FACT.
 *    `FunFact['category']` is a closed four-value union in design.md and match
 *    duration is not one of them, so Requirement 7.3's value is exposed as the
 *    pure helper `averageMatchDurationMinutesOf` for the report layer to render
 *    (the same arrangement as decision 5's `isLimitedData`), rather than being
 *    smuggled into an unrelated category's prose.
 *
 * 10. FUN-FACT TEXT IS DERIVED, NEVER RANDOM. Every statement is a pure function
 *    of the matches, so the same window always yields byte-identical text. The
 *    numeric derivations are additionally exported on their own
 *    (`timeOfDayWindowsOf`, `longestWinStreakOf`, `longestLossStreakOf`,
 *    `championLoyaltyOf`, `rolePreferenceOf`, `averageMatchDurationMinutesOf`) so
 *    tests can assert the numbers directly instead of parsing prose.
 */

import {
  mostPlayedRoleOf,
  roundHalfUp,
  topChampionsOf,
  UNKNOWN_ROLE,
  type IncludedMatch,
} from './stats';

/**
 * Requirement 7.5: a window with fewer than this many successfully retrieved
 * matches is "limited data" — the time-of-day and streak categories are omitted
 * and the notice is shown.
 */
export const LIMITED_DATA_MATCH_THRESHOLD = 5;

/** The four fixed windows of Requirement 7.1, in chronological UTC order. */
export type TimeOfDayWindow = 'Night' | 'Morning' | 'Afternoon' | 'Evening';

/** Canonical reporting order for windows; also the order of tied window output. */
export const TIME_OF_DAY_WINDOWS: readonly TimeOfDayWindow[] = [
  'Night',
  'Morning',
  'Afternoon',
  'Evening',
];

/** design.md's `FunFact`. The category union is closed (see decision 9). */
export interface FunFact {
  category: 'timeOfDay' | 'championLoyalty' | 'rolePreference' | 'streak';
  text: string;
}

// ---------------------------------------------------------------------------
// Requirement 7.1 — time-of-day windows (UTC)
// ---------------------------------------------------------------------------

/**
 * The UTC hour (0-23) of an epoch-millisecond instant, by integer arithmetic
 * only (decision 1). Total over all finite inputs, including negatives
 * (decision 2).
 */
export function utcHourOf(epochMs: number): number {
  const hours = Math.floor(epochMs / 3_600_000);
  return ((hours % 24) + 24) % 24;
}

/** The Requirement 7.1 window containing a given UTC hour. */
export function windowForUtcHour(hour: number): TimeOfDayWindow {
  if (hour < 6) {
    return 'Night';
  }
  if (hour < 12) {
    return 'Morning';
  }
  if (hour < 18) {
    return 'Afternoon';
  }
  return 'Evening';
}

/** The window a single match's start timestamp falls in. */
export function windowOfMatch(match: IncludedMatch): TimeOfDayWindow {
  return windowForUtcHour(utcHourOf(match.startTimestamp));
}

/**
 * Match count per window. All four windows are always present as keys, with 0
 * for windows that never occur, so callers never have to distinguish "absent"
 * from "zero".
 */
export function timeOfDayCountsOf(
  matches: readonly IncludedMatch[],
): Record<TimeOfDayWindow, number> {
  const counts: Record<TimeOfDayWindow, number> = {
    Night: 0,
    Morning: 0,
    Afternoon: 0,
    Evening: 0,
  };
  for (const match of matches) {
    counts[windowOfMatch(match)] += 1;
  }
  return counts;
}

/**
 * Requirement 7.1: every window whose count equals the maximum, in canonical
 * order, excluding every strictly lower window. Empty for an empty window (a
 * maximum count of 0 is not a "most common" window — there are no matches to be
 * common about; see decision 8).
 */
export function timeOfDayWindowsOf(matches: readonly IncludedMatch[]): TimeOfDayWindow[] {
  if (matches.length === 0) {
    return [];
  }
  const counts = timeOfDayCountsOf(matches);
  const maxCount = Math.max(...TIME_OF_DAY_WINDOWS.map((window) => counts[window]));
  return TIME_OF_DAY_WINDOWS.filter((window) => counts[window] === maxCount);
}

// ---------------------------------------------------------------------------
// Requirement 7.2 — streaks
// ---------------------------------------------------------------------------

/**
 * The window in `startTimestamp` order. Stable, so equal timestamps keep input
 * order (decision 3). Does not mutate its input.
 */
export function chronologicalOrderOf(matches: readonly IncludedMatch[]): IncludedMatch[] {
  return [...matches].sort((a, b) => a.startTimestamp - b.startTimestamp);
}

/** Maximum run of matches whose `win` equals `outcome`, in chronological order. */
function longestRunOf(matches: readonly IncludedMatch[], outcome: boolean): number {
  let longest = 0;
  let current = 0;
  for (const match of chronologicalOrderOf(matches)) {
    if (match.win === outcome) {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Requirement 7.2: longest run of consecutive wins; 0 if no win occurs. */
export function longestWinStreakOf(matches: readonly IncludedMatch[]): number {
  return longestRunOf(matches, true);
}

/** Requirement 7.2: longest run of consecutive losses; 0 if no loss occurs. */
export function longestLossStreakOf(matches: readonly IncludedMatch[]): number {
  return longestRunOf(matches, false);
}

// ---------------------------------------------------------------------------
// Requirement 7.3 — average match duration
// ---------------------------------------------------------------------------

/**
 * Requirement 7.3: average match duration over the window (decision 4).
 * Moved to `stats.ts` so `computeStats` can compute it per queue without a
 * circular import; re-exported here for existing callers and tests.
 */
export { averageMatchDurationMinutesOf } from './stats';

// ---------------------------------------------------------------------------
// Champion loyalty and role preference (decision 7)
// ---------------------------------------------------------------------------

/** A "share of the window" derivation: `games` out of `totalMatches`. */
export interface ShareOfWindow {
  /** Champion name or role name. */
  name: string;
  games: number;
  totalMatches: number;
  /** `games / totalMatches` as a whole percent (`roundHalfUp`). */
  sharePercent: number;
}

/**
 * Champion loyalty: the most-played champion (Requirement 6.4's order) and its
 * share of the window. `undefined` when there are no matches.
 */
export function championLoyaltyOf(matches: readonly IncludedMatch[]): ShareOfWindow | undefined {
  const top = topChampionsOf(matches)[0];
  if (top === undefined) {
    return undefined;
  }
  return {
    name: top.championName,
    games: top.gamesPlayed,
    totalMatches: matches.length,
    sharePercent: roundHalfUp((100 * top.gamesPlayed) / matches.length),
  };
}

/**
 * Role preference: the most-played role (Requirement 6.5's order, including its
 * recency tiebreak) and its share of the window. `undefined` when there are no
 * matches.
 */
export function rolePreferenceOf(matches: readonly IncludedMatch[]): ShareOfWindow | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const role = mostPlayedRoleOf(matches);
  const games = matches.filter((match) => match.role === role).length;
  return {
    name: role,
    games,
    totalMatches: matches.length,
    sharePercent: roundHalfUp((100 * games) / matches.length),
  };
}

// ---------------------------------------------------------------------------
// Requirements 7.4-7.6 — eligibility and assembly
// ---------------------------------------------------------------------------

/**
 * Requirement 7.5 / decision 5: the single predicate behind both the omission of
 * the time-of-day and streak categories and `ProfileReport.limitedDataNotice`.
 */
export function isLimitedData(matches: readonly IncludedMatch[]): boolean {
  return matches.length < LIMITED_DATA_MATCH_THRESHOLD;
}

/**
 * A name that cannot carry a meaningful statement (decision 6): blank/whitespace,
 * or `UNKNOWN_ROLE`, which `mostPlayedRoleOf` returns as its no-data sentinel.
 */
function isBlankName(name: string): boolean {
  return name.trim().length === 0 || name === UNKNOWN_ROLE;
}

/** Joins window names for prose: "Night", "Night and Morning", "A, B and C". */
function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? '';
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Requirements 7.4-7.6. Produces one statement per ELIGIBLE category, in the
 * fixed order rolePreference, championLoyalty, timeOfDay, streak — so there is
 * at most one statement per category by construction, and no statement from an
 * excluded category can ever appear.
 *
 * With at least `LIMITED_DATA_MATCH_THRESHOLD` matches and usable role/champion
 * names, all four categories are eligible and 4 statements are returned,
 * satisfying 7.4's "between 3 and 4". Below the threshold only the two
 * always-available categories remain, and the caller pairs the 2 (or 0)
 * statements with the notice from `isLimitedData` per 7.5/7.6.
 *
 * Pure: the result depends only on `matches`.
 */
export function computeFunFacts(matches: readonly IncludedMatch[]): FunFact[] {
  const facts: FunFact[] = [];
  const total = matches.length;
  if (total === 0) {
    return facts;
  }

  const role = rolePreferenceOf(matches);
  if (role !== undefined && !isBlankName(role.name)) {
    facts.push({
      category: 'rolePreference',
      text: `Favourite role: ${role.name}, played in ${role.games} of ${total} recent matches (${role.sharePercent}%).`,
    });
  }

  const champion = championLoyaltyOf(matches);
  if (champion !== undefined && !isBlankName(champion.name)) {
    facts.push({
      category: 'championLoyalty',
      text: `Most loyal to ${champion.name}: ${champion.games} of ${total} recent matches (${champion.sharePercent}%).`,
    });
  }

  if (!isLimitedData(matches)) {
    const windows = timeOfDayWindowsOf(matches);
    const counts = timeOfDayCountsOf(matches);
    const topCount = counts[windows[0]];
    const label = windows.length === 1 ? 'window' : 'windows';
    facts.push({
      category: 'timeOfDay',
      text: `Most often queues up in the ${joinWithAnd(windows)} ${label} (UTC), with ${topCount} of ${total} recent matches starting there.`,
    });

    const wins = longestWinStreakOf(matches);
    const losses = longestLossStreakOf(matches);
    facts.push({
      category: 'streak',
      text: `Longest win streak in this window: ${wins}; longest loss streak: ${losses}.`,
    });
  }

  return facts;
}
