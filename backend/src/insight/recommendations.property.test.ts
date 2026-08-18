import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeRecommendations, MAX_RECOMMENDATIONS } from './recommendations';
import { computeStats, type IncludedMatch } from './stats';

/**
 * Property test for the Insight Engine's improvement recommendations
 * (Property 15).
 *
 * Every oracle below is transcribed from the acceptance criteria in
 * requirements.md and written independently of `recommendations.ts` — only the
 * functions under test (`computeRecommendations`, and `computeStats` to build its
 * declared second argument) are imported, so the oracles here (average deaths,
 * role-scoped average and median, Requirement 6.4's champion ordering, rounding)
 * cannot agree with the implementation by sharing code.
 *
 * Deterministic: all data is generated, no clock is read and no I/O is performed.
 */

const CATEGORIES = ['survivability', 'championSelection', 'visionControl'] as const;
type Category = (typeof CATEGORIES)[number];

const ROLES = ['MIDDLE', 'TOP', 'JUNGLE'] as const;
const CHAMPIONS = ['Ahri', 'Zed', 'Yasuo'] as const;
/** 2021-01-01T00:00:00.000Z. */
const BASE_TIMESTAMP = 1_609_459_200_000;
const GAP_THRESHOLD = 10;

// --- independent oracles ---------------------------------------------------

function oracleRound2(value: number): number {
  return Math.round(value * 100) / 100;
}

function oracleMean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function oracleMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Requirement 6.5: role with the most matches; count ties broken by the latest
 * start timestamp among the tied roles, then by smallest role name. `undefined`
 * for an empty window (no role exists to be most-played).
 */
function oracleMostPlayedRole(matches: readonly IncludedMatch[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const roles = [...new Set(matches.map((m) => m.role))];
  const scored = roles.map((role) => {
    const own = matches.filter((m) => m.role === role);
    return {
      role,
      count: own.length,
      latest: Math.max(...own.map((m) => m.startTimestamp)),
    };
  });
  scored.sort((a, b) => {
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    if (a.latest !== b.latest) {
      return b.latest - a.latest;
    }
    return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
  });
  return scored[0].role;
}

/**
 * Requirement 8.2: survivability fires iff the window's average deaths per match
 * exceeds the average over the player's own matches in the most-played role.
 * An empty role sample means there is no baseline, so no trigger.
 */
function oracleSurvivability(matches: readonly IncludedMatch[]): boolean {
  const role = oracleMostPlayedRole(matches);
  if (role === undefined) {
    return false;
  }
  const inRole = matches.filter((m) => m.role === role);
  if (inRole.length === 0) {
    return false;
  }
  return oracleMean(matches.map((m) => m.deaths)) > oracleMean(inRole.map((m) => m.deaths));
}

/**
 * Requirement 6.4's total order: games DESC, whole-percent win rate DESC, then
 * champion name ASC. Returns the ordered per-champion summaries.
 */
function oracleChampionOrder(
  matches: readonly IncludedMatch[],
): { name: string; games: number; winRate: number }[] {
  const names = [...new Set(matches.map((m) => m.championName))];
  const summaries = names.map((name) => {
    const own = matches.filter((m) => m.championName === name);
    const wins = own.filter((m) => m.win).length;
    return { name, games: own.length, winRate: Math.round((100 * wins) / own.length) };
  });
  summaries.sort((a, b) => {
    if (a.games !== b.games) {
      return b.games - a.games;
    }
    if (a.winRate !== b.winRate) {
      return b.winRate - a.winRate;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return summaries;
}

/**
 * Requirement 8.3: at least 2 distinct champions AND the most-played champion's
 * win rate is more than 10 percentage points below the second-most-played
 * champion's.
 */
function oracleChampionSelection(matches: readonly IncludedMatch[]): boolean {
  const ordered = oracleChampionOrder(matches);
  if (ordered.length < 2) {
    return false;
  }
  return ordered[1].winRate - ordered[0].winRate > GAP_THRESHOLD;
}

/** The champion win-rate gap, or `undefined` with fewer than 2 champions. */
function oracleChampionGap(matches: readonly IncludedMatch[]): number | undefined {
  const ordered = oracleChampionOrder(matches);
  return ordered.length < 2 ? undefined : ordered[1].winRate - ordered[0].winRate;
}

/**
 * Requirement 8.4: vision control fires iff the window's average vision score is
 * below the median vision score of the player's own matches in the most-played
 * role. An empty role sample means there is no baseline, so no trigger.
 */
function oracleVisionControl(matches: readonly IncludedMatch[]): boolean {
  const role = oracleMostPlayedRole(matches);
  if (role === undefined) {
    return false;
  }
  const inRole = matches.filter((m) => m.role === role);
  if (inRole.length === 0) {
    return false;
  }
  return (
    oracleMean(matches.map((m) => m.visionScore)) < oracleMedian(inRole.map((m) => m.visionScore))
  );
}

/** Requirement 8.5: the player's own computed value behind each trigger. */
function oracleMetricValue(matches: readonly IncludedMatch[], category: Category): number {
  if (category === 'survivability') {
    return oracleRound2(oracleMean(matches.map((m) => m.deaths)));
  }
  if (category === 'visionControl') {
    return oracleRound2(oracleMean(matches.map((m) => m.visionScore)));
  }
  return oracleChampionOrder(matches)[0].winRate;
}

// --- generators ------------------------------------------------------------

interface MatchSeed {
  role: string;
  championName: string;
  win: boolean;
  deaths: number;
  visionScore: number;
  hourOffset: number;
}

function matchesOf(seeds: readonly MatchSeed[]): IncludedMatch[] {
  return seeds.map((seed, index) => ({
    matchId: `M${index}`,
    queueType: 'ranked solo/duo',
    startTimestamp: BASE_TIMESTAMP + seed.hourOffset * 3_600_000,
    durationSeconds: 1800,
    championName: seed.championName,
    role: seed.role,
    win: seed.win,
    kills: 5,
    deaths: seed.deaths,
    assists: 5,
    visionScore: seed.visionScore,
  }));
}

/**
 * Free-form windows over small value domains, so exact equality of averages and
 * medians (the boundary of Requirements 8.2 and 8.4) occurs often rather than
 * almost never. Includes single-role and multi-role windows, and 0/1/2+ distinct
 * champions, since the empty window and single-champion windows are reachable.
 */
const arbSeed: fc.Arbitrary<MatchSeed> = fc.record({
  role: fc.constantFrom(...ROLES),
  championName: fc.constantFrom(...CHAMPIONS),
  win: fc.boolean(),
  deaths: fc.integer({ min: 0, max: 4 }),
  visionScore: fc.constantFrom(0, 10, 20, 30, 40),
  hourOffset: fc.integer({ min: 0, max: 48 }),
});

const arbFreeWindow = fc.array(arbSeed, { minLength: 0, maxLength: 12 }).map(matchesOf);

/** Single-role windows, which can never trigger survivability (decision 3). */
const arbSingleRoleWindow = fc
  .array(arbSeed, { minLength: 1, maxLength: 10 })
  .map((seeds) => matchesOf(seeds.map((seed) => ({ ...seed, role: 'MIDDLE' }))));

/**
 * Two-champion windows parameterised by games/wins per champion, so the
 * Requirement 8.3 gap sweeps a wide range of values — including gaps at and just
 * either side of the 10-point threshold.
 */
const arbChampionPairWindow = fc
  .tuple(
    fc.integer({ min: 1, max: 6 }),
    fc.integer({ min: 1, max: 6 }),
    fc.integer({ min: 0, max: 6 }),
    fc.integer({ min: 0, max: 6 }),
  )
  .map(([gamesA, gamesB, winsARaw, winsBRaw]) => {
    const winsA = Math.min(winsARaw, gamesA);
    const winsB = Math.min(winsBRaw, gamesB);
    const seeds: MatchSeed[] = [];
    for (let i = 0; i < gamesA; i += 1) {
      seeds.push({
        role: 'MIDDLE',
        championName: 'Ahri',
        win: i < winsA,
        deaths: 2,
        visionScore: 20,
        hourOffset: i,
      });
    }
    for (let i = 0; i < gamesB; i += 1) {
      seeds.push({
        role: 'MIDDLE',
        championName: 'Zed',
        win: i < winsB,
        deaths: 2,
        visionScore: 20,
        hourOffset: 10 + i,
      });
    }
    return matchesOf(seeds);
  });

/**
 * Hand-built windows pinning the three boundaries that random generation reaches
 * only occasionally: a champion gap of exactly 10 points, an exact equality of
 * overall and role-baseline average deaths across two roles, and an exact
 * equality of overall average vision score with the role median.
 */
const BOUNDARY_WINDOWS: IncludedMatch[][] = [
  // Zed 10 games at 50%, Ahri 5 games at 60% -> gap exactly 10, must NOT fire.
  matchesOf([
    ...Array.from({ length: 10 }, (_, i) => ({
      role: 'MIDDLE',
      championName: 'Zed',
      win: i < 5,
      deaths: 2,
      visionScore: 20,
      hourOffset: i,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      role: 'MIDDLE',
      championName: 'Ahri',
      win: i < 3,
      deaths: 2,
      visionScore: 20,
      hourOffset: 20 + i,
    })),
  ]),
  // Zed 10 games at 40%, Ahri 5 games at 60% -> gap 20, must fire.
  matchesOf([
    ...Array.from({ length: 10 }, (_, i) => ({
      role: 'MIDDLE',
      championName: 'Zed',
      win: i < 4,
      deaths: 2,
      visionScore: 20,
      hourOffset: i,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      role: 'MIDDLE',
      championName: 'Ahri',
      win: i < 3,
      deaths: 2,
      visionScore: 20,
      hourOffset: 20 + i,
    })),
  ]),
  // Overall average deaths exactly equals the MIDDLE baseline (4.0) -> no trigger.
  matchesOf([
    { role: 'MIDDLE', championName: 'Ahri', win: true, deaths: 3, visionScore: 20, hourOffset: 1 },
    { role: 'MIDDLE', championName: 'Ahri', win: true, deaths: 4, visionScore: 20, hourOffset: 2 },
    { role: 'MIDDLE', championName: 'Ahri', win: true, deaths: 5, visionScore: 20, hourOffset: 3 },
    { role: 'TOP', championName: 'Zed', win: true, deaths: 4, visionScore: 20, hourOffset: 4 },
    { role: 'TOP', championName: 'Zed', win: true, deaths: 4, visionScore: 20, hourOffset: 5 },
  ]),
  // Overall average vision score exactly equals the MIDDLE median (30) -> no trigger.
  matchesOf([
    { role: 'MIDDLE', championName: 'Ahri', win: true, deaths: 2, visionScore: 20, hourOffset: 1 },
    { role: 'MIDDLE', championName: 'Ahri', win: true, deaths: 2, visionScore: 30, hourOffset: 2 },
    { role: 'MIDDLE', championName: 'Ahri', win: true, deaths: 2, visionScore: 40, hourOffset: 3 },
    { role: 'TOP', championName: 'Zed', win: true, deaths: 2, visionScore: 30, hourOffset: 4 },
    { role: 'TOP', championName: 'Zed', win: true, deaths: 2, visionScore: 30, hourOffset: 5 },
  ]),
  // All three triggers fire together.
  matchesOf([
    { role: 'MIDDLE', championName: 'Ahri', win: true, deaths: 1, visionScore: 30, hourOffset: 1 },
    { role: 'MIDDLE', championName: 'Ahri', win: false, deaths: 1, visionScore: 40, hourOffset: 2 },
    { role: 'MIDDLE', championName: 'Ahri', win: false, deaths: 1, visionScore: 50, hourOffset: 3 },
    { role: 'TOP', championName: 'Zed', win: true, deaths: 6, visionScore: 0, hourOffset: 4 },
    { role: 'TOP', championName: 'Zed', win: false, deaths: 6, visionScore: 0, hourOffset: 5 },
  ]),
  // Empty window.
  [],
];

const arbWindow = fc.oneof(
  arbFreeWindow,
  arbSingleRoleWindow,
  arbChampionPairWindow,
  fc.constantFrom(...BOUNDARY_WINDOWS),
);

// --- the property ----------------------------------------------------------

describe('Insight Engine recommendations — Property 15', () => {
  // Feature: lolprofiles-gg, Property 15: Improvement recommendation triggers match their defined conditions exactly
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**
  it('produces exactly the recommendations whose defined trigger conditions hold', () => {
    const observed = {
      survivabilityFired: 0,
      survivabilityNotFired: 0,
      championFired: 0,
      championNotFired: 0,
      visionFired: 0,
      visionNotFired: 0,
      zeroRecommendations: 0,
      gapExactlyTen: 0,
      singleRoleWindows: 0,
      emptyWindows: 0,
    };

    fc.assert(
      fc.property(arbWindow, (matches) => {
        const recommendations = computeRecommendations(matches, computeStats(matches, [], 'puuid'));
        const present = new Set(recommendations.map((r) => r.category));

        const expectSurvivability = oracleSurvivability(matches);
        const expectChampion = oracleChampionSelection(matches);
        const expectVision = oracleVisionControl(matches);

        // (a) survivability iff overall avg deaths > most-played-role avg deaths
        expect(present.has('survivability')).toBe(expectSurvivability);
        // (b) championSelection iff >=2 champions and a >10 point win-rate deficit
        expect(present.has('championSelection')).toBe(expectChampion);
        // (c) visionControl iff overall avg vision < most-played-role median vision
        expect(present.has('visionControl')).toBe(expectVision);

        // (d) amended Requirement 8.1: between 0 and 5 recommendations inclusive
        expect(recommendations.length).toBeGreaterThanOrEqual(0);
        expect(recommendations.length).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);

        // (f) at most one recommendation per category
        expect(present.size).toBe(recommendations.length);

        // (e) every recommendation carries a valid category, non-empty text, a
        //     non-empty metric name and the finite computed value that triggered it
        for (const recommendation of recommendations) {
          expect(CATEGORIES).toContain(recommendation.category);
          expect(recommendation.text.length).toBeGreaterThan(0);
          expect(recommendation.metricName.length).toBeGreaterThan(0);
          expect(Number.isFinite(recommendation.metricValue)).toBe(true);
          expect(recommendation.metricValue).toBe(
            oracleMetricValue(matches, recommendation.category),
          );
        }

        // coverage bookkeeping
        observed[expectSurvivability ? 'survivabilityFired' : 'survivabilityNotFired'] += 1;
        observed[expectChampion ? 'championFired' : 'championNotFired'] += 1;
        observed[expectVision ? 'visionFired' : 'visionNotFired'] += 1;
        if (recommendations.length === 0) {
          observed.zeroRecommendations += 1;
        }
        if (oracleChampionGap(matches) === GAP_THRESHOLD) {
          observed.gapExactlyTen += 1;
        }
        if (matches.length > 0 && new Set(matches.map((m) => m.role)).size === 1) {
          observed.singleRoleWindows += 1;
        }
        if (matches.length === 0) {
          observed.emptyWindows += 1;
        }
      }),
      { numRuns: 400 },
    );

    // Non-degenerate coverage: every trigger is seen both firing and not firing,
    // the zero-recommendation outcome is reached, the exactly-10-point boundary of
    // Requirement 8.3 is exercised, and both single-role and empty windows occur.
    for (const [key, count] of Object.entries(observed)) {
      expect(count, `expected at least one case for ${key}`).toBeGreaterThan(0);
    }
  });
});
