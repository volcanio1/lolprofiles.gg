import { describe, expect, it } from 'vitest';
import { rankLabel, rankOrdinal } from './rankHistory';

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
