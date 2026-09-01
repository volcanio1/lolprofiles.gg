import { describe, expect, it } from 'vitest';
import {
  computePerformanceFeedback,
  csPerMinuteFeedbackOf,
  damageShareFeedbackOf,
  earlyGameDeficitFeedbackOf,
  isSupportMajority,
  jungleObjectivesFeedbackOf,
  killParticipationFeedbackOf,
  lanePhaseDeathsFeedbackOf,
  recentRankedWindowOf,
  type EarlyGameAggregate,
  CS_PER_MINUTE_BENCHMARK,
  EARLY_GAME_GOLD_DEFICIT_THRESHOLD,
  JUNGLE_OBJECTIVE_THRESHOLD,
  KILL_PARTICIPATION_BENCHMARK,
  LANE_PHASE_DEATH_BENCHMARK,
  PERFORMANCE_FEEDBACK_WINDOW,
  TEAM_DAMAGE_SHARE_THRESHOLD,
} from './performanceFeedback';
import type { IncludedMatch, ItemBuild, MatchParticipant } from './stats';

const EMPTY_BUILD: ItemBuild = { items: [0, 0, 0, 0, 0, 0], trinket: 0 };

function participant(over: Partial<MatchParticipant> = {}): MatchParticipant {
  return {
    isAnalyzedPlayer: false,
    isEnemyLaner: false,
    teamId: 100,
    riotIdGameName: '',
    riotIdTagline: '',
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

describe('recentRankedWindowOf (Requirement 6)', () => {
  it('excludes normal and laneless-classified queue types', () => {
    const matches = [match({ queueType: 'normal' }), match({ queueType: 'ranked solo/duo' })];
    expect(recentRankedWindowOf(matches)).toHaveLength(1);
  });

  it('caps at PERFORMANCE_FEEDBACK_WINDOW, keeping the most recent', () => {
    const matches = Array.from({ length: 35 }, (_, i) => match({ matchId: `m${String(i)}`, startTimestamp: i }));
    const window = recentRankedWindowOf(matches);
    expect(window).toHaveLength(PERFORMANCE_FEEDBACK_WINDOW);
    expect(window[0].matchId).toBe('m34'); // most recent first
    expect(window.at(-1)?.matchId).toBe('m5');
  });

  it('returns all matches, never padded, when fewer than the cap exist', () => {
    const matches = [match({ matchId: 'a' }), match({ matchId: 'b' })];
    expect(recentRankedWindowOf(matches)).toHaveLength(2);
  });
});

describe('isSupportMajority (Requirement 8)', () => {
  it('is true when the most-played role is Support', () => {
    const matches = [match({ role: 'Support' }), match({ role: 'Support' }), match({ role: 'TOP' })];
    expect(isSupportMajority(matches)).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isSupportMajority([match({ role: 'MIDDLE' })])).toBe(false);
  });
});

describe('csPerMinuteFeedbackOf (Requirement 9)', () => {
  it('triggers when average CS/min is strictly below the benchmark', () => {
    const matches = [match({ cs: 100, durationSeconds: 1_800, role: 'MIDDLE' })]; // 100/30 = 3.33 CS/min
    const feedback = csPerMinuteFeedbackOf(matches);
    expect(feedback?.category).toBe('csPerMinute');
    expect(feedback?.metricValue).toBeLessThan(CS_PER_MINUTE_BENCHMARK);
    expect(feedback?.benchmarkValue).toBe(CS_PER_MINUTE_BENCHMARK);
  });

  it('does not trigger exactly at the benchmark (strict <)', () => {
    // 8.5 CS/min over 30 minutes = 255 cs.
    const matches = [match({ cs: 255, durationSeconds: 1_800, role: 'MIDDLE' })];
    expect(csPerMinuteFeedbackOf(matches)).toBeUndefined();
  });

  it('never triggers for a Support-majority player, regardless of CS/min', () => {
    const matches = [match({ cs: 10, durationSeconds: 1_800, role: 'Support' })];
    expect(csPerMinuteFeedbackOf(matches)).toBeUndefined();
  });

  it('is undefined for an empty window', () => {
    expect(csPerMinuteFeedbackOf([])).toBeUndefined();
  });
});

describe('damageShareFeedbackOf (Requirement 10)', () => {
  it('triggers when average damage is below the threshold of the team average', () => {
    const matches = [
      match({
        role: 'MIDDLE',
        participants: [
          participant({ isAnalyzedPlayer: true, teamId: 100, damageToChampions: 1_000 }),
          participant({ teamId: 100, damageToChampions: 5_000 }),
          participant({ teamId: 100, damageToChampions: 5_000 }),
          participant({ teamId: 100, damageToChampions: 5_000 }),
          participant({ teamId: 100, damageToChampions: 5_000 }),
        ],
      }),
    ];
    const feedback = damageShareFeedbackOf(matches);
    expect(feedback?.category).toBe('damageShare');
    expect(feedback?.metricValue).toBe(1_000);
    expect(feedback?.benchmarkValue).toBe(5_000 * TEAM_DAMAGE_SHARE_THRESHOLD);
  });

  it('excludes a match with no Full_Lobby rather than treating it as zero', () => {
    const matches = [match({ role: 'MIDDLE', participants: undefined })];
    expect(damageShareFeedbackOf(matches)).toBeUndefined();
  });

  it('never triggers for a Support-majority player', () => {
    const matches = [
      match({
        role: 'Support',
        participants: [
          participant({ isAnalyzedPlayer: true, teamId: 100, damageToChampions: 0 }),
          participant({ teamId: 100, damageToChampions: 10_000 }),
        ],
      }),
    ];
    expect(damageShareFeedbackOf(matches)).toBeUndefined();
  });
});

describe('killParticipationFeedbackOf (Requirement 11)', () => {
  it('triggers when average kill participation is below the benchmark', () => {
    const matches = [
      match({ participants: [participant({ isAnalyzedPlayer: true, killParticipationPercent: 30 })] }),
    ];
    const feedback = killParticipationFeedbackOf(matches);
    expect(feedback?.metricValue).toBe(30);
    expect(feedback?.benchmarkValue).toBe(KILL_PARTICIPATION_BENCHMARK);
  });

  it('excludes an N/A row rather than treating it as 0%', () => {
    const matches = [
      match({ participants: [participant({ isAnalyzedPlayer: true, killParticipationPercent: 'N/A' })] }),
    ];
    expect(killParticipationFeedbackOf(matches)).toBeUndefined();
  });
});

describe('jungleObjectivesFeedbackOf (Requirement 12)', () => {
  it('triggers when the player is behind the enemy jungler', () => {
    const matches = [
      match({
        participants: [
          participant({
            isAnalyzedPlayer: true,
            teamId: 100,
            teamPosition: 'JUNGLE',
            neutralMinionsKilled: 50,
            turretKills: 0,
            dragonKills: 0,
            baronKills: 0,
          }),
          participant({
            teamId: 200,
            teamPosition: 'JUNGLE',
            neutralMinionsKilled: 150,
            turretKills: 1,
            dragonKills: 2,
            baronKills: 0,
          }),
        ],
      }),
    ];
    const feedback = jungleObjectivesFeedbackOf(matches);
    expect(feedback?.category).toBe('jungleObjectives');
    expect(feedback?.metricValue).toBe(50);
    expect(feedback?.benchmarkValue).toBe(round(153 * JUNGLE_OBJECTIVE_THRESHOLD));
  });

  it('never considers a non-jungle match', () => {
    const matches = [
      match({
        participants: [
          participant({ isAnalyzedPlayer: true, teamId: 100, teamPosition: 'MIDDLE', neutralMinionsKilled: 0 }),
          participant({ teamId: 200, teamPosition: 'JUNGLE', neutralMinionsKilled: 200 }),
        ],
      }),
    ];
    expect(jungleObjectivesFeedbackOf(matches)).toBeUndefined();
  });

  it('excludes a jungle match with no identifiable enemy jungler', () => {
    const matches = [
      match({
        participants: [
          participant({ isAnalyzedPlayer: true, teamId: 100, teamPosition: 'JUNGLE', neutralMinionsKilled: 10 }),
          participant({ teamId: 200, teamPosition: 'MIDDLE' }),
        ],
      }),
    ];
    expect(jungleObjectivesFeedbackOf(matches)).toBeUndefined();
  });
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function earlyGame(over: Partial<EarlyGameAggregate> & { matchId: string }): EarlyGameAggregate {
  return { lanePhaseDeaths: null, goldDiffAt10: null, csDiffAt10: null, ...over };
}

describe('lanePhaseDeathsFeedbackOf (Requirement 15)', () => {
  it('triggers when average lane-phase deaths exceed the benchmark', () => {
    const matches = [match({ matchId: 'a' }), match({ matchId: 'b' }), match({ matchId: 'c' })];
    const data = [
      earlyGame({ matchId: 'a', lanePhaseDeaths: 3 }),
      earlyGame({ matchId: 'b', lanePhaseDeaths: 3 }),
      earlyGame({ matchId: 'c', lanePhaseDeaths: 3 }),
    ];
    const feedback = lanePhaseDeathsFeedbackOf(matches, data);
    expect(feedback?.category).toBe('lanePhaseDeaths');
    expect(feedback?.metricValue).toBe(3);
    expect(feedback?.benchmarkValue).toBe(LANE_PHASE_DEATH_BENCHMARK);
  });

  it('excludes a match with a null lane-phase-death count rather than treating it as 0', () => {
    const matches = [match({ matchId: 'a' })];
    expect(lanePhaseDeathsFeedbackOf(matches, [earlyGame({ matchId: 'a', lanePhaseDeaths: null })])).toBeUndefined();
  });

  it('ignores an earlyGame entry for a match outside the ranked window', () => {
    const matches = [match({ matchId: 'a' })];
    const data = [earlyGame({ matchId: 'not-in-window', lanePhaseDeaths: 10 })];
    expect(lanePhaseDeathsFeedbackOf(matches, data)).toBeUndefined();
  });
});

describe('earlyGameDeficitFeedbackOf (Requirement 16)', () => {
  it('triggers when the average gold deficit exceeds the threshold', () => {
    const matches = [match({ matchId: 'a' })];
    const data = [earlyGame({ matchId: 'a', goldDiffAt10: -(EARLY_GAME_GOLD_DEFICIT_THRESHOLD + 100), csDiffAt10: -8 })];
    const feedback = earlyGameDeficitFeedbackOf(matches, data);
    expect(feedback?.category).toBe('earlyGameDeficit');
    expect(feedback?.metricValue).toBe(-(EARLY_GAME_GOLD_DEFICIT_THRESHOLD + 100));
    expect(feedback?.text).toContain('CS');
  });

  it('does not trigger exactly at the threshold (strict <)', () => {
    const matches = [match({ matchId: 'a' })];
    const data = [earlyGame({ matchId: 'a', goldDiffAt10: -EARLY_GAME_GOLD_DEFICIT_THRESHOLD })];
    expect(earlyGameDeficitFeedbackOf(matches, data)).toBeUndefined();
  });

  it('excludes a match with no gold diff (no lane opponent, or under 10 minutes)', () => {
    const matches = [match({ matchId: 'a' })];
    expect(earlyGameDeficitFeedbackOf(matches, [earlyGame({ matchId: 'a' })])).toBeUndefined();
  });

  it('omits the CS clause when no contributing match has a CS diff', () => {
    const matches = [match({ matchId: 'a' })];
    const data = [earlyGame({ matchId: 'a', goldDiffAt10: -1_000, csDiffAt10: null })];
    expect(earlyGameDeficitFeedbackOf(matches, data)?.text).not.toContain('CS');
  });
});

describe('computePerformanceFeedback — assembly (Requirement 7)', () => {
  it('returns an empty array when nothing triggers', () => {
    const matches = [
      match({
        cs: 1_000,
        durationSeconds: 1_800,
        participants: [
          participant({ isAnalyzedPlayer: true, teamId: 100, damageToChampions: 10_000, killParticipationPercent: 90 }),
          participant({ teamId: 100, damageToChampions: 5_000 }),
        ],
      }),
    ];
    expect(computePerformanceFeedback(matches)).toEqual([]);
  });

  it('orders triggered categories as csPerMinute, damageShare, killParticipation, jungleObjectives', () => {
    const matches = [
      match({
        cs: 10,
        durationSeconds: 1_800,
        participants: [
          participant({ isAnalyzedPlayer: true, teamId: 100, damageToChampions: 100, killParticipationPercent: 10 }),
          participant({ teamId: 100, damageToChampions: 10_000 }),
        ],
      }),
    ];
    const feedback = computePerformanceFeedback(matches);
    expect(feedback.map((f) => f.category)).toEqual(['csPerMinute', 'damageShare', 'killParticipation']);
  });

  it('places lanePhaseDeaths and earlyGameDeficit last, and defaults earlyGame to [] when omitted', () => {
    const matches = [match({ matchId: 'a', cs: 10, durationSeconds: 1_800 })];
    // Omitting the second argument entirely: Phase 2 categories never fire.
    expect(computePerformanceFeedback(matches).map((f) => f.category)).toEqual(['csPerMinute']);

    const withEarlyGame = computePerformanceFeedback(matches, [
      earlyGame({ matchId: 'a', lanePhaseDeaths: 5, goldDiffAt10: -1_000, csDiffAt10: -10 }),
    ]);
    expect(withEarlyGame.map((f) => f.category)).toEqual(['csPerMinute', 'lanePhaseDeaths', 'earlyGameDeficit']);
  });
});
