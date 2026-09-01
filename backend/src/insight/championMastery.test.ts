import { describe, expect, it } from 'vitest';
import { CHAMPION_MASTERY_TOP_COUNT, computeChampionMastery, type ChampionMasteryPoints } from './championMastery';
import type { IncludedMatch, ItemBuild, LanelessMatch } from './stats';

const EMPTY_BUILD: ItemBuild = { items: [0, 0, 0, 0, 0, 0], trinket: 0 };

function match(over: Partial<IncludedMatch> = {}): IncludedMatch {
  return {
    matchId: 'NA1_1',
    queueType: 'ranked solo/duo',
    startTimestamp: 1_700_000_000_000,
    durationSeconds: 1_800,
    championName: 'Ahri',
    championId: 103,
    role: 'MIDDLE',
    win: true,
    kills: 5,
    deaths: 2,
    assists: 8,
    visionScore: 20,
    cs: 180,
    ...over,
  };
}

function lanelessMatch(over: Partial<LanelessMatch> = {}): LanelessMatch {
  return {
    matchId: 'NA1_ARAM_1',
    queueType: 'aram',
    startTimestamp: 1_700_000_000_000,
    durationSeconds: 1_800,
    championName: 'Ahri',
    championId: 103,
    win: true,
    kills: 5,
    deaths: 2,
    assists: 8,
    visionScore: 20,
    cs: 180,
    build: EMPTY_BUILD,
    participants: [],
    ...over,
  };
}

function points(over: Partial<ChampionMasteryPoints> = {}): ChampionMasteryPoints {
  return { championId: 103, championLevel: 7, championPoints: 250_000, ...over };
}

describe('computeChampionMastery', () => {
  it('joins mastery points to match history by championId, computing games/winrate/KDA', () => {
    const matches = [
      match({ win: true, kills: 6, deaths: 2, assists: 10 }), // KDA 8
      match({ win: false, kills: 4, deaths: 2, assists: 6 }), // KDA 5
    ];
    const result = computeChampionMastery(matches, [points()]);
    expect(result).toEqual([
      {
        championId: 103,
        championLevel: 7,
        championPoints: 250_000,
        gamesPlayed: 2,
        winRatePercent: 50,
        averageKda: 6.5, // avgKills=5, avgDeaths=2, avgAssists=8 -> (5+8)/2
      },
    ]);
  });

  it('reports null winRatePercent/averageKda, not 0, when the champion has zero matches in the window (decision 2)', () => {
    const result = computeChampionMastery([match({ championId: 999 })], [points({ championId: 103 })]);
    expect(result).toEqual([
      { championId: 103, championLevel: 7, championPoints: 250_000, gamesPlayed: 0, winRatePercent: null, averageKda: null },
    ]);
  });

  it('a match with no championId never joins any entry (decision 3)', () => {
    const result = computeChampionMastery([match({ championId: undefined })], [points()]);
    expect(result[0]?.gamesPlayed).toBe(0);
  });

  it('folds in lanelessMatches (ARAM) alongside Summoner\'s Rift matches', () => {
    const result = computeChampionMastery(
      [match({ win: true })],
      [points()],
      [lanelessMatch({ win: false })],
    );
    expect(result[0]?.gamesPlayed).toBe(2);
    expect(result[0]?.winRatePercent).toBe(50);
  });

  it('caps output at CHAMPION_MASTERY_TOP_COUNT even if given more', () => {
    const many = Array.from({ length: CHAMPION_MASTERY_TOP_COUNT + 3 }, (_, i) =>
      points({ championId: i, championPoints: 100_000 - i }),
    );
    expect(computeChampionMastery([], many)).toHaveLength(CHAMPION_MASTERY_TOP_COUNT);
  });

  it('preserves the caller-supplied order (assumed already sorted by championPoints desc)', () => {
    const input = [points({ championId: 1 }), points({ championId: 2 }), points({ championId: 3 })];
    expect(computeChampionMastery([], input).map((e) => e.championId)).toEqual([1, 2, 3]);
  });

  it('returns an empty array for an empty masteryPoints input', () => {
    expect(computeChampionMastery([match()], [])).toEqual([]);
  });
});
