import { describe, expect, it } from 'vitest';
import {
  averageGoldDiffAt10Of,
  averageKdaFactOf,
  computeFunFactsV2,
  favoriteItemsOf,
  longestGameOf,
  mostUsedPingOf,
  nemesisOf,
  BOOT_ITEM_IDS,
  FAVORITE_ITEM_COUNT,
  NEMESIS_MIN_GAMES,
  PING_FIELD_ORDER,
} from './funFactsV2';
import type { EarlyGameAggregate } from './performanceFeedback';
import type { IncludedMatch, ItemBuild, LanelessMatch, MatchParticipant, OpponentSummary } from './stats';

const EMPTY_BUILD: ItemBuild = { items: [0, 0, 0, 0, 0, 0], trinket: 0 };

function opponent(championName: string, over: Partial<OpponentSummary> = {}): OpponentSummary {
  return {
    championName,
    kills: 0,
    deaths: 0,
    assists: 0,
    cs: 0,
    csPerMinute: 0,
    visionScore: 0,
    build: EMPTY_BUILD,
    ...over,
  };
}

function participant(over: Partial<MatchParticipant> = {}): MatchParticipant {
  return {
    isAnalyzedPlayer: true,
    isEnemyLaner: false,
    teamId: 100,
    riotIdGameName: 'Me',
    riotIdTagline: 'NA1',
    championName: 'Ahri',
    champLevel: 15,
    teamPosition: 'MIDDLE',
    summonerSpells: [4, 14],
    runes: { primaryStyle: 0, secondaryStyle: 0, primarySelections: [], secondarySelections: [], statShards: [0, 0, 0] },
    build: EMPTY_BUILD,
    kills: 0,
    deaths: 0,
    assists: 0,
    cs: 0,
    visionScore: 0,
    damageToChampions: 0,
    goldEarned: 0,
    win: true,
    turretKills: 0,
    dragonKills: 0,
    baronKills: 0,
    pentaKills: 0,
    killParticipationPercent: 0,
    augments: [],
    neutralMinionsKilled: 0,
    onMyWayPings: 0,
    enemyMissingPings: 0,
    enemyVisionPings: 0,
    needVisionPings: 0,
    pushPings: 0,
    holdPings: 0,
    getBackPings: 0,
    assistMePings: 0,
    allInPings: 0,
    retreatPings: 0,
    dangerPings: 0,
    basicPings: 0,
    commandPings: 0,
    visionClearedPings: 0,
    ...over,
  };
}

function match(over: Partial<IncludedMatch> = {}): IncludedMatch {
  return {
    matchId: 'NA1_1',
    queueType: 'ranked solo/duo',
    startTimestamp: 1_700_000_000_000,
    durationSeconds: 1_800,
    championName: 'Ahri',
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

describe('nemesisOf (Requirement 2)', () => {
  it('excludes a champion below NEMESIS_MIN_GAMES', () => {
    const matches = [
      match({ opponent: opponent('Zed'), win: false }),
      match({ opponent: opponent('Zed'), win: false }),
    ];
    expect(matches.length).toBeLessThan(NEMESIS_MIN_GAMES);
    expect(nemesisOf(matches)).toBeUndefined();
  });

  it('selects the lowest win rate among eligible champions', () => {
    const matches = [
      // Zed: 1-2 (33%)
      match({ opponent: opponent('Zed'), win: false }),
      match({ opponent: opponent('Zed'), win: false }),
      match({ opponent: opponent('Zed'), win: true }),
      // Yasuo: 2-1 (67%)
      match({ opponent: opponent('Yasuo'), win: true }),
      match({ opponent: opponent('Yasuo'), win: true }),
      match({ opponent: opponent('Yasuo'), win: false }),
    ];
    const result = nemesisOf(matches);
    expect(result).toMatchObject({ championName: 'Zed', wins: 1, losses: 2, gamesPlayed: 3, winRatePercent: 33 });
  });

  it('breaks a win-rate tie by higher game count, then by name ascending', () => {
    const matches = [
      // Zed: 1-2 (33%), 3 games
      match({ opponent: opponent('Zed'), win: false }),
      match({ opponent: opponent('Zed'), win: false }),
      match({ opponent: opponent('Zed'), win: true }),
      // Ahri: 2-4 (33%), 6 games — same win rate, more games -> wins tie-break
      match({ opponent: opponent('Ahri'), win: false }),
      match({ opponent: opponent('Ahri'), win: false }),
      match({ opponent: opponent('Ahri'), win: false }),
      match({ opponent: opponent('Ahri'), win: false }),
      match({ opponent: opponent('Ahri'), win: true }),
      match({ opponent: opponent('Ahri'), win: true }),
    ];
    expect(nemesisOf(matches)?.championName).toBe('Ahri');
  });

  it('ignores matches with no recorded opponent', () => {
    const matches = [match({ opponent: undefined }), match({ opponent: undefined }), match({ opponent: undefined })];
    expect(nemesisOf(matches)).toBeUndefined();
  });
});

describe('longestGameOf (Requirement 3)', () => {
  it('is undefined for an empty window', () => {
    expect(longestGameOf([])).toBeUndefined();
  });

  it('picks the greatest durationSeconds', () => {
    const longest = match({ matchId: 'long', durationSeconds: 2_400 });
    const matches = [match({ matchId: 'short', durationSeconds: 1_200 }), longest];
    expect(longestGameOf(matches)?.matchId).toBe('long');
  });

  it('breaks a duration tie by the most recent match', () => {
    const older = match({ matchId: 'older', durationSeconds: 1_800, startTimestamp: 1_000 });
    const newer = match({ matchId: 'newer', durationSeconds: 1_800, startTimestamp: 2_000 });
    expect(longestGameOf([older, newer])?.matchId).toBe('newer');
    expect(longestGameOf([newer, older])?.matchId).toBe('newer');
  });
});

describe('favoriteItemsOf (Requirement 4)', () => {
  it('excludes boots and empty slots', () => {
    const bootId = [...BOOT_ITEM_IDS][0];
    const matches = [
      match({ build: { items: [bootId, 0, 3157, 0, 0, 0], trinket: 3340 } }),
      match({ build: { items: [bootId, 0, 3157, 0, 0, 0], trinket: 3340 } }),
    ];
    const items = favoriteItemsOf(matches);
    expect(items).toEqual([{ itemId: 3157, count: 2 }]);
  });

  it('caps at FAVORITE_ITEM_COUNT and breaks a count tie by item id ascending', () => {
    const matches = [match({ build: { items: [10, 20, 30, 40, 0, 0], trinket: 0 } })];
    const items = favoriteItemsOf(matches);
    expect(items).toHaveLength(FAVORITE_ITEM_COUNT);
    expect(items.map((i) => i.itemId)).toEqual([10, 20, 30]);
  });

  it('is empty when nothing but boots/empty slots were ever recorded', () => {
    const bootId = [...BOOT_ITEM_IDS][0];
    const matches = [match({ build: { items: [bootId, 0, 0, 0, 0, 0], trinket: 0 } })];
    expect(favoriteItemsOf(matches)).toEqual([]);
  });
});

describe('mostUsedPingOf (Requirement 5)', () => {
  it('is undefined when every ping total is zero', () => {
    const matches = [match({ participants: [participant()] })];
    expect(mostUsedPingOf(matches)).toBeUndefined();
  });

  it('reports the field with the highest total', () => {
    const matches = [
      match({ participants: [participant({ onMyWayPings: 5, dangerPings: 2 })] }),
      match({ participants: [participant({ onMyWayPings: 4 })] }),
    ];
    expect(mostUsedPingOf(matches)).toEqual({ field: 'onMyWayPings', count: 9 });
  });

  it('breaks a tie by PING_FIELD_ORDER', () => {
    const matches = [match({ participants: [participant({ dangerPings: 3, pushPings: 3 })] })];
    // dangerPings sorts before pushPings in PING_FIELD_ORDER.
    expect(PING_FIELD_ORDER.indexOf('dangerPings')).toBeLessThan(PING_FIELD_ORDER.indexOf('pushPings'));
    expect(mostUsedPingOf(matches)?.field).toBe('dangerPings');
  });

  it('excludes a match with no analyzed-player row', () => {
    const matches = [
      match({ participants: [participant({ isAnalyzedPlayer: false, onMyWayPings: 99 })] }),
      match({ participants: undefined }),
    ];
    expect(mostUsedPingOf(matches)).toBeUndefined();
  });
});

function earlyGameEntry(over: Partial<EarlyGameAggregate> = {}): EarlyGameAggregate {
  return { matchId: 'NA1_1', lanePhaseDeaths: null, goldDiffAt10: null, csDiffAt10: null, ...over };
}

describe('averageKdaFactOf', () => {
  it('is undefined for an empty match window', () => {
    expect(averageKdaFactOf([])).toBeUndefined();
  });

  it('averages (kills + assists) / deaths across every match', () => {
    const matches = [match({ kills: 6, deaths: 2, assists: 10 }), match({ kills: 4, deaths: 2, assists: 6 })];
    // avgKills=5, avgDeaths=2, avgAssists=8 -> (5+8)/2 = 6.5
    expect(averageKdaFactOf(matches)).toBe(6.5);
  });
});

describe('averageGoldDiffAt10Of', () => {
  it('is undefined when earlyGame is empty', () => {
    expect(averageGoldDiffAt10Of([])).toBeUndefined();
  });

  it('is undefined when every entry has a null goldDiffAt10', () => {
    expect(averageGoldDiffAt10Of([earlyGameEntry(), earlyGameEntry()])).toBeUndefined();
  });

  it('averages only the non-null goldDiffAt10 entries', () => {
    const earlyGame = [
      earlyGameEntry({ goldDiffAt10: 400 }),
      earlyGameEntry({ goldDiffAt10: null }),
      earlyGameEntry({ goldDiffAt10: -200 }),
    ];
    expect(averageGoldDiffAt10Of(earlyGame)).toBe(100);
  });
});

describe('computeFunFactsV2 — assembly', () => {
  it('returns an empty array for an empty window', () => {
    expect(computeFunFactsV2([])).toEqual([]);
  });

  it('produces categories in the fixed order nemesis, longestGame, favoriteItems, mostUsedPing, averageKda, averageGoldDiffAt10', () => {
    const matches = [
      match({ opponent: opponent('Zed'), win: false }),
      match({ opponent: opponent('Zed'), win: false }),
      match({ opponent: opponent('Zed'), win: true, build: { items: [3157, 0, 0, 0, 0, 0], trinket: 0 } }),
      match({ participants: [participant({ onMyWayPings: 3 })] }),
    ];
    const earlyGame = [{ matchId: 'NA1_1', lanePhaseDeaths: null, goldDiffAt10: 150, csDiffAt10: null }];
    const facts = computeFunFactsV2(matches, [], earlyGame);
    expect(facts.map((f) => f.category)).toEqual([
      'nemesis',
      'longestGame',
      'favoriteItems',
      'mostUsedPing',
      'averageKda',
      'averageGoldDiffAt10',
    ]);
  });

  it('carries favoriteItems as structured data on that category only', () => {
    const matches = [match({ build: { items: [3157, 0, 0, 0, 0, 0], trinket: 0 } })];
    const facts = computeFunFactsV2(matches);
    const favoriteItemsFact = facts.find((f) => f.category === 'favoriteItems');
    expect(favoriteItemsFact?.favoriteItems).toEqual([{ itemId: 3157, count: 1 }]);
    expect(facts.find((f) => f.category === 'longestGame')?.favoriteItems).toBeUndefined();
  });

  it('omits an ineligible category rather than padding', () => {
    // No opponents recorded at all -> no Nemesis; still produces longestGame.
    const facts = computeFunFactsV2([match({ opponent: undefined })]);
    expect(facts.some((f) => f.category === 'nemesis')).toBe(false);
    expect(facts.some((f) => f.category === 'longestGame')).toBe(true);
  });

  describe('decision 7: Laneless_Match (ARAM/ARAM Mayhem) data is folded in too', () => {
    it('an ARAM-only longest game beats a shorter Summoner\'s Rift game', () => {
      const facts = computeFunFactsV2(
        [match({ durationSeconds: 1_000 })],
        [lanelessMatch({ durationSeconds: 2_500, championName: 'Kennen' })],
      );
      const longest = facts.find((f) => f.category === 'longestGame');
      expect(longest?.text).toContain('Kennen');
    });

    it('an ARAM-only item build still counts toward favorite items', () => {
      const facts = computeFunFactsV2(
        [],
        [lanelessMatch({ build: { items: [3157, 0, 0, 0, 0, 0], trinket: 0 } })],
      );
      const favoriteItems = facts.find((f) => f.category === 'favoriteItems');
      expect(favoriteItems?.favoriteItems).toEqual([{ itemId: 3157, count: 1 }]);
    });

    it('an ARAM-only ping tally still counts toward most-used ping', () => {
      const facts = computeFunFactsV2(
        [],
        [lanelessMatch({ participants: [participant({ onMyWayPings: 4 })] })],
      );
      expect(facts.find((f) => f.category === 'mostUsedPing')?.text).toContain('On My Way');
    });

    it('never contributes to Nemesis, since a Laneless_Match has no Lane_Opponent', () => {
      // 3 SR losses to Zed would normally make Zed the Nemesis; the ARAM
      // matches carry no `opponent` field at all, so they cannot dilute or
      // otherwise influence that computation either way.
      const facts = computeFunFactsV2(
        [
          match({ opponent: opponent('Zed'), win: false }),
          match({ opponent: opponent('Zed'), win: false }),
          match({ opponent: opponent('Zed'), win: false }),
        ],
        [lanelessMatch(), lanelessMatch(), lanelessMatch()],
      );
      expect(facts.find((f) => f.category === 'nemesis')?.text).toContain('Zed');
    });

    it('defaults lanelessMatches to [] so every existing call site is unaffected', () => {
      expect(computeFunFactsV2([match()])).toEqual(computeFunFactsV2([match()], []));
    });
  });
});
