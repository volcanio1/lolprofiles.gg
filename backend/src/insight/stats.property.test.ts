import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeStats, type IncludedMatch, type LeagueEntry } from './stats';

/**
 * Property tests for the Insight Engine's stats (Properties 9, 10, 11).
 *
 * Every oracle below is transcribed from the acceptance criteria in
 * requirements.md and written independently of `stats.ts` — nothing but
 * `computeStats` and its types is imported from the module under test, so the
 * helpers here (rounding, ordering, role selection) cannot agree with the
 * implementation by sharing code.
 *
 * All timestamps come from generated data; no test reads a clock.
 */

// --- independent oracles ---------------------------------------------------

/** Nearest whole number, halfway cases toward +Infinity. */
function oracleRoundWhole(value: number): number {
  return Math.round(value);
}

/** Nearest 2 decimal places, same half-up rule scaled by 100. */
function oracleRound2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Requirements 6.2 / 6.6. */
function oracleWinRate(wins: number, losses: number): number | 'N/A' {
  return wins + losses === 0 ? 'N/A' : oracleRoundWhole((100 * wins) / (wins + losses));
}

/** Requirements 6.3 / 6.7. */
function oracleAverageKda(matches: readonly IncludedMatch[]): number {
  if (matches.length === 0) {
    return 0;
  }
  const n = matches.length;
  let sumKills = 0;
  let sumDeaths = 0;
  let sumAssists = 0;
  for (const m of matches) {
    sumKills += m.kills;
    sumDeaths += m.deaths;
    sumAssists += m.assists;
  }
  const avgKills = sumKills / n;
  const avgDeaths = sumDeaths / n;
  const avgAssists = sumAssists / n;
  return avgDeaths === 0
    ? oracleRound2(avgKills + avgAssists)
    : oracleRound2((avgKills + avgAssists) / avgDeaths);
}

/** UTF-16 code-unit comparison, as documented for the alphabetical tiebreak. */
function oracleCompareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- generators ------------------------------------------------------------

// Seven names against windows of up to 12 matches: small enough that games-played
// and win-rate ties are frequent, large enough that >5 distinct champions (and
// therefore truncation) occurs.
const CHAMPION_POOL = ['Ahri', 'Bard', 'Caitlyn', 'Darius', 'Ezreal', 'Fiora', 'Garen'];
const ROLE_POOL = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM'];
const BASE_TS = 1_600_000_000_000;

interface MatchSeed {
  championName: string;
  role: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  visionScore: number;
  timestampOffset: number;
}

/**
 * Small integer stats and a small champion/role pool, so ties at every level of
 * the specified orderings occur often instead of only by accident.
 */
function matchSeedArb(deathsArb: fc.Arbitrary<number>): fc.Arbitrary<MatchSeed> {
  return fc.record({
    championName: fc.constantFrom(...CHAMPION_POOL),
    role: fc.constantFrom(...ROLE_POOL),
    win: fc.boolean(),
    kills: fc.integer({ min: 0, max: 12 }),
    deaths: deathsArb,
    assists: fc.integer({ min: 0, max: 12 }),
    visionScore: fc.integer({ min: 0, max: 60 }),
    // A small offset pool makes identical timestamps (and therefore the
    // documented same-timestamp tiebreak) reachable.
    timestampOffset: fc.integer({ min: 0, max: 6 }),
  });
}

function toMatches(seeds: readonly MatchSeed[]): IncludedMatch[] {
  return seeds.map((seed, index) => ({
    matchId: `NA1_${index}`,
    queueType: 'ranked solo/duo',
    startTimestamp: BASE_TS + seed.timestampOffset * 60_000,
    durationSeconds: 1_800,
    championName: seed.championName,
    role: seed.role,
    win: seed.win,
    kills: seed.kills,
    deaths: seed.deaths,
    assists: seed.assists,
    visionScore: seed.visionScore,
  }));
}

/** Match sets that sometimes have all-zero deaths, exercising Requirement 6.7. */
const matchesArb = fc
  .oneof(
    { arbitrary: fc.array(matchSeedArb(fc.integer({ min: 0, max: 9 })), { maxLength: 12 }), weight: 3 },
    { arbitrary: fc.array(matchSeedArb(fc.constant(0)), { maxLength: 12 }), weight: 1 },
  )
  .map(toMatches);

const winsOrLossesArb = fc.oneof(
  { arbitrary: fc.constant(0), weight: 1 },
  { arbitrary: fc.integer({ min: 0, max: 40 }), weight: 2 },
);

const leagueArb: fc.Arbitrary<LeagueEntry[]> = fc.uniqueArray(
  fc.record({
    queueType: fc.constantFrom('RANKED_SOLO_5x5', 'RANKED_FLEX_SR', 'RANKED_TFT'),
    tier: fc.constantFrom('IRON', 'GOLD', 'CHALLENGER'),
    division: fc.constantFrom('I', 'II', 'III', 'IV'),
    leaguePoints: fc.integer({ min: 0, max: 100 }),
    // Zero is drawn often on purpose, so 0/0 — Requirement 6.6's 'N/A' branch —
    // is reached regularly rather than once in a thousand runs.
    wins: winsOrLossesArb,
    losses: winsOrLossesArb,
  }),
  { selector: (e) => e.queueType, maxLength: 3 },
);

// Feature: lolprofiles-gg, Property 9: Win rate and KDA formulas are computed correctly, including zero-denominator cases
// **Validates: Requirements 6.2, 6.3, 6.6, 6.7**
describe('Property 9: win rate and KDA formulas', () => {
  it('computes per-queue win rate and overall average KDA per the specified formulas', () => {
    let sawZeroDenominatorQueue = false;
    let sawComputedQueue = false;
    let sawZeroAverageDeaths = false;
    let sawPositiveAverageDeaths = false;

    fc.assert(
      fc.property(matchesArb, leagueArb, (matches, league) => {
        const stats = computeStats(matches, league, 'puuid-under-test');

        // Requirements 6.2 / 6.6, per queue type with a ranked entry.
        for (const entry of league) {
          const standing = stats.rankedByQueue[entry.queueType];
          expect(standing).not.toBe('Unranked');
          if (standing === 'Unranked' || standing === undefined) {
            return false;
          }
          const expected = oracleWinRate(entry.wins, entry.losses);
          expect(standing.winRatePercent).toBe(expected);
          if (expected === 'N/A') {
            sawZeroDenominatorQueue = true;
          } else {
            sawComputedQueue = true;
          }
        }

        // Requirements 6.3 / 6.7, over the whole window.
        const totalDeaths = matches.reduce((sum, m) => sum + m.deaths, 0);
        if (matches.length > 0) {
          if (totalDeaths === 0) {
            sawZeroAverageDeaths = true;
          } else {
            sawPositiveAverageDeaths = true;
          }
        }
        expect(stats.overallAverageKda).toBe(oracleAverageKda(matches));

        // Each champion summary obeys the same two formulas over its own subset.
        for (const summary of stats.topChampions) {
          const own = matches.filter((m) => m.championName === summary.championName);
          const wins = own.filter((m) => m.win).length;
          expect(summary.gamesPlayed).toBe(own.length);
          expect(summary.winRatePercent).toBe(oracleRoundWhole((100 * wins) / own.length));
          expect(summary.averageKda).toBe(oracleAverageKda(own));
        }

        return true;
      }),
      { numRuns: 200 },
    );

    // Non-degenerate coverage of both zero-denominator branches.
    expect(sawZeroDenominatorQueue).toBe(true);
    expect(sawComputedQueue).toBe(true);
    expect(sawZeroAverageDeaths).toBe(true);
    expect(sawPositiveAverageDeaths).toBe(true);
  });
});

// Feature: lolprofiles-gg, Property 10: Top-champion ranking follows the specified total order
// **Validates: Requirements 6.4**
describe('Property 10: top-champion ranking', () => {
  it('is capped at 5, complete when fewer distinct champions exist, and totally ordered', () => {
    let sawGamesTie = false;
    let sawGamesAndWinRateTie = false;
    let sawTruncation = false;

    fc.assert(
      fc.property(matchesArb, (matches) => {
        const { topChampions } = computeStats(matches, [], 'puuid-under-test');

        // At most 5 entries.
        expect(topChampions.length).toBeLessThanOrEqual(5);

        const distinct = [...new Set(matches.map((m) => m.championName))];
        if (distinct.length < 5) {
          // Contains every distinct champion played.
          expect([...topChampions.map((c) => c.championName)].sort(oracleCompareNames)).toEqual(
            [...distinct].sort(oracleCompareNames),
          );
        } else {
          expect(topChampions).toHaveLength(5);
          if (distinct.length > 5) {
            sawTruncation = true;
          }
        }

        // No duplicate champions, which is what makes the name tiebreak total.
        expect(new Set(topChampions.map((c) => c.championName)).size).toBe(topChampions.length);

        // Sorted by games DESC, win rate DESC, name ASC; and the order is total,
        // i.e. no adjacent pair ever compares as "should swap" and no adjacent
        // pair is indistinguishable under all three keys.
        for (let i = 1; i < topChampions.length; i += 1) {
          const prev = topChampions[i - 1];
          const next = topChampions[i];
          if (prev.gamesPlayed !== next.gamesPlayed) {
            expect(prev.gamesPlayed).toBeGreaterThan(next.gamesPlayed);
            continue;
          }
          sawGamesTie = true;
          if (prev.winRatePercent !== next.winRatePercent) {
            expect(prev.winRatePercent).toBeGreaterThan(next.winRatePercent);
            continue;
          }
          sawGamesAndWinRateTie = true;
          expect(oracleCompareNames(prev.championName, next.championName)).toBe(-1);
        }

        // Truncation keeps only champions that outrank every excluded one.
        const excluded = distinct.filter(
          (name) => !topChampions.some((c) => c.championName === name),
        );
        for (const name of excluded) {
          const gamesExcluded = matches.filter((m) => m.championName === name).length;
          const lastKept = topChampions[topChampions.length - 1];
          expect(lastKept.gamesPlayed).toBeGreaterThanOrEqual(gamesExcluded);
        }

        return true;
      }),
      { numRuns: 300 },
    );

    // Ties at each level, and truncation, are all actually exercised.
    expect(sawGamesTie).toBe(true);
    expect(sawGamesAndWinRateTie).toBe(true);
    expect(sawTruncation).toBe(true);
  });
});

// Feature: lolprofiles-gg, Property 11: Most-played role tie-break uses chronological recency
// **Validates: Requirements 6.5**
describe('Property 11: most-played role tie-break', () => {
  it('is the strict max-count role, or the chronologically latest among tied roles', () => {
    let sawUniqueMax = false;
    let sawCountTie = false;

    fc.assert(
      fc.property(matchesArb, (matches) => {
        const { mostPlayedRole } = computeStats(matches, [], 'puuid-under-test');

        if (matches.length === 0) {
          expect(mostPlayedRole).toBe('Unknown');
          return true;
        }

        // Oracle: count per role and latest timestamp per role, transcribed
        // straight from Requirement 6.5 plus the documented same-timestamp rule.
        const roles = [...new Set(matches.map((m) => m.role))];
        const countOf = (role: string): number => matches.filter((m) => m.role === role).length;
        const latestOf = (role: string): number =>
          Math.max(...matches.filter((m) => m.role === role).map((m) => m.startTimestamp));

        const maxCount = Math.max(...roles.map(countOf));
        const tied = roles.filter((role) => countOf(role) === maxCount);

        if (tied.length === 1) {
          sawUniqueMax = true;
          expect(mostPlayedRole).toBe(tied[0]);
          return true;
        }

        sawCountTie = true;
        const latestAmongTied = Math.max(...tied.map(latestOf));
        const candidates = tied
          .filter((role) => latestOf(role) === latestAmongTied)
          .sort(oracleCompareNames);
        expect(mostPlayedRole).toBe(candidates[0]);
        return true;
      }),
      { numRuns: 300 },
    );

    // Both branches exercised.
    expect(sawUniqueMax).toBe(true);
    expect(sawCountTie).toBe(true);
  });
});
