import { describe, expect, it } from 'vitest';
import { gamesSincePreviousSnapshot, rankColor, rankLabel, rankOrdinal } from './rankHistory';

const snap = (tier: string, division: string, leaguePoints: number) => ({ tier, division, leaguePoints });

describe('rankOrdinal', () => {
  it('increases monotonically up the ladder, including across promotions', () => {
    // Master / Grandmaster / Challenger share one continuous LP scale (the apex
    // pool), so the ladder stays monotonic only when their LP also climbs.
    const ladder = [
      snap('IRON', 'IV', 0),
      snap('IRON', 'I', 90),
      snap('BRONZE', 'IV', 10),
      snap('GOLD', 'II', 47),
      snap('GOLD', 'I', 99),
      snap('PLATINUM', 'IV', 5),
      snap('MASTER', '', 20),
      snap('GRANDMASTER', '', 400),
      snap('CHALLENGER', '', 1100),
    ];
    const ordinals = ladder.map(rankOrdinal);
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(ordinals[i]).toBeGreaterThan(ordinals[i - 1]);
    }
  });

  it('is case-insensitive on tier and division', () => {
    expect(rankOrdinal(snap('gold', 'ii', 20))).toBe(rankOrdinal(snap('GOLD', 'II', 20)));
  });

  it('clamps sub-Master LP into 0..100 but leaves apex LP unbounded', () => {
    expect(rankOrdinal(snap('GOLD', 'II', 250))).toBe(rankOrdinal(snap('GOLD', 'II', 100)));
    expect(rankOrdinal(snap('MASTER', '', 2000))).toBeGreaterThan(rankOrdinal(snap('MASTER', '', 100)));
  });

  it('treats an unknown tier as the floor rather than throwing', () => {
    expect(rankOrdinal(snap('WOOD', 'IV', 0))).toBe(rankOrdinal(snap('IRON', 'IV', 0)));
  });
});

describe('rankLabel', () => {
  it('shows tier + division + LP below Master', () => {
    expect(rankLabel(snap('GOLD', 'II', 47))).toBe('Gold II 47 LP');
  });

  it('drops the division at Master and above', () => {
    expect(rankLabel(snap('MASTER', 'I', 1182))).toBe('Master 1182 LP');
  });
});

describe('rankColor', () => {
  it('gives every tier a distinct color', () => {
    const tiers = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
    const colors = tiers.map(rankColor);
    expect(new Set(colors).size).toBe(tiers.length);
  });

  it('is case-insensitive', () => {
    expect(rankColor('gold')).toBe(rankColor('GOLD'));
  });

  it('falls back to the neutral --dim token for an unknown tier', () => {
    expect(rankColor('WOOD')).toBe('var(--dim)');
  });
});

describe('gamesSincePreviousSnapshot', () => {
  const match = (queueType: string, startTimestamp: number) => ({ queueType, startTimestamp });

  it('is undefined when there is no previous snapshot', () => {
    expect(gamesSincePreviousSnapshot([match('ranked solo/duo', 100)], undefined, 200)).toBeUndefined();
  });

  it('counts only ranked solo/duo matches strictly after the previous and at or before the current observedAt', () => {
    const matches = [
      match('ranked solo/duo', 50), // before the window
      match('ranked solo/duo', 100), // exactly at previous — excluded (strictly after)
      match('ranked solo/duo', 150), // inside
      match('ranked solo/duo', 200), // exactly at current — included (at or before)
      match('ranked solo/duo', 250), // after the window
      match('ranked flex', 150), // wrong queue
      match('normal', 150), // wrong queue
    ];
    expect(gamesSincePreviousSnapshot(matches, 100, 200)).toBe(2);
  });

  it('is 0 when nothing falls in the window', () => {
    expect(gamesSincePreviousSnapshot([match('ranked solo/duo', 500)], 100, 200)).toBe(0);
  });
});
