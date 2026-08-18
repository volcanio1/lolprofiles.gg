import { describe, it, expect } from 'vitest';
import {
  computeStats,
  medianOf,
  roleAggregatesOf,
  standingForQueue,
  winRatePercentOf,
  TOP_CHAMPION_LIMIT,
  UNKNOWN_ROLE,
  type IncludedMatch,
  type LeagueEntry,
} from './stats';

/**
 * Example tests for `computeStats` (Requirements 2.8, 6.1-6.7).
 *
 * Timestamps are literal constants; nothing here reads a clock, matching the
 * module's purity constraint.
 */

const BASE_TS = 1_700_000_000_000;

function match(overrides: Partial<IncludedMatch> = {}): IncludedMatch {
  return {
    matchId: 'NA1_1',
    queueType: 'ranked solo/duo',
    startTimestamp: BASE_TS,
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

function entry(overrides: Partial<LeagueEntry> = {}): LeagueEntry {
  return {
    queueType: 'RANKED_SOLO_5x5',
    tier: 'GOLD',
    division: 'II',
    leaguePoints: 42,
    wins: 10,
    losses: 10,
    ...overrides,
  };
}

describe('rankedByQueue (Requirements 2.8, 6.1, 6.2, 6.6)', () => {
  it('reports tier and division for every queue type returned by League-V4', () => {
    const stats = computeStats(
      [],
      [
        entry({ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', wins: 10, losses: 10 }),
        entry({ queueType: 'RANKED_FLEX_SR', tier: 'SILVER', division: 'IV', wins: 3, losses: 1 }),
      ],
      'puuid-1',
    );

    expect(stats.rankedByQueue).toEqual({
      RANKED_SOLO_5x5: { tier: 'GOLD', division: 'II', winRatePercent: 50 },
      RANKED_FLEX_SR: { tier: 'SILVER', division: 'IV', winRatePercent: 75 },
    });
  });

  it('treats a queue type with no entry as Unranked via standingForQueue', () => {
    const stats = computeStats([], [entry({ queueType: 'RANKED_SOLO_5x5' })], 'puuid-1');

    expect(standingForQueue(stats, 'RANKED_SOLO_5x5')).toEqual({
      tier: 'GOLD',
      division: 'II',
      winRatePercent: 50,
    });
    expect(standingForQueue(stats, 'RANKED_FLEX_SR')).toBe('Unranked');
  });

  it('treats zero league entries as a valid unranked state, not a failure (2.8)', () => {
    const stats = computeStats([match()], [], 'puuid-1');

    expect(stats.rankedByQueue).toEqual({});
    expect(standingForQueue(stats, 'RANKED_SOLO_5x5')).toBe('Unranked');
    expect(standingForQueue(stats, 'RANKED_FLEX_SR')).toBe('Unranked');
    // The rest of the report is still produced.
    expect(stats.mostPlayedRole).toBe('MIDDLE');
  });

  it("renders 'N/A' when wins + losses is zero (6.6)", () => {
    const stats = computeStats([], [entry({ wins: 0, losses: 0 })], 'puuid-1');

    expect(stats.rankedByQueue.RANKED_SOLO_5x5).toEqual({
      tier: 'GOLD',
      division: 'II',
      winRatePercent: 'N/A',
    });
  });

  it('rounds win rate to the nearest whole percent, including boundaries (6.2)', () => {
    expect(winRatePercentOf(1, 2)).toBe(33); // 33.33 -> 33
    expect(winRatePercentOf(2, 1)).toBe(67); // 66.67 -> 67
    expect(winRatePercentOf(1, 7)).toBe(13); // 12.5 -> 13 (half-up)
    expect(winRatePercentOf(3, 5)).toBe(38); // 37.5 -> 38 (half-up)
    expect(winRatePercentOf(0, 5)).toBe(0);
    expect(winRatePercentOf(5, 0)).toBe(100);
  });
});

describe('overallAverageKda (Requirements 6.3, 6.7)', () => {
  it('computes (avgKills + avgAssists) / avgDeaths to 2 decimal places', () => {
    const matches = [
      match({ kills: 10, deaths: 2, assists: 4 }),
      match({ kills: 4, deaths: 4, assists: 2 }),
    ];
    // avgKills 7, avgAssists 3, avgDeaths 3 -> 10/3 = 3.333... -> 3.33
    expect(computeStats(matches, [], 'p').overallAverageKda).toBe(3.33);
  });

  it('sums averages without dividing when average deaths is zero (6.7)', () => {
    const matches = [
      match({ kills: 7, deaths: 0, assists: 3 }),
      match({ kills: 3, deaths: 0, assists: 1 }),
    ];
    // avgKills 5, avgAssists 2 -> 7 exactly, no division
    expect(computeStats(matches, [], 'p').overallAverageKda).toBe(7);
  });

  it('reports 0 for an empty match window', () => {
    expect(computeStats([], [], 'p').overallAverageKda).toBe(0);
  });
});

describe('topChampions (Requirement 6.4)', () => {
  it('returns fewer than 5 entries when fewer distinct champions were played', () => {
    const matches = [
      match({ championName: 'Ahri' }),
      match({ championName: 'Ahri' }),
      match({ championName: 'Zed' }),
    ];
    const { topChampions } = computeStats(matches, [], 'p');

    expect(topChampions.map((c) => c.championName)).toEqual(['Ahri', 'Zed']);
    expect(topChampions[0]).toEqual({
      championName: 'Ahri',
      gamesPlayed: 2,
      winRatePercent: 100,
      averageKda: 5,
      averageCs: 0,
      averageCsPerMinute: 0,
    });
  });

  it('returns exactly 5 entries for 5 distinct champions', () => {
    const names = ['Ahri', 'Bard', 'Caitlyn', 'Darius', 'Ezreal'];
    const matches = names.map((championName) => match({ championName }));

    expect(computeStats(matches, [], 'p').topChampions).toHaveLength(5);
  });

  it('truncates to 5 entries, keeping the most-played champions', () => {
    const matches: IncludedMatch[] = [];
    // Games played: Ahri 6, Bard 5, Caitlyn 4, Darius 3, Ezreal 2, Fiora 1.
    const plan: [string, number][] = [
      ['Ahri', 6],
      ['Bard', 5],
      ['Caitlyn', 4],
      ['Darius', 3],
      ['Ezreal', 2],
      ['Fiora', 1],
    ];
    for (const [championName, count] of plan) {
      for (let i = 0; i < count; i += 1) {
        matches.push(match({ championName }));
      }
    }
    const { topChampions } = computeStats(matches, [], 'p');

    expect(topChampions).toHaveLength(TOP_CHAMPION_LIMIT);
    expect(topChampions.map((c) => c.championName)).toEqual([
      'Ahri',
      'Bard',
      'Caitlyn',
      'Darius',
      'Ezreal',
    ]);
  });

  it('orders by games played DESC, then win rate DESC, then name ASC', () => {
    const matches: IncludedMatch[] = [
      // Zed: 2 games, 1 win -> 50%
      match({ championName: 'Zed', win: true }),
      match({ championName: 'Zed', win: false }),
      // Ahri: 2 games, 2 wins -> 100%
      match({ championName: 'Ahri', win: true }),
      match({ championName: 'Ahri', win: true }),
      // Yasuo: 1 game
      match({ championName: 'Yasuo', win: true }),
    ];
    const { topChampions } = computeStats(matches, [], 'p');

    expect(topChampions.map((c) => [c.championName, c.gamesPlayed, c.winRatePercent])).toEqual([
      ['Ahri', 2, 100],
      ['Zed', 2, 50],
      ['Yasuo', 1, 100],
    ]);
  });

  it('breaks a three-way games+winRate tie alphabetically', () => {
    // All three: 2 games, 1 win -> 50%. Inserted in reverse alphabetical order.
    const matches: IncludedMatch[] = ['Caitlyn', 'Bard', 'Ahri'].flatMap((championName) => [
      match({ championName, win: true }),
      match({ championName, win: false }),
    ]);
    const { topChampions } = computeStats(matches, [], 'p');

    expect(topChampions.map((c) => c.championName)).toEqual(['Ahri', 'Bard', 'Caitlyn']);
    expect(topChampions.every((c) => c.gamesPlayed === 2 && c.winRatePercent === 50)).toBe(true);
  });

  it('applies the zero-deaths KDA rule per champion', () => {
    const matches = [match({ championName: 'Ahri', kills: 4, deaths: 0, assists: 6 })];

    expect(computeStats(matches, [], 'p').topChampions[0].averageKda).toBe(10);
  });

  it('averages cs per champion to 2 decimal places', () => {
    const matches = [
      match({ championName: 'Ahri', cs: 180 }),
      match({ championName: 'Ahri', cs: 201 }),
    ];

    expect(computeStats(matches, [], 'p').topChampions[0].averageCs).toBe(190.5);
  });

  it('averages each game’s own cs/min per champion', () => {
    const matches = [
      match({ championName: 'Ahri', cs: 300, durationSeconds: 1800 }), // 10/min
      match({ championName: 'Ahri', cs: 150, durationSeconds: 1800 }), // 5/min
    ];

    expect(computeStats(matches, [], 'p').topChampions[0].averageCsPerMinute).toBe(7.5);
  });

  it('treats a non-positive duration as a 0 cs/min game rather than dividing by zero', () => {
    const matches = [match({ championName: 'Ahri', cs: 180, durationSeconds: 0 })];

    expect(computeStats(matches, [], 'p').topChampions[0].averageCsPerMinute).toBe(0);
  });

  it('treats a missing cs as 0 rather than excluding the match from the average', () => {
    const matches = [match({ championName: 'Ahri', cs: undefined })];

    expect(computeStats(matches, [], 'p').topChampions[0].averageCs).toBe(0);
  });
});

describe('mostPlayedRole (Requirement 6.5)', () => {
  it('picks the role with the strictly highest match count', () => {
    const matches = [
      match({ role: 'MIDDLE' }),
      match({ role: 'MIDDLE' }),
      match({ role: 'TOP' }),
    ];

    expect(computeStats(matches, [], 'p').mostPlayedRole).toBe('MIDDLE');
  });

  it('breaks a count tie by the chronologically most recent match', () => {
    const matches = [
      match({ role: 'TOP', startTimestamp: BASE_TS + 5_000 }),
      match({ role: 'MIDDLE', startTimestamp: BASE_TS + 1_000 }),
    ];

    expect(computeStats(matches, [], 'p').mostPlayedRole).toBe('TOP');

    const reversed = [...matches].reverse();
    expect(computeStats(reversed, [], 'p').mostPlayedRole).toBe('TOP');
  });

  it('breaks an identical-timestamp tie by code-unit-smallest role name', () => {
    const matches = [
      match({ role: 'TOP', startTimestamp: BASE_TS }),
      match({ role: 'MIDDLE', startTimestamp: BASE_TS }),
    ];

    expect(computeStats(matches, [], 'p').mostPlayedRole).toBe('MIDDLE');
    expect(computeStats([...matches].reverse(), [], 'p').mostPlayedRole).toBe('MIDDLE');
  });

  it('reports the Unknown sentinel for an empty match list', () => {
    const stats = computeStats([], [], 'p');

    expect(stats.mostPlayedRole).toBe(UNKNOWN_ROLE);
    expect(stats.topChampions).toEqual([]);
    expect(stats.overallAverageKda).toBe(0);
  });
});

describe('per-role aggregates for the recommendation engine (Requirements 8.2, 8.4)', () => {
  it('averages deaths and takes the median vision score over the role sample', () => {
    const matches = [
      match({ role: 'MIDDLE', deaths: 2, visionScore: 10 }),
      match({ role: 'MIDDLE', deaths: 6, visionScore: 30 }),
      match({ role: 'MIDDLE', deaths: 4, visionScore: 20 }),
      match({ role: 'TOP', deaths: 99, visionScore: 99 }),
    ];
    const aggregates = roleAggregatesOf(matches, 'MIDDLE');

    expect(aggregates).toEqual({
      role: 'MIDDLE',
      gamesPlayed: 3,
      averageDeathsPerMatch: 4,
      medianVisionScore: 20,
      visionScoresAscending: [10, 20, 30],
    });
  });

  it('averages the two middle values for an even-sized sample and zeroes an empty one', () => {
    expect(medianOf([10, 20, 30, 40])).toBe(25);
    expect(roleAggregatesOf([], 'MIDDLE')).toEqual({
      role: 'MIDDLE',
      gamesPlayed: 0,
      averageDeathsPerMatch: 0,
      medianVisionScore: 0,
      visionScoresAscending: [],
    });
  });
});
