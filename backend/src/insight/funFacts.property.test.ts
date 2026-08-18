import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeFunFacts,
  isLimitedData,
  longestLossStreakOf,
  longestWinStreakOf,
  timeOfDayWindowsOf,
} from './funFacts';
import type { IncludedMatch } from './stats';

/**
 * Property tests for the Insight Engine's fun facts (Properties 12, 13, 14).
 *
 * Every oracle below is transcribed from the acceptance criteria in
 * requirements.md and written independently of `funFacts.ts` — only the
 * functions under test are imported, so the oracles here (UTC hour derivation,
 * window classification, run-length scanning, eligibility rules) cannot agree
 * with the implementation by sharing code.
 *
 * All timestamps come from generated data; no test reads a clock. No test parses
 * fun-fact prose for numeric assertions — the numbers are asserted against the
 * exported derivations directly.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** 2021-01-01T00:00:00.000Z. */
const MIDNIGHT_UTC = 1_609_459_200_000;
const THRESHOLD = 5;

// --- independent oracles ---------------------------------------------------

type Window = 'Night' | 'Morning' | 'Afternoon' | 'Evening';
const ORACLE_WINDOWS: readonly Window[] = ['Night', 'Morning', 'Afternoon', 'Evening'];

/** Requirement 7.1: UTC hour of an epoch-ms instant, non-negative modulo. */
function oracleUtcHour(epochMs: number): number {
  const hours = Math.floor(epochMs / HOUR);
  return ((hours % 24) + 24) % 24;
}

/** Requirement 7.1's four fixed windows. */
function oracleWindow(epochMs: number): Window {
  const hour = oracleUtcHour(epochMs);
  if (hour >= 0 && hour <= 5) {
    return 'Night';
  }
  if (hour >= 6 && hour <= 11) {
    return 'Morning';
  }
  if (hour >= 12 && hour <= 17) {
    return 'Afternoon';
  }
  return 'Evening';
}

function oracleWindowCounts(matches: readonly IncludedMatch[]): Record<Window, number> {
  const counts: Record<Window, number> = { Night: 0, Morning: 0, Afternoon: 0, Evening: 0 };
  for (const m of matches) {
    counts[oracleWindow(m.startTimestamp)] += 1;
  }
  return counts;
}

/** Requirement 7.2: maximum run of consecutive `outcome`s in timestamp order. */
function oracleLongestRun(matches: readonly IncludedMatch[], outcome: boolean): number {
  const ordered = [...matches].sort((a, b) => a.startTimestamp - b.startTimestamp);
  let longest = 0;
  let run = 0;
  for (const m of ordered) {
    run = m.win === outcome ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/**
 * Requirements 7.4/7.5: the categories that may appear, given a window whose
 * roles and champion names are always non-blank (as the generators guarantee).
 */
function oracleEligibleCategories(matches: readonly IncludedMatch[]): string[] {
  if (matches.length === 0) {
    return [];
  }
  const always = ['rolePreference', 'championLoyalty'];
  return matches.length < THRESHOLD ? always : [...always, 'timeOfDay', 'streak'];
}

// --- generators ------------------------------------------------------------

const CHAMPION_POOL = ['Ahri', 'Bard', 'Caitlyn', 'Darius'];
const ROLE_POOL = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM'];

function matchAt(startTimestamp: number, win: boolean, index: number): IncludedMatch {
  return {
    matchId: `NA1_${index}`,
    queueType: 'ranked solo/duo',
    startTimestamp,
    durationSeconds: 1800,
    championName: CHAMPION_POOL[index % CHAMPION_POOL.length],
    role: ROLE_POOL[index % ROLE_POOL.length],
    win,
    kills: 5,
    deaths: 2,
    assists: 5,
    visionScore: 20,
  };
}

/** An hour-of-day within a named window, so ties can be forced deliberately. */
const WINDOW_HOURS: Record<Window, readonly number[]> = {
  Night: [0, 3, 5],
  Morning: [6, 9, 11],
  Afternoon: [12, 15, 17],
  Evening: [18, 21, 23],
};

function hourInWindowArb(window: Window): fc.Arbitrary<number> {
  return fc.constantFrom(...WINDOW_HOURS[window]);
}

/** Timestamps clustered so that any requested window multiset is realizable. */
function timestampsForWindowsArb(windows: readonly Window[]): fc.Arbitrary<number[]> {
  return fc.tuple(
    ...windows.map((window) =>
      fc
        .tuple(hourInWindowArb(window), fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 30 }))
        .map(([hour, minute, day]) => MIDNIGHT_UTC + day * 24 * HOUR + hour * HOUR + minute * MINUTE),
    ),
  );
}

/**
 * A window-shape generator that deliberately produces 1-, 2-, 3- and 4-way ties
 * for the highest window count, alongside freely chosen shapes.
 */
const tiedWindowShapeArb: fc.Arbitrary<Window[]> = fc.oneof(
  // Deliberate k-way ties: k windows with `perWindow` matches each, and the
  // remaining windows strictly lower (0 or fewer).
  fc
    .tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 3 }))
    .map(([k, perWindow]) => {
      const chosen = ORACLE_WINDOWS.slice(0, k);
      const shape: Window[] = [];
      for (const window of chosen) {
        for (let i = 0; i < perWindow; i += 1) {
          shape.push(window);
        }
      }
      // Lower-count filler in the remaining windows, when there is room below.
      if (perWindow > 1) {
        for (const window of ORACLE_WINDOWS.slice(k)) {
          for (let i = 0; i < perWindow - 1; i += 1) {
            shape.push(window);
          }
        }
      }
      return shape;
    }),
  // Free-form shapes, including empty.
  fc.array(fc.constantFrom(...ORACLE_WINDOWS), { maxLength: 12 }),
);

const timeOfDayMatchesArb: fc.Arbitrary<IncludedMatch[]> = tiedWindowShapeArb.chain((shape) =>
  fc
    .tuple(timestampsForWindowsArb(shape), fc.array(fc.boolean(), { minLength: shape.length, maxLength: shape.length }))
    .map(([timestamps, wins]) => timestamps.map((ts, index) => matchAt(ts, wins[index], index))),
);

/** Outcome sequences that hit all-win, all-loss and alternating shapes often. */
const outcomeSequenceArb: fc.Arbitrary<boolean[]> = fc.oneof(
  { arbitrary: fc.array(fc.boolean(), { maxLength: 14 }), weight: 4 },
  { arbitrary: fc.integer({ min: 1, max: 10 }).map((n) => Array.from({ length: n }, () => true)), weight: 1 },
  { arbitrary: fc.integer({ min: 1, max: 10 }).map((n) => Array.from({ length: n }, () => false)), weight: 1 },
  {
    arbitrary: fc
      .tuple(fc.integer({ min: 2, max: 10 }), fc.boolean())
      .map(([n, first]) => Array.from({ length: n }, (_unused, i) => (i % 2 === 0 ? first : !first))),
    weight: 1,
  },
);

/**
 * Matches built from an outcome sequence, with timestamps that are increasing
 * but shuffled in array order, so ordering-by-timestamp is genuinely exercised.
 */
const streakMatchesArb: fc.Arbitrary<IncludedMatch[]> = outcomeSequenceArb.chain((outcomes) =>
  fc
    .shuffledSubarray(
      outcomes.map((win, index) => matchAt(MIDNIGHT_UTC + index * MINUTE, win, index)),
      { minLength: outcomes.length, maxLength: outcomes.length },
    )
    .map((shuffled) => shuffled),
);

/** Windows spanning both sides of the 5-match threshold. */
const eligibilityMatchesArb: fc.Arbitrary<IncludedMatch[]> = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 23 }), fc.boolean()), { minLength: 0, maxLength: 9 })
  .map((seeds) =>
    seeds.map(([hour, win], index) => matchAt(MIDNIGHT_UTC + index * 24 * HOUR + hour * HOUR, win, index)),
  );

// Feature: lolprofiles-gg, Property 12: Time-of-day window derivation reports all tied windows
// **Validates: Requirements 7.1**
describe('Property 12: time-of-day window derivation', () => {
  it('reports exactly the windows tied for the highest count and excludes every lower window', () => {
    const tieWidthsSeen = new Set<number>();

    fc.assert(
      fc.property(timeOfDayMatchesArb, (matches) => {
        const reported = timeOfDayWindowsOf(matches);

        if (matches.length === 0) {
          expect(reported).toEqual([]);
          return true;
        }

        const counts = oracleWindowCounts(matches);
        const maxCount = Math.max(...ORACLE_WINDOWS.map((w) => counts[w]));
        const expected = ORACLE_WINDOWS.filter((w) => counts[w] === maxCount);

        // Exactly the tied windows, no more and no fewer.
        expect([...reported].sort()).toEqual([...expected].sort());
        // And explicitly: no strictly-lower window is reported.
        for (const window of ORACLE_WINDOWS) {
          if (counts[window] < maxCount) {
            expect(reported).not.toContain(window);
          } else {
            expect(reported).toContain(window);
          }
        }

        tieWidthsSeen.add(expected.length);
        return true;
      }),
      { numRuns: 300 },
    );

    // Non-degenerate coverage: unique maxima plus 2-, 3- and 4-way ties.
    expect(tieWidthsSeen.has(1)).toBe(true);
    expect(tieWidthsSeen.has(2)).toBe(true);
    expect(tieWidthsSeen.has(3)).toBe(true);
    expect(tieWidthsSeen.has(4)).toBe(true);
  });
});

// Feature: lolprofiles-gg, Property 13: Win/loss streak lengths are computed correctly
// **Validates: Requirements 7.2**
describe('Property 13: win/loss streak lengths', () => {
  it('equals the true maximum run of consecutive results, 0 when that outcome never occurs', () => {
    let sawAllWins = false;
    let sawAllLosses = false;
    let sawAlternating = false;
    let sawAbsentWinStreak = false;
    let sawAbsentLossStreak = false;

    fc.assert(
      fc.property(streakMatchesArb, (matches) => {
        const expectedWins = oracleLongestRun(matches, true);
        const expectedLosses = oracleLongestRun(matches, false);

        expect(longestWinStreakOf(matches)).toBe(expectedWins);
        expect(longestLossStreakOf(matches)).toBe(expectedLosses);

        const wins = matches.filter((m) => m.win).length;
        const losses = matches.length - wins;
        if (matches.length > 0 && losses === 0) {
          sawAllWins = true;
          expect(expectedWins).toBe(matches.length);
        }
        if (matches.length > 0 && wins === 0) {
          sawAllLosses = true;
          expect(expectedLosses).toBe(matches.length);
        }
        if (matches.length >= 3 && expectedWins === 1 && expectedLosses === 1) {
          sawAlternating = true;
        }
        if (wins === 0) {
          sawAbsentWinStreak = true;
          expect(longestWinStreakOf(matches)).toBe(0);
        }
        if (losses === 0) {
          sawAbsentLossStreak = true;
          expect(longestLossStreakOf(matches)).toBe(0);
        }
        return true;
      }),
      { numRuns: 300 },
    );

    // Non-degenerate coverage of the named shapes and both absent-streak cases.
    expect(sawAllWins).toBe(true);
    expect(sawAllLosses).toBe(true);
    expect(sawAlternating).toBe(true);
    expect(sawAbsentWinStreak).toBe(true);
    expect(sawAbsentLossStreak).toBe(true);
  });
});

// Feature: lolprofiles-gg, Property 14: Fun fact eligibility, category uniqueness, and limited-data exclusion hold together
// **Validates: Requirements 7.4, 7.5, 7.6**
describe('Property 14: fun fact eligibility and category uniqueness', () => {
  it('produces one fact per eligible category, never padding from an excluded one', () => {
    let sawLimited = false;
    let sawNotLimited = false;
    let sawFewerThanThreeEligible = false;
    let sawAtLeastThreeEligible = false;

    fc.assert(
      fc.property(eligibilityMatchesArb, (matches) => {
        const facts = computeFunFacts(matches);
        const categories = facts.map((fact) => fact.category);

        // At most one fact per category (Requirement 7.4).
        expect(new Set(categories).size).toBe(categories.length);

        const eligible = oracleEligibleCategories(matches);
        const limited = matches.length < THRESHOLD;

        // The limited-data predicate tracks the threshold (Requirement 7.5).
        expect(isLimitedData(matches)).toBe(limited);

        if (limited) {
          sawLimited = true;
          // Exactly timeOfDay and streak are excluded, nothing else.
          expect(categories).not.toContain('timeOfDay');
          expect(categories).not.toContain('streak');
        } else {
          sawNotLimited = true;
          expect(categories).toContain('timeOfDay');
          expect(categories).toContain('streak');
        }

        // Displayed set equals the eligible set exactly — no substitution.
        expect([...categories].sort()).toEqual([...eligible].sort());

        if (eligible.length >= 3) {
          sawAtLeastThreeEligible = true;
          // Requirement 7.4: between 3 and 4 statements.
          expect(facts.length).toBeGreaterThanOrEqual(3);
          expect(facts.length).toBeLessThanOrEqual(4);
        } else {
          sawFewerThanThreeEligible = true;
          // Requirement 7.6: only the eligible ones, not padded up to 3.
          expect(facts.length).toBe(eligible.length);
          expect(facts.length).toBeLessThan(3);
        }

        // Every fact carries non-empty text.
        for (const fact of facts) {
          expect(fact.text.trim().length).toBeGreaterThan(0);
        }
        return true;
      }),
      { numRuns: 300 },
    );

    // Both branches of the threshold, and both sides of the 3-fact floor.
    expect(sawLimited).toBe(true);
    expect(sawNotLimited).toBe(true);
    expect(sawFewerThanThreeEligible).toBe(true);
    expect(sawAtLeastThreeEligible).toBe(true);
  });
});
