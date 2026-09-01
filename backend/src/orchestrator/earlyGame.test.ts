import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCacheStore } from '../cache';
import type { MatchDto, MatchTimelineDto, RiotApiClient, RiotApiResult } from '../riotApiClient';
import { createEarlyGameProvider } from './earlyGame';

const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });

function participant(over: Partial<MatchDto['info']['participants'][number]> & { puuid: string }) {
  return {
    championName: 'Filler',
    teamPosition: 'TOP',
    teamId: 100,
    win: true,
    kills: 0,
    deaths: 0,
    assists: 0,
    visionScore: 0,
    ...over,
  };
}

function matchDto(overrides: { selfPuuid?: string; rivalPuuid?: string | null } = {}): MatchDto {
  const selfPuuid = overrides.selfPuuid ?? 'self';
  const rivalPuuid = overrides.rivalPuuid === undefined ? 'rival' : overrides.rivalPuuid;
  return {
    metadata: { matchId: 'NA1_1', participants: [selfPuuid, rivalPuuid ?? 'x'].filter(Boolean) as string[] },
    info: {
      queueId: 420,
      gameStartTimestamp: 0,
      gameDuration: 1_800,
      participants: [
        participant({ puuid: selfPuuid, teamId: 100, teamPosition: 'MIDDLE' }),
        ...(rivalPuuid !== null
          ? [participant({ puuid: rivalPuuid, teamId: 200, teamPosition: 'MIDDLE' })]
          : [participant({ puuid: 'other', teamId: 200, teamPosition: 'TOP' })]),
      ],
    },
  };
}

function timelineDto(over: Partial<MatchTimelineDto> = {}): MatchTimelineDto {
  return {
    metadata: { matchId: 'NA1_1', participants: ['self', 'rival'] },
    info: {
      participants: [
        { participantId: 1, puuid: 'self' },
        { participantId: 2, puuid: 'rival' },
      ],
      frames: [
        {
          timestamp: 600_000,
          events: [{ type: 'CHAMPION_KILL', timestamp: 300_000, victimId: 1 }],
          participantFrames: {
            '1': { totalGold: 2_000, minionsKilled: 40, jungleMinionsKilled: 0 },
            '2': { totalGold: 2_800, minionsKilled: 55, jungleMinionsKilled: 0 },
          },
        },
      ],
    },
    ...over,
  };
}

function fakeClient(timelineResult: RiotApiResult<MatchTimelineDto>) {
  const reject = () => Promise.reject(new Error('not used'));
  const getMatchTimeline = vi.fn(() => Promise.resolve(timelineResult));
  const client = {
    getAccountByRiotId: reject,
    getRegionByPuuid: reject,
    getSummonerByPuuid: reject,
    getLeagueEntriesByPuuid: reject,
    getMatchIdsByPuuid: reject,
    getMatchById: reject,
    getMatchTimeline,
    getActiveGameByPuuid: reject,
    getAccountByPuuid: reject,
    getChampionMastery: reject,
    getClashPlayersByPuuid: reject,
    getClashTeam: reject,
    getClashTournamentsByTeam: reject,
    getChampionMasteryTop: reject,
  } as unknown as RiotApiClient;
  return { client, getMatchTimeline };
}

describe('createEarlyGameProvider.getAggregate', () => {
  it('computes lane-phase deaths and gold/CS diff vs the resolved lane opponent', async () => {
    const { client } = fakeClient(ok(timelineDto()));
    const provider = createEarlyGameProvider({ client, cache: createInMemoryCacheStore({ now: () => 1_000 }) });

    const result = await provider.getAggregate('americas', matchDto(), 'self');
    expect(result).toEqual({ matchId: 'NA1_1', lanePhaseDeaths: 1, goldDiffAt10: 2_000 - 2_800, csDiffAt10: 40 - 55 });
  });

  it('caches the computed aggregate so a second call issues no further timeline fetch', async () => {
    const { client, getMatchTimeline } = fakeClient(ok(timelineDto()));
    const cache = createInMemoryCacheStore({ now: () => 1_000 });
    const provider = createEarlyGameProvider({ client, cache });

    await provider.getAggregate('americas', matchDto(), 'self');
    await provider.getAggregate('americas', matchDto(), 'self');
    expect(getMatchTimeline).toHaveBeenCalledTimes(1);
  });

  it('returns a null-valued aggregate, and does NOT cache it, when the timeline is unavailable', async () => {
    const { client, getMatchTimeline } = fakeClient({ kind: 'not_found' });
    const cache = createInMemoryCacheStore({ now: () => 1_000 });
    const provider = createEarlyGameProvider({ client, cache });

    const result = await provider.getAggregate('americas', matchDto(), 'self');
    expect(result).toEqual({ matchId: 'NA1_1', lanePhaseDeaths: null, goldDiffAt10: null, csDiffAt10: null });

    await provider.getAggregate('americas', matchDto(), 'self');
    expect(getMatchTimeline).toHaveBeenCalledTimes(2); // not cached -> retried
  });

  it('leaves goldDiffAt10/csDiffAt10 null when no lane opponent is identified, but still computes lanePhaseDeaths', async () => {
    const { client } = fakeClient(ok(timelineDto()));
    const provider = createEarlyGameProvider({ client, cache: createInMemoryCacheStore({ now: () => 1_000 }) });

    const result = await provider.getAggregate('americas', matchDto({ rivalPuuid: null }), 'self');
    expect(result?.lanePhaseDeaths).toBe(1);
    expect(result?.goldDiffAt10).toBeNull();
    expect(result?.csDiffAt10).toBeNull();
  });

  it('returns undefined when the analyzed player has no row in the given match', async () => {
    const { client } = fakeClient(ok(timelineDto()));
    const provider = createEarlyGameProvider({ client, cache: createInMemoryCacheStore({ now: () => 1_000 }) });

    const result = await provider.getAggregate('americas', matchDto(), 'someone-else');
    expect(result).toBeUndefined();
  });
});
