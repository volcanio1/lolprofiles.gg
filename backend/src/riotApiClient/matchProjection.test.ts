import { describe, it, expect } from 'vitest';
import { projectMatchDto } from './matchProjection';
import { toIncludedMatch, toLanelessMatch } from '../orchestrator/mapping';
import { computeRecentMatches } from '../insight/recentMatches';

/**
 * specs/match-cache/ task 1.4. The projection must retain every field the
 * `MatchDto` / `MatchParticipantDto` interfaces declare and drop the rest, and
 * every downstream consumer must produce identical output across it.
 */

const PUUID_A = 'puuid-analyzed';
const PUUID_B = 'puuid-opponent';

/** A participant carrying every DECLARED field plus a pile of fields the code never reads. */
function rawParticipant(puuid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // declared
    puuid,
    championName: 'Ahri',
    teamPosition: 'MIDDLE',
    role: 'SOLO',
    teamId: puuid === PUUID_A ? 100 : 200,
    win: puuid === PUUID_A,
    kills: 8,
    deaths: 3,
    assists: 11,
    visionScore: 24,
    totalMinionsKilled: 190,
    neutralMinionsKilled: 12,
    item0: 3157,
    item1: 3020,
    item2: 4645,
    item3: 3135,
    item4: 3089,
    item5: 0,
    item6: 3363,
    summoner1Id: 4,
    summoner2Id: 12,
    perks: {
      statPerks: { offense: 5008, flex: 5008, defense: 5001 },
      styles: [
        { description: 'primaryStyle', style: 8100, selections: [{ perk: 8112 }, { perk: 8143 }] },
        { description: 'subStyle', style: 8200, selections: [{ perk: 8226 }] },
      ],
    },
    champLevel: 16,
    goldEarned: 13400,
    totalDamageDealtToChampions: 28900,
    turretKills: 2,
    dragonKills: 0,
    baronKills: 0,
    pentaKills: 0,
    riotIdGameName: 'Someone',
    riotIdTagline: 'NA1',
    playerAugment1: 0,
    playerAugment2: 0,
    playerAugment3: 0,
    playerAugment4: 0,
    playerAugment5: 0,
    playerAugment6: 0,
    // NOT declared — must be dropped
    challenges: { kda: 6.33, damagePerMinute: 1400.2, laneMinionsFirst10Minutes: 74, teamDamagePercentage: 0.31 },
    missions: { playerScore0: 12, playerScore1: 0 },
    spell1Casts: 142,
    spell2Casts: 61,
    totalDamageTaken: 21044,
    totalHeal: 3100,
    damageDealtToBuildings: 4210,
    timePlayed: 1812,
    summonerName: 'deprecated',
    basicPings: 3,
    ...overrides,
  };
}

function rawMatch(queueId: number, participants: Record<string, unknown>[]): Record<string, unknown> {
  return {
    metadata: {
      dataVersion: '2',
      matchId: 'NA1_5099001',
      participants: participants.map((p) => p.puuid),
    },
    info: {
      queueId,
      gameMode: queueId === 450 ? 'ARAM' : 'CLASSIC',
      gameStartTimestamp: 1_726_000_000_000,
      gameDuration: 1_812,
      participants,
      // NOT declared — must be dropped
      gameCreation: 1_725_999_999_000,
      gameEndTimestamp: 1_726_000_001_812,
      gameVersion: '14.18.1',
      mapId: 11,
      platformId: 'NA1',
      teams: [
        { teamId: 100, win: true, objectives: { champion: { kills: 25 }, baron: { kills: 1 } } },
        { teamId: 200, win: false, objectives: { champion: { kills: 14 } } },
      ],
    },
  };
}

describe('projectMatchDto — drops undeclared fields (Requirement 2.1)', () => {
  it('keeps only the declared metadata / info fields', () => {
    const projected = projectMatchDto(rawMatch(420, [rawParticipant(PUUID_A)]));

    expect(Object.keys(projected.metadata).sort()).toEqual(['matchId', 'participants']);
    expect(Object.keys(projected.info).sort()).toEqual(
      ['gameDuration', 'gameMode', 'gameStartTimestamp', 'participants', 'queueId'].sort(),
    );
    expect('teams' in projected.info).toBe(false);
    expect('gameCreation' in projected.info).toBe(false);
    expect('dataVersion' in projected.metadata).toBe(false);
  });

  it('keeps only the declared participant fields, including a full perks page', () => {
    const projected = projectMatchDto(rawMatch(420, [rawParticipant(PUUID_A)]));
    const p = projected.info.participants[0] as unknown as Record<string, unknown>;

    expect('challenges' in p).toBe(false);
    expect('missions' in p).toBe(false);
    expect('spell1Casts' in p).toBe(false);
    expect('totalDamageTaken' in p).toBe(false);
    expect('summonerName' in p).toBe(false);

    expect(p.perks).toEqual({
      statPerks: { offense: 5008, flex: 5008, defense: 5001 },
      styles: [
        { description: 'primaryStyle', style: 8100, selections: [{ perk: 8112 }, { perk: 8143 }] },
        { description: 'subStyle', style: 8200, selections: [{ perk: 8226 }] },
      ],
    });
    expect(p.kills).toBe(8);
    expect(p.item0).toBe(3157);
    expect(p.riotIdGameName).toBe('Someone');
  });
});

describe('projectMatchDto — lossless for downstream consumers (Requirement 2.3)', () => {
  it('toIncludedMatch produces identical output from the raw and projected match', () => {
    const raw = rawMatch(420, [rawParticipant(PUUID_A), rawParticipant(PUUID_B)]);
    const projected = projectMatchDto(raw);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fromRaw = toIncludedMatch(raw as any, PUUID_A);
    const fromProjected = toIncludedMatch(projected, PUUID_A);

    expect(fromProjected).toEqual(fromRaw);
    expect(fromProjected).toBeDefined();
    // spot-check the derived bits the rating / rows depend on
    expect(fromProjected?.participants).toHaveLength(2);
    expect(fromProjected?.opponent?.championName).toBe('Ahri');
  });

  it('toLanelessMatch produces identical output for an ARAM match', () => {
    const raw = rawMatch(450, [rawParticipant(PUUID_A), rawParticipant(PUUID_B, { teamPosition: '', role: '' })]);
    const projected = projectMatchDto(raw);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(toLanelessMatch(projected, PUUID_A)).toEqual(toLanelessMatch(raw as any, PUUID_A));
  });

  it('computeRecentMatches is unchanged across the projection', () => {
    const raw = rawMatch(420, [rawParticipant(PUUID_A), rawParticipant(PUUID_B)]);
    const included = [toIncludedMatch(projectMatchDto(raw), PUUID_A)].filter((m): m is NonNullable<typeof m> => m !== undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const includedRaw = [toIncludedMatch(raw as any, PUUID_A)].filter((m): m is NonNullable<typeof m> => m !== undefined);

    expect(computeRecentMatches(included, [])).toEqual(computeRecentMatches(includedRaw, []));
  });
});

describe('projectMatchDto — total over any input', () => {
  it.each([[null], [undefined], ['garbage'], [42], [[]], [{ info: 'nope' }], [{ metadata: null, info: null }]])(
    'returns a well-formed MatchDto for %o without throwing',
    (input) => {
      const projected = projectMatchDto(input);
      expect(projected.metadata.participants).toEqual([]);
      expect(projected.info.participants).toEqual([]);
      expect(() => JSON.stringify(projected)).not.toThrow();
    },
  );

  it('drops non-string entries from metadata.participants', () => {
    const projected = projectMatchDto({ metadata: { participants: ['a', 1, null, 'b'] }, info: {} });
    expect(projected.metadata.participants).toEqual(['a', 'b']);
  });

  it('is idempotent', () => {
    const once = projectMatchDto(rawMatch(420, [rawParticipant(PUUID_A)]));
    expect(projectMatchDto(once)).toEqual(once);
  });
});
