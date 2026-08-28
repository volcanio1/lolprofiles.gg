import { describe, it, expect } from 'vitest';
import { computeRolePerformance } from './rolePerformance';
import type { IncludedMatch } from './stats';

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

describe('computeRolePerformance', () => {
  it('returns [] for an empty match set', () => {
    expect(computeRolePerformance([])).toEqual([]);
  });

  it('counts games and whole-percent win rate per role', () => {
    const result = computeRolePerformance([
      match({ role: 'MIDDLE', win: true }),
      match({ role: 'MIDDLE', win: false }),
      match({ role: 'MIDDLE', win: true }),
      match({ role: 'JUNGLE', win: true }),
    ]);

    expect(result).toEqual([
      { role: 'MIDDLE', gamesPlayed: 3, winRatePercent: 67 },
      { role: 'JUNGLE', gamesPlayed: 1, winRatePercent: 100 },
    ]);
  });

  it('excludes matches with a blank role (Requirement 8.3) rather than bucketing them', () => {
    const result = computeRolePerformance([
      match({ role: 'BOTTOM' }),
      match({ role: '' }),
      match({ role: '' }),
    ]);

    expect(result).toEqual([{ role: 'BOTTOM', gamesPlayed: 1, winRatePercent: 100 }]);
  });

  it('returns [] when every match has a blank role', () => {
    expect(computeRolePerformance([match({ role: '' }), match({ role: '' })])).toEqual([]);
  });

  it('orders by games DESC, then win rate DESC, then role name ASC', () => {
    const result = computeRolePerformance([
      // TOP: 2 games, 50%
      match({ role: 'TOP', win: true }),
      match({ role: 'TOP', win: false }),
      // SUPPORT: 2 games, 100%
      match({ role: 'SUPPORT', win: true }),
      match({ role: 'SUPPORT', win: true }),
      // JUNGLE: 2 games, 50% — ties TOP on games+wr, loses on name (J < T)
      match({ role: 'JUNGLE', win: true }),
      match({ role: 'JUNGLE', win: false }),
      // MIDDLE: 1 game
      match({ role: 'MIDDLE', win: true }),
    ]);

    expect(result.map((entry) => entry.role)).toEqual(['SUPPORT', 'JUNGLE', 'TOP', 'MIDDLE']);
  });

  it('is order-independent — shuffling the input does not change the result', () => {
    const matches = [
      match({ role: 'TOP', win: true }),
      match({ role: 'JUNGLE', win: false }),
      match({ role: 'TOP', win: false }),
      match({ role: 'MIDDLE', win: true }),
    ];
    const forward = computeRolePerformance(matches);
    const reversed = computeRolePerformance([...matches].reverse());
    expect(reversed).toEqual(forward);
  });
});
