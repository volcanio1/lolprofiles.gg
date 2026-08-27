import { describe, it, expect } from 'vitest';
import type { LeagueEntryDto, MatchDto } from '../riotApiClient';
import {
  ALLOWED_QUEUE_TYPES,
  LANELESS_QUEUE_TYPE_BY_QUEUE_ID,
  QUEUE_TYPE_BY_QUEUE_ID,
  queueTypeForQueueId,
  toIncludedMatch,
  toLanelessMatch,
  toLeagueEntries,
  toLeagueEntry,
} from './mapping';

/** Pure module under test: no fakes needed at all. */

const PUUID = 'puuid-under-test';

function participant(overrides: Partial<MatchDto['info']['participants'][number]> = {}) {
  return {
    puuid: PUUID,
    championName: 'Ahri',
    teamPosition: 'MIDDLE',
    role: 'SOLO',
    win: true,
    kills: 7,
    deaths: 3,
    assists: 9,
    visionScore: 21,
    ...overrides,
  };
}

function matchDto(overrides: {
  queueId?: number;
  gameStartTimestamp?: number;
  gameDuration?: number;
  matchId?: string;
  participants?: MatchDto['info']['participants'];
} = {}): MatchDto {
  const participants = overrides.participants ?? [participant()];
  return {
    metadata: {
      matchId: overrides.matchId ?? 'NA1_4242',
      participants: participants.map((entry) => entry.puuid),
    },
    info: {
      queueId: overrides.queueId ?? 420,
      gameStartTimestamp: overrides.gameStartTimestamp ?? 1_700_000_000_000,
      gameDuration: overrides.gameDuration ?? 1_812,
      participants,
    },
  };
}

describe('queueTypeForQueueId (Requirement 3.5)', () => {
  it('maps the ranked queues to their requirement-named types', () => {
    expect(queueTypeForQueueId(420)).toBe('ranked solo/duo');
    expect(queueTypeForQueueId(440)).toBe('ranked flex');
  });

  it('maps every allowed Summoner\u2019s Rift casual queue to "normal"', () => {
    expect(queueTypeForQueueId(400)).toBe('normal');
    expect(queueTypeForQueueId(430)).toBe('normal');
    expect(queueTypeForQueueId(480)).toBe('normal');
    expect(queueTypeForQueueId(490)).toBe('normal');
    // 710: featured/event 5v5 SR draft queue with standard roles \u2014 see decision 2.
    expect(queueTypeForQueueId(710)).toBe('normal');
  });

  it('excludes queues outside the three allowed types, including ARAM and Clash', () => {
    for (const queueId of [0, 450, 700, 720, 900, 1700, 2, 4, 8, 9, 460, 470, 410]) {
      expect(queueTypeForQueueId(queueId)).toBeUndefined();
    }
  });

  it('excludes unknown, non-numeric and non-finite queue ids (fail-safe)', () => {
    expect(queueTypeForQueueId(999_999)).toBeUndefined();
    expect(queueTypeForQueueId(undefined)).toBeUndefined();
    expect(queueTypeForQueueId('420')).toBeUndefined();
    expect(queueTypeForQueueId(Number.NaN)).toBeUndefined();
    expect(queueTypeForQueueId(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('never produces a queue type outside the requirement-declared set', () => {
    for (const mapped of Object.values(QUEUE_TYPE_BY_QUEUE_ID)) {
      expect(ALLOWED_QUEUE_TYPES).toContain(mapped);
    }
  });

  it('does not inherit object prototype members as queue ids', () => {
    expect(queueTypeForQueueId(Number('toString'))).toBeUndefined();
  });
});

describe('toIncludedMatch', () => {
  it('flattens the requester\u2019s own participant row', () => {
    const included = toIncludedMatch(matchDto(), PUUID);

    expect(included).toEqual({
      matchId: 'NA1_4242',
      queueType: 'ranked solo/duo',
      startTimestamp: 1_700_000_000_000,
      durationSeconds: 1_812,
      championName: 'Ahri',
      role: 'MIDDLE',
      win: true,
      kills: 7,
      deaths: 3,
      assists: 9,
      visionScore: 21,
      cs: 0,
      opponent: undefined,
      build: { items: [0, 0, 0, 0, 0, 0], trinket: 0 },
      participants: [
        {
          isAnalyzedPlayer: true,
          isEnemyLaner: false,
          teamId: 0,
          riotIdGameName: '',
          riotIdTagline: '',
          championName: 'Ahri',
          champLevel: 0,
          teamPosition: 'MIDDLE',
          summonerSpells: [0, 0],
          runes: { primaryStyle: 0, secondaryStyle: 0, primarySelections: [], secondarySelections: [], statShards: [0, 0, 0] },
          build: { items: [0, 0, 0, 0, 0, 0], trinket: 0 },
          kills: 7,
          deaths: 3,
          assists: 9,
          cs: 0,
          visionScore: 21,
          damageToChampions: 0,
          goldEarned: 0,
          turretKills: 0,
          dragonKills: 0,
          baronKills: 0,
          win: true,
          killParticipationPercent: 'N/A',
          augments: [],
        },
      ],
    });
  });

  it('selects the requester by PUUID and ignores other participants', () => {
    const match = matchDto({
      participants: [
        participant({ puuid: 'someone-else', championName: 'Garen', kills: 99 }),
        participant({ championName: 'Lux', kills: 1 }),
        participant({ puuid: 'another', championName: 'Thresh', kills: 50 }),
      ],
    });

    expect(toIncludedMatch(match, PUUID)?.championName).toBe('Lux');
    expect(toIncludedMatch(match, PUUID)?.kills).toBe(1);
  });

  it('excludes a match whose queue type is not allowed (Requirement 3.5)', () => {
    expect(toIncludedMatch(matchDto({ queueId: 450 }), PUUID)).toBeUndefined();
  });

  it('excludes a match with no participant row for the requester', () => {
    const match = matchDto({ participants: [participant({ puuid: 'someone-else' })] });
    expect(toIncludedMatch(match, PUUID)).toBeUndefined();
  });

  it('excludes a match whose participant list has been anonymized', () => {
    // Defensive: deletion now evicts such entries rather than redacting them, so
    // this should no longer arise from a deletion request — but an anonymized or
    // malformed participant list from Riot must still exclude the match rather
    // than crash or invent statistics.
    const match = matchDto({ participants: [participant({ puuid: 'ANONYMIZED' })] });
    expect(toIncludedMatch(match, PUUID)).toBeUndefined();
  });

  it('excludes a match with a non-finite start timestamp', () => {
    expect(toIncludedMatch(matchDto({ gameStartTimestamp: Number.NaN }), PUUID)).toBeUndefined();
  });

  it('excludes malformed payloads without throwing', () => {
    expect(toIncludedMatch(undefined, PUUID)).toBeUndefined();
    expect(toIncludedMatch({} as MatchDto, PUUID)).toBeUndefined();
    expect(toIncludedMatch({ info: {} } as MatchDto, PUUID)).toBeUndefined();
    expect(toIncludedMatch({ info: { queueId: 420 } } as MatchDto, PUUID)).toBeUndefined();
    expect(
      toIncludedMatch(
        { info: { queueId: 420, gameStartTimestamp: 1, gameDuration: 1, participants: 'nope' } } as unknown as MatchDto,
        PUUID,
      ),
    ).toBeUndefined();
  });

  it('coerces missing gameplay counters to 0 rather than excluding the match', () => {
    const match = matchDto({
      participants: [
        participant({
          kills: undefined as unknown as number,
          deaths: Number.NaN,
          assists: undefined as unknown as number,
          visionScore: undefined as unknown as number,
        }),
      ],
    });
    // Built directly rather than via the helper, whose `??` default would
    // substitute a duration for the missing one this case is about.
    match.info.gameDuration = undefined as unknown as number;

    const included = toIncludedMatch(match, PUUID);
    expect(included).toMatchObject({ kills: 0, deaths: 0, assists: 0, visionScore: 0, durationSeconds: 0 });
  });

  it('falls back to Riot\u2019s legacy role field when teamPosition is blank', () => {
    const blank = toIncludedMatch(
      matchDto({ participants: [participant({ teamPosition: '   ', role: 'SUPPORT' })] }),
      PUUID,
    );
    expect(blank?.role).toBe('SUPPORT');

    const missing = toIncludedMatch(
      matchDto({ participants: [participant({ teamPosition: undefined, role: 'CARRY' })] }),
      PUUID,
    );
    expect(missing?.role).toBe('CARRY');
  });

  it('reports a blank role when Riot supplies neither field', () => {
    const included = toIncludedMatch(
      matchDto({ participants: [participant({ teamPosition: '', role: '' })] }),
      PUUID,
    );
    expect(included?.role).toBe('');
  });

  it('treats a non-true win value as a loss', () => {
    const included = toIncludedMatch(
      matchDto({ participants: [participant({ win: undefined as unknown as boolean })] }),
      PUUID,
    );
    expect(included?.win).toBe(false);
  });

  it('sums minion and neutral-monster kills into cs', () => {
    const included = toIncludedMatch(
      matchDto({ participants: [participant({ totalMinionsKilled: 180, neutralMinionsKilled: 12 })] }),
      PUUID,
    );
    expect(included?.cs).toBe(192);
  });

  it('finds the opposing participant in the same lane as the opponent', () => {
    const match = matchDto({
      participants: [
        participant({ teamId: 100, teamPosition: 'MIDDLE', kills: 7 }),
        participant({
          puuid: 'rival',
          teamId: 200,
          teamPosition: 'MIDDLE',
          championName: 'Zed',
          kills: 4,
          deaths: 5,
          assists: 2,
          visionScore: 15,
          totalMinionsKilled: 150,
          neutralMinionsKilled: 0,
        }),
        participant({ puuid: 'other-lane', teamId: 200, teamPosition: 'TOP', championName: 'Darius' }),
      ],
    });

    const included = toIncludedMatch(match, PUUID);
    expect(included?.opponent).toEqual({
      championName: 'Zed',
      kills: 4,
      deaths: 5,
      assists: 2,
      cs: 150,
      csPerMinute: 4.97,
      visionScore: 15,
      build: { items: [0, 0, 0, 0, 0, 0], trinket: 0 },
    });
  });

  it('reports no opponent when no other participant shares the lane on a different team', () => {
    const match = matchDto({
      participants: [
        participant({ teamId: 100, teamPosition: 'MIDDLE' }),
        participant({ puuid: 'teammate', teamId: 100, teamPosition: 'TOP' }),
      ],
    });
    expect(toIncludedMatch(match, PUUID)?.opponent).toBeUndefined();
  });

  it('reports no opponent when teamId is missing or malformed', () => {
    const match = matchDto({
      participants: [
        participant({ teamPosition: 'MIDDLE' }),
        participant({ puuid: 'rival', teamPosition: 'MIDDLE', teamId: undefined }),
      ],
    });
    expect(toIncludedMatch(match, PUUID)?.opponent).toBeUndefined();
  });
});

describe('toLeagueEntry / toLeagueEntries', () => {
  it('renames Riot\u2019s rank field to division and preserves the rest', () => {
    const dto: LeagueEntryDto = {
      queueType: 'RANKED_SOLO_5x5',
      tier: 'GOLD',
      rank: 'II',
      leaguePoints: 44,
      wins: 30,
      losses: 20,
    };

    expect(toLeagueEntry(dto)).toEqual({
      queueType: 'RANKED_SOLO_5x5',
      tier: 'GOLD',
      division: 'II',
      leaguePoints: 44,
      wins: 30,
      losses: 20,
    });
  });

  it('maps an empty entry list to an empty array (Requirement 2.8)', () => {
    expect(toLeagueEntries([])).toEqual([]);
  });

  it('maps a malformed body to an empty array rather than throwing', () => {
    expect(toLeagueEntries(undefined)).toEqual([]);
    expect(toLeagueEntries('nope' as unknown as LeagueEntryDto[])).toEqual([]);
    expect(toLeagueEntries([null as unknown as LeagueEntryDto])).toEqual([]);
  });

  it('normalizes missing fields instead of dropping the standing', () => {
    expect(toLeagueEntries([{} as LeagueEntryDto])).toEqual([
      { queueType: '', tier: '', division: '', leaguePoints: 0, wins: 0, losses: 0 },
    ]);
  });
});

// `match-detail-tabs` task 9.8 — Requirements 11.1, 11.2, 11.3, 12.1, 12.2, 12.9.
describe('toLanelessMatch', () => {
  it('admits queue 450 (ARAM) and classifies it "aram"', () => {
    const match = matchDto({ queueId: 450 });
    const laneless = toLanelessMatch(match, PUUID);
    expect(laneless).toBeDefined();
    expect(laneless?.queueType).toBe('aram');
  });

  it('admits queue 2400 (ARAM Mayhem) and classifies it "aram mayhem"', () => {
    const match = matchDto({ queueId: 2400 });
    const laneless = toLanelessMatch(match, PUUID);
    expect(laneless).toBeDefined();
    expect(laneless?.queueType).toBe('aram mayhem');
  });

  it('returns undefined for every laned (six-queue) id, and for an arbitrary unrecognized id', () => {
    for (const queueId of [400, 420, 430, 440, 480, 490, 710, 700, 900]) {
      expect(toLanelessMatch(matchDto({ queueId }), PUUID)).toBeUndefined();
    }
  });

  it('never adds a laneless id to the role-relative allowlist, and the two maps are disjoint', () => {
    for (const queueId of Object.keys(LANELESS_QUEUE_TYPE_BY_QUEUE_ID).map(Number)) {
      expect(Object.prototype.hasOwnProperty.call(QUEUE_TYPE_BY_QUEUE_ID, queueId)).toBe(false);
      expect(ALLOWED_QUEUE_TYPES).not.toContain(LANELESS_QUEUE_TYPE_BY_QUEUE_ID[queueId]);
    }
  });

  it('marks isEnemyLaner false on every participant, even when a same-role rival exists', () => {
    const match = matchDto({
      queueId: 450,
      participants: [
        participant({ teamId: 100, teamPosition: 'MIDDLE' }),
        participant({ puuid: 'other', teamId: 200, teamPosition: 'MIDDLE', championName: 'Zed' }),
      ],
    });
    const laneless = toLanelessMatch(match, PUUID);
    expect(laneless?.participants.every((p) => !p.isEnemyLaner)).toBe(true);
  });

  it('marks exactly one participant isAnalyzedPlayer, and captures none as an opponent summary field (LanelessMatch has no `opponent`)', () => {
    const match = matchDto({
      queueId: 450,
      participants: [participant({ teamId: 100 }), participant({ puuid: 'other', teamId: 200 })],
    });
    const laneless = toLanelessMatch(match, PUUID);
    expect(laneless?.participants.filter((p) => p.isAnalyzedPlayer)).toHaveLength(1);
    expect(laneless).not.toHaveProperty('opponent');
  });

  it('excludes the match when the requester has no participant row, same as toIncludedMatch', () => {
    const match = matchDto({ queueId: 450, participants: [participant({ puuid: 'someone-else' })] });
    expect(toLanelessMatch(match, PUUID)).toBeUndefined();
  });

  it('captures zero, some, and all six augments, filtering zero slots and preserving Riot’s field order', () => {
    const zero = participant({
      playerAugment1: 0,
      playerAugment2: 0,
      playerAugment3: 0,
      playerAugment4: 0,
      playerAugment5: 0,
      playerAugment6: 0,
    });
    const some = participant({
      playerAugment1: 1205,
      playerAugment2: 0,
      playerAugment3: 1141,
      playerAugment4: 0,
      playerAugment5: 0,
      playerAugment6: 0,
    });
    const six = participant({
      playerAugment1: 101,
      playerAugment2: 102,
      playerAugment3: 103,
      playerAugment4: 104,
      playerAugment5: 105,
      playerAugment6: 106,
    });

    for (const [fixture, expected] of [
      [zero, []],
      [some, [1205, 1141]],
      [six, [101, 102, 103, 104, 105, 106]],
    ] as const) {
      const match = matchDto({ queueId: 2400, participants: [fixture] });
      const laneless = toLanelessMatch(match, PUUID);
      expect(laneless?.participants[0].augments).toEqual(expected);
    }
  });
});
