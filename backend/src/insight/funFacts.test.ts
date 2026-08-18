import { describe, it, expect } from 'vitest';
import {
  averageMatchDurationMinutesOf,
  championLoyaltyOf,
  computeFunFacts,
  isLimitedData,
  LIMITED_DATA_MATCH_THRESHOLD,
  longestLossStreakOf,
  longestWinStreakOf,
  rolePreferenceOf,
  timeOfDayCountsOf,
  timeOfDayWindowsOf,
  utcHourOf,
  windowOfMatch,
} from './funFacts';
import type { IncludedMatch } from './stats';

/**
 * Example tests for `computeFunFacts` (Requirements 7.1-7.6).
 *
 * Every timestamp is a literal constant; nothing here reads a clock, matching
 * the module's purity constraint.
 */

/** 2021-01-01T00:00:00.000Z, an exact UTC midnight, used as the window origin. */
const MIDNIGHT_UTC = 1_609_459_200_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

let nextMatchId = 0;

function match(overrides: Partial<IncludedMatch> = {}): IncludedMatch {
  nextMatchId += 1;
  return {
    matchId: `NA1_${nextMatchId}`,
    queueType: 'ranked solo/duo',
    startTimestamp: MIDNIGHT_UTC,
    durationSeconds: 1800,
    championName: 'Ahri',
    role: 'MIDDLE',
    win: true,
    kills: 5,
    deaths: 2,
    assists: 5,
    visionScore: 20,
    ...overrides,
  };
}

/** A match starting at `hour`:`minute` UTC on the reference day. */
function atUtc(hour: number, minute = 0, overrides: Partial<IncludedMatch> = {}): IncludedMatch {
  return match({ startTimestamp: MIDNIGHT_UTC + hour * HOUR + minute * MINUTE, ...overrides });
}

/** A window of `outcomes.length` matches, chronologically increasing. */
function windowOf(outcomes: readonly boolean[]): IncludedMatch[] {
  return outcomes.map((win, index) =>
    match({ startTimestamp: MIDNIGHT_UTC + index * MINUTE, win }),
  );
}

// ---------------------------------------------------------------------------
// Requirement 7.1
// ---------------------------------------------------------------------------

describe('time-of-day windows (Requirement 7.1)', () => {
  it('classifies every window boundary hour in UTC', () => {
    expect(windowOfMatch(atUtc(0, 0))).toBe('Night');
    expect(windowOfMatch(atUtc(5, 59))).toBe('Night');
    expect(windowOfMatch(atUtc(6, 0))).toBe('Morning');
    expect(windowOfMatch(atUtc(11, 59))).toBe('Morning');
    expect(windowOfMatch(atUtc(12, 0))).toBe('Afternoon');
    expect(windowOfMatch(atUtc(17, 59))).toBe('Afternoon');
    expect(windowOfMatch(atUtc(18, 0))).toBe('Evening');
    expect(windowOfMatch(atUtc(23, 59))).toBe('Evening');
  });

  it('derives the UTC hour arithmetically, wrapping negative epochs into 0-23', () => {
    expect(utcHourOf(MIDNIGHT_UTC)).toBe(0);
    expect(utcHourOf(MIDNIGHT_UTC + 13 * HOUR + 42 * MINUTE)).toBe(13);
    // 1 ms before the epoch is 1969-12-31T23:59:59.999Z, i.e. hour 23.
    expect(utcHourOf(-1)).toBe(23);
    expect(utcHourOf(-25 * HOUR)).toBe(23);
    expect(windowOfMatch(match({ startTimestamp: -1 }))).toBe('Evening');
  });

  it('reports only the single strictly most common window', () => {
    const matches = [atUtc(1), atUtc(2), atUtc(8), atUtc(14), atUtc(20)];
    expect(timeOfDayCountsOf(matches)).toEqual({
      Night: 2,
      Morning: 1,
      Afternoon: 1,
      Evening: 1,
    });
    expect(timeOfDayWindowsOf(matches)).toEqual(['Night']);
  });

  it('reports both windows of a two-way tie', () => {
    const matches = [atUtc(1), atUtc(2), atUtc(8), atUtc(9), atUtc(14)];
    expect(timeOfDayWindowsOf(matches)).toEqual(['Night', 'Morning']);
  });

  it('reports all four windows of a four-way tie', () => {
    const matches = [atUtc(3), atUtc(7), atUtc(13), atUtc(21)];
    expect(timeOfDayWindowsOf(matches)).toEqual(['Night', 'Morning', 'Afternoon', 'Evening']);
  });

  it('reports no window for an empty match list', () => {
    expect(timeOfDayWindowsOf([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.2
// ---------------------------------------------------------------------------

describe('streaks (Requirement 7.2)', () => {
  it('counts the whole window for an all-win streak, and 0 for the absent type', () => {
    const matches = windowOf([true, true, true, true, true]);
    expect(longestWinStreakOf(matches)).toBe(5);
    expect(longestLossStreakOf(matches)).toBe(0);
  });

  it('counts the whole window for an all-loss streak, and 0 for the absent type', () => {
    const matches = windowOf([false, false, false, false]);
    expect(longestWinStreakOf(matches)).toBe(0);
    expect(longestLossStreakOf(matches)).toBe(4);
  });

  it('reports 1 and 1 for a fully alternating window', () => {
    const matches = windowOf([true, false, true, false, true]);
    expect(longestWinStreakOf(matches)).toBe(1);
    expect(longestLossStreakOf(matches)).toBe(1);
  });

  it('reports 1 and 0 for a single win', () => {
    const matches = windowOf([true]);
    expect(longestWinStreakOf(matches)).toBe(1);
    expect(longestLossStreakOf(matches)).toBe(0);
  });

  it('reports 0 for both streaks on an empty window', () => {
    expect(longestWinStreakOf([])).toBe(0);
    expect(longestLossStreakOf([])).toBe(0);
  });

  it('orders by start timestamp rather than by array position', () => {
    // Chronologically: L W W W L -> longest win streak 3, longest loss streak 1.
    const chronological = [false, true, true, true, false];
    const shuffled = chronological
      .map((win, index) => match({ startTimestamp: MIDNIGHT_UTC + index * MINUTE, win }))
      .reverse();
    expect(longestWinStreakOf(shuffled)).toBe(3);
    expect(longestLossStreakOf(shuffled)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.3
// ---------------------------------------------------------------------------

describe('average match duration (Requirement 7.3)', () => {
  it('averages durations and expresses the result in minutes', () => {
    const matches = [
      match({ durationSeconds: 1800 }), // 30 min
      match({ durationSeconds: 2400 }), // 40 min
    ];
    expect(averageMatchDurationMinutesOf(matches)).toBe(35);
  });

  it('rounds to 2 decimal places', () => {
    const matches = [match({ durationSeconds: 1000 }), match({ durationSeconds: 1001 })];
    // (1000 + 1001) / 2 / 60 = 16.675 -> 16.68
    expect(averageMatchDurationMinutesOf(matches)).toBe(16.68);
  });

  it('reports 0 minutes for an empty window', () => {
    expect(averageMatchDurationMinutesOf([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Champion loyalty and role preference derivations
// ---------------------------------------------------------------------------

describe('champion loyalty and role preference derivations', () => {
  it('reports the most-played champion and its whole-percent share', () => {
    const matches = [
      match({ championName: 'Ahri' }),
      match({ championName: 'Ahri' }),
      match({ championName: 'Ahri' }),
      match({ championName: 'Bard' }),
    ];
    expect(championLoyaltyOf(matches)).toEqual({
      name: 'Ahri',
      games: 3,
      totalMatches: 4,
      sharePercent: 75,
    });
  });

  it('reports the most-played role and its whole-percent share', () => {
    const matches = [
      match({ role: 'TOP' }),
      match({ role: 'TOP' }),
      match({ role: 'JUNGLE' }),
    ];
    expect(rolePreferenceOf(matches)).toEqual({
      name: 'TOP',
      games: 2,
      totalMatches: 3,
      sharePercent: 67,
    });
  });

  it('reports nothing for an empty window', () => {
    expect(championLoyaltyOf([])).toBeUndefined();
    expect(rolePreferenceOf([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Requirements 7.4, 7.5, 7.6
// ---------------------------------------------------------------------------

describe('fun fact assembly (Requirements 7.4, 7.5, 7.6)', () => {
  it('produces 4 facts, one per category, when all categories are eligible', () => {
    const matches = windowOf([true, true, false, true, false]);
    const facts = computeFunFacts(matches);

    expect(facts).toHaveLength(4);
    expect(facts.map((fact) => fact.category).sort()).toEqual([
      'championLoyalty',
      'rolePreference',
      'streak',
      'timeOfDay',
    ]);
    expect(new Set(facts.map((fact) => fact.category)).size).toBe(facts.length);
    for (const fact of facts) {
      expect(fact.text.length).toBeGreaterThan(0);
    }
    expect(isLimitedData(matches)).toBe(false);
  });

  it('produces exactly 3 facts when one category has no usable data', () => {
    // Role is blank in every match, so the role-preference category is not
    // eligible; the other three still are.
    const matches = windowOf([true, true, false, true, false]).map((m) => ({ ...m, role: '   ' }));
    const facts = computeFunFacts(matches);

    expect(facts).toHaveLength(3);
    expect(facts.map((fact) => fact.category).sort()).toEqual([
      'championLoyalty',
      'streak',
      'timeOfDay',
    ]);
    expect(facts.some((fact) => fact.category === 'rolePreference')).toBe(false);
  });

  it('omits the time-of-day and streak categories below the 5-match threshold', () => {
    const matches = windowOf([true, false, true, false]);
    expect(matches.length).toBeLessThan(LIMITED_DATA_MATCH_THRESHOLD);

    const facts = computeFunFacts(matches);
    expect(isLimitedData(matches)).toBe(true);
    expect(facts.map((fact) => fact.category).sort()).toEqual([
      'championLoyalty',
      'rolePreference',
    ]);
    expect(facts.some((fact) => fact.category === 'timeOfDay')).toBe(false);
    expect(facts.some((fact) => fact.category === 'streak')).toBe(false);
  });

  it('shows only the eligible facts, without padding, when fewer than 3 remain', () => {
    const matches = windowOf([true, false]);
    const facts = computeFunFacts(matches);

    expect(facts).toHaveLength(2);
    expect(facts.length).toBeLessThan(3);
    expect(isLimitedData(matches)).toBe(true);
    // No substitution from an excluded category to reach 3.
    expect(facts.every((fact) => ['rolePreference', 'championLoyalty'].includes(fact.category))).toBe(
      true,
    );
  });

  it('produces no facts and signals limited data for an empty window', () => {
    expect(computeFunFacts([])).toEqual([]);
    expect(isLimitedData([])).toBe(true);
  });

  it('is deterministic: the same window yields identical text', () => {
    const matches = windowOf([true, true, false, true, true]);
    expect(computeFunFacts(matches)).toEqual(computeFunFacts(matches));
  });
});
