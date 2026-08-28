import { describe, expect, it } from 'vitest';

import type { MatchParticipant } from '../api/types';
import { computeMatchRating, ratingTier } from './matchRating';

function p(overrides: Partial<MatchParticipant> = {}): MatchParticipant {
  return {
    isAnalyzedPlayer: false,
    isEnemyLaner: false,
    teamId: 100,
    riotIdGameName: 'P',
    riotIdTagline: 'NA1',
    championName: 'Ahri',
    champLevel: 16,
    teamPosition: 'MIDDLE',
    summonerSpells: [4, 14],
    runes: { primaryStyle: 0, secondaryStyle: 0, primarySelections: [], secondarySelections: [], statShards: [0, 0, 0] },
    build: { items: [0, 0, 0, 0, 0, 0], trinket: 0 },
    kills: 5,
    deaths: 5,
    assists: 5,
    cs: 180,
    visionScore: 20,
    damageToChampions: 18000,
    goldEarned: 11000,
    win: true,
    turretKills: 1,
    dragonKills: 0,
    baronKills: 0,
    pentaKills: 0,
    killParticipationPercent: 55,
    augments: [],
    ...overrides,
  };
}

/** A realistic-looking lobby so team shares are sensible. */
function lobby(hero: MatchParticipant): MatchParticipant[] {
  const filler = (teamId: number, i: number) =>
    p({ teamId, teamPosition: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'][i], damageToChampions: 15000, goldEarned: 11000, killParticipationPercent: 50, turretKills: 1 });
  const blue = [hero, filler(100, 1), filler(100, 2), filler(100, 3), filler(100, 4)];
  const red = [0, 1, 2, 3, 4].map((i) => filler(200, i));
  return [...blue, ...red];
}

const DURATION = 1800; // 30 min

describe('ratingTier', () => {
  it('bands the score: red < 45, grey 45–74, gold >= 75', () => {
    expect(ratingTier(20)).toBe('bad');
    expect(ratingTier(44)).toBe('bad');
    expect(ratingTier(45)).toBe('decent');
    expect(ratingTier(74)).toBe('decent');
    expect(ratingTier(75)).toBe('great');
    expect(ratingTier(100)).toBe('great');
  });
});

describe('computeMatchRating', () => {
  it('rates a strong carry game high and a feeding game low', () => {
    const carry = p({ kills: 14, deaths: 2, assists: 8, cs: 280, damageToChampions: 40000, goldEarned: 18000, killParticipationPercent: 72, turretKills: 3, dragonKills: 1 });
    const feeder = p({ kills: 0, deaths: 12, assists: 1, cs: 90, visionScore: 8, damageToChampions: 5000, goldEarned: 6000, killParticipationPercent: 15, turretKills: 0, win: false });

    const carryRating = computeMatchRating(carry, lobby(carry), DURATION);
    const feederRating = computeMatchRating(feeder, lobby(feeder), DURATION);

    expect(carryRating.score).toBeGreaterThan(feederRating.score + 25);
    expect(carryRating.tier).toBe('great');
    expect(feederRating.tier).toBe('bad');
  });

  it('a loss cannot reach 100; a win adds a small bonus', () => {
    const monster = p({ kills: 20, deaths: 0, assists: 15, cs: 300, visionScore: 40, damageToChampions: 60000, goldEarned: 25000, killParticipationPercent: 95, turretKills: 5, dragonKills: 2, baronKills: 1 });

    const winning = computeMatchRating(p({ ...monster, win: true }), lobby(monster), DURATION);
    const losing = computeMatchRating(p({ ...monster, win: false }), lobby(monster), DURATION);

    expect(winning.score).toBeGreaterThan(losing.score);
    expect(losing.score).toBeLessThan(100);
  });

  it('rewards a support for vision, assists, and kill participation despite low CS and damage', () => {
    const support = p({
      teamPosition: 'UTILITY',
      kills: 1,
      deaths: 4,
      assists: 20,
      cs: 35,
      visionScore: 75,
      damageToChampions: 9000,
      goldEarned: 8500,
      killParticipationPercent: 82,
      turretKills: 0,
      dragonKills: 0,
    });
    const rating = computeMatchRating(support, lobby(support), DURATION);
    expect(rating.tier).not.toBe('bad');
  });

  it('lands a solid, average stat line in the grey band', () => {
    const avg = p({
      kills: 6,
      deaths: 5,
      assists: 9,
      cs: 215, // ~7.2/min
      visionScore: 28,
      damageToChampions: 21000,
      goldEarned: 12500,
      killParticipationPercent: 58,
      turretKills: 2,
      dragonKills: 1,
      win: false,
    });
    // A lobby where the hero sits mid-pack on damage, KDA and gold efficiency.
    const roles = ['TOP', 'JUNGLE', 'BOTTOM', 'UTILITY', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
    const kdaLines: Array<[number, number, number]> = [
      [10, 4, 4], [7, 4, 4], [5, 5, 6], [12, 4, 4], [9, 4, 5], [6, 4, 4], [3, 5, 6], [11, 4, 4], [4, 6, 4],
    ];
    const dmg = [24000, 19000, 16000, 26000, 22000, 18000, 14000, 25000, 17000];
    const others = roles.map((teamPosition, i) =>
      p({
        teamId: i < 4 ? 100 : 200,
        teamPosition,
        kills: kdaLines[i][0],
        deaths: kdaLines[i][1],
        assists: kdaLines[i][2],
        damageToChampions: dmg[i],
        goldEarned: 13000,
        killParticipationPercent: 58,
        turretKills: 2,
      }),
    );
    const rating = computeMatchRating(avg, [avg, ...others], DURATION);
    expect(rating.tier).toBe('decent');
    expect(rating.score).toBeGreaterThanOrEqual(48);
    expect(rating.score).toBeLessThan(75);
  });

  it('does not divide by zero when the team has no damage, gold, or objectives', () => {
    const empty = p({ damageToChampions: 0, goldEarned: 0, turretKills: 0, dragonKills: 0, baronKills: 0 });
    const all = [empty, ...[1, 2, 3, 4].map(() => p({ teamId: 100, damageToChampions: 0, goldEarned: 0, turretKills: 0 })), ...[0, 1, 2, 3, 4].map(() => p({ teamId: 200 }))];
    expect(() => computeMatchRating(empty, all, DURATION)).not.toThrow();
  });
});
