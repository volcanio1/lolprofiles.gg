import { describe, expect, it } from 'vitest';
import { computeScoutingInsights, MAX_BAN_RECOMMENDATIONS } from './scoutingInsights';
import type { DeclaredPosition, RecentFormEntry, RosterCard, ScoutingReport } from './types';

function match(
  matchId: string,
  championId: number,
  win: boolean,
  participants: string[],
  role = 'MIDDLE',
): RecentFormEntry {
  return { matchId, championId, role, win, participantPuuids: participants };
}

function card(over: Partial<RosterCard> & { puuid: string }): RosterCard {
  return {
    declaredPosition: 'MIDDLE' as DeclaredPosition,
    isCaptain: false,
    riotId: null,
    rankedEntries: [],
    championPool: null,
    recentForm: [],
    observedRole: null,
    ...over,
  };
}

function report(roster: RosterCard[]): ScoutingReport {
  return {
    team: { id: 't', name: 'T', abbreviation: 'T', tier: 1, iconId: 0, captainPuuid: roster[0]?.puuid ?? '' },
    tournament: null,
    roster,
    insights: { banRecommendations: [], positionMismatches: [], stackCohesion: 0 },
  };
}

describe('computeScoutingInsights — ban recommendations (Requirement 3.2/3.3)', () => {
  it('orders by recent wins, then mastery, then recent games, then champion id', () => {
    const r = report([
      card({
        puuid: 'a',
        championPool: [
          { championId: 10, masteryPoints: 100_000, masteryLevel: 7 },
          { championId: 20, masteryPoints: 500_000, masteryLevel: 7 },
        ],
        recentForm: [
          match('m1', 10, true, ['a']),
          match('m2', 10, true, ['a']), // champ 10: 2 recent wins
          match('m3', 20, false, ['a']), // champ 20: 0 recent wins, huge mastery
        ],
      }),
    ]);
    const bans = computeScoutingInsights(r).banRecommendations;
    // champ 10 first (recent wins beat mastery), champ 20 second
    expect(bans.map((b) => b.championId)).toEqual([10, 20]);
    expect(bans[0]).toMatchObject({ championId: 10, recentWins: 2, recentGames: 2, masteryPoints: 100_000, puuid: 'a' });
  });

  it('breaks a full tie by ascending champion id, and caps at 5', () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ championId: 30 - i, masteryPoints: 1000, masteryLevel: 5 }));
    const bans = computeScoutingInsights(report([card({ puuid: 'a', championPool: pool })])).banRecommendations;
    expect(bans).toHaveLength(MAX_BAN_RECOMMENDATIONS);
    expect(bans.map((b) => b.championId)).toEqual([23, 24, 25, 26, 27]);
  });

  it('draws candidates from recent form even when not in any champion pool', () => {
    const bans = computeScoutingInsights(
      report([card({ puuid: 'a', recentForm: [match('m1', 99, true, ['a'])] })]),
    ).banRecommendations;
    expect(bans.map((b) => b.championId)).toEqual([99]);
    expect(bans[0]).toMatchObject({ masteryPoints: 0, recentGames: 1, recentWins: 1, puuid: 'a' });
  });
});

describe('computeScoutingInsights — position mismatches (Requirement 3.4/3.5/3.6)', () => {
  it('flags a member whose observed role differs from their declared position', () => {
    const m = computeScoutingInsights(
      report([
        card({ puuid: 'a', declaredPosition: 'TOP', observedRole: 'JUNGLE', recentForm: [match('m1', 1, true, ['a'], 'JUNGLE')] }),
        card({ puuid: 'b', declaredPosition: 'MIDDLE', observedRole: 'MIDDLE', recentForm: [match('m2', 2, true, ['b'])] }),
      ]),
    ).positionMismatches;
    expect(m).toEqual([{ puuid: 'a', declaredPosition: 'TOP', observedRole: 'JUNGLE' }]);
  });

  it('never flags an UNSELECTED or FILL declaration', () => {
    const m = computeScoutingInsights(
      report([
        card({ puuid: 'a', declaredPosition: 'FILL', observedRole: 'TOP', recentForm: [match('m1', 1, true, ['a'], 'TOP')] }),
        card({ puuid: 'b', declaredPosition: 'UNSELECTED', observedRole: 'TOP', recentForm: [match('m2', 2, true, ['b'], 'TOP')] }),
      ]),
    ).positionMismatches;
    expect(m).toEqual([]);
  });

  it('never flags a member with an empty recent form', () => {
    const m = computeScoutingInsights(
      report([card({ puuid: 'a', declaredPosition: 'TOP', observedRole: null, recentForm: [] })]),
    ).positionMismatches;
    expect(m).toEqual([]);
  });
});

describe('computeScoutingInsights — stack cohesion (Requirement 3.7)', () => {
  it('counts members who appear together in at least one recent match', () => {
    const together = match('shared', 1, true, ['a', 'b', 'c', 'x', 'y']);
    const r = report([
      card({ puuid: 'a', recentForm: [together] }),
      card({ puuid: 'b', recentForm: [together] }),
      card({ puuid: 'c', recentForm: [together, match('solo', 2, true, ['c', 'z'])] }),
      card({ puuid: 'd', recentForm: [match('d-solo', 3, true, ['d', 'w'])] }),
      card({ puuid: 'e', recentForm: [] }),
    ]);
    expect(computeScoutingInsights(r).stackCohesion).toBe(3);
  });

  it('is 0 when nobody shares a match', () => {
    const r = report([
      card({ puuid: 'a', recentForm: [match('m1', 1, true, ['a', 'x'])] }),
      card({ puuid: 'b', recentForm: [match('m2', 2, true, ['b', 'y'])] }),
    ]);
    expect(computeScoutingInsights(r).stackCohesion).toBe(0);
  });
});

describe('computeScoutingInsights — purity (Requirement 3.8)', () => {
  it('returns an equal result on repeated invocation', () => {
    const r = report([
      card({
        puuid: 'a',
        declaredPosition: 'TOP',
        observedRole: 'MIDDLE',
        championPool: [{ championId: 5, masteryPoints: 9000, masteryLevel: 6 }],
        recentForm: [match('m1', 5, true, ['a', 'b']), match('m2', 7, false, ['a', 'b'])],
      }),
      card({ puuid: 'b', recentForm: [match('m1', 9, true, ['a', 'b'])] }),
    ]);
    expect(computeScoutingInsights(r)).toEqual(computeScoutingInsights(r));
  });
});
