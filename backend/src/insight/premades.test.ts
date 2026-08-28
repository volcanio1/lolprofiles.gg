import { describe, it, expect } from 'vitest';
import { computePremades } from './premades';
import type { IncludedMatch, MatchParticipant } from './stats';

function participant(over: Partial<MatchParticipant>): MatchParticipant {
  return {
    isAnalyzedPlayer: false,
    isEnemyLaner: false,
    teamId: 100,
    riotIdGameName: 'Friend',
    riotIdTagline: 'EUW',
    championName: 'Ahri',
    champLevel: 11,
    teamPosition: 'MIDDLE',
    summonerSpells: [4, 12],
    runes: { primaryPath: 0, primaryKeystone: 0, primarySlots: [], secondaryPath: 0, secondarySlots: [], shards: [] } as unknown as MatchParticipant['runes'],
    build: {} as MatchParticipant['build'],
    kills: 1,
    deaths: 1,
    assists: 1,
    cs: 100,
    visionScore: 10,
    damageToChampions: 1000,
    goldEarned: 5000,
    win: true,
    turretKills: 0,
    dragonKills: 0,
    baronKills: 0,
    pentaKills: 0,
    killParticipationPercent: 50,
    augments: [],
    ...over,
  };
}

/** A match where `self` (team 100) plays with the given teammates + fills the rest with randoms. */
function match(matchId: string, selfWin: boolean, teammates: { name: string; tag: string }[]): IncludedMatch {
  const self = participant({ isAnalyzedPlayer: true, teamId: 100, riotIdGameName: 'Me', riotIdTagline: 'NA1', win: selfWin });
  const allies = teammates.map((t, i) =>
    participant({ teamId: 100, riotIdGameName: t.name, riotIdTagline: t.tag, win: selfWin, championName: `Ally${i}` }),
  );
  const enemies = Array.from({ length: 5 }, (_, i) =>
    participant({ teamId: 200, riotIdGameName: `Enemy${i}`, riotIdTagline: 'XX', win: !selfWin }),
  );
  return {
    matchId,
    queueType: 'ranked solo/duo',
    startTimestamp: 1_700_000_000_000,
    durationSeconds: 1800,
    championName: 'Me',
    role: 'MIDDLE',
    win: selfWin,
    kills: 5,
    deaths: 5,
    assists: 5,
    visionScore: 20,
    participants: [self, ...allies, ...enemies],
  };
}

describe('computePremades', () => {
  it('returns [] with no matches or no participant lists', () => {
    expect(computePremades([])).toEqual([]);
    const noParts = { ...match('m', true, []), participants: undefined };
    expect(computePremades([noParts])).toEqual([]);
  });

  it('ignores a teammate seen only once (below the 2-game threshold)', () => {
    const matches = [
      match('m1', true, [{ name: 'Duo', tag: 'EUW' }, { name: 'OneOff', tag: 'EUW' }]),
      match('m2', false, [{ name: 'Duo', tag: 'EUW' }]),
    ];
    expect(computePremades(matches).map((p) => p.gameName)).toEqual(['Duo']);
  });

  it('counts shared games and the win rate of those games', () => {
    const matches = [
      match('m1', true, [{ name: 'Duo', tag: 'EUW' }]),
      match('m2', true, [{ name: 'Duo', tag: 'EUW' }]),
      match('m3', false, [{ name: 'Duo', tag: 'EUW' }]),
    ];
    expect(computePremades(matches)).toEqual([
      { gameName: 'Duo', tagLine: 'EUW', gamesPlayed: 3, winRatePercent: 67 },
    ]);
  });

  it('does not count an enemy-team player with the same name', () => {
    const m = match('m1', true, [{ name: 'Duo', tag: 'EUW' }]);
    // Force an enemy participant to share the teammate's Riot ID.
    m.participants![m.participants!.length - 1] = {
      ...m.participants![m.participants!.length - 1],
      riotIdGameName: 'Duo',
      riotIdTagline: 'EUW',
    };
    const matches = [m, match('m2', true, [{ name: 'Duo', tag: 'EUW' }])];
    const result = computePremades(matches);
    expect(result).toEqual([{ gameName: 'Duo', tagLine: 'EUW', gamesPlayed: 2, winRatePercent: 100 }]);
  });

  it('orders by shared games DESC, then win rate DESC, then Riot ID', () => {
    const matches = [
      match('m1', true, [{ name: 'A', tag: 'EUW' }, { name: 'B', tag: 'EUW' }, { name: 'C', tag: 'EUW' }]),
      match('m2', true, [{ name: 'A', tag: 'EUW' }, { name: 'B', tag: 'EUW' }]),
      match('m3', false, [{ name: 'A', tag: 'EUW' }, { name: 'C', tag: 'EUW' }]),
    ];
    // A: 3 games. B: 2 games @ 100%. C: 2 games @ 50%.
    expect(computePremades(matches).map((p) => `${p.gameName}:${p.gamesPlayed}:${p.winRatePercent}`)).toEqual([
      'A:3:67',
      'B:2:100',
      'C:2:50',
    ]);
  });
});
