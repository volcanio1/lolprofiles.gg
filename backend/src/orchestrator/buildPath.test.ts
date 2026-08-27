import { describe, expect, it, vi, type Mock } from 'vitest';

import { createInMemoryCacheStore, TTL_BY_ENDPOINT } from '../cache';
import type { AccountDto, MatchDto, MatchTimelineDto, RiotApiClient, RiotApiResult } from '../riotApiClient';
import type { TimelineSlice } from '../insight/buildPath';
import { createBuildPathOrchestrator, type BuildPathOrchestratorOptions } from './buildPath';
import type { ParseGate } from './parseGate';

const RIOT_ID = { gameName: 'Build', tagLine: 'PATH' };
const PUUID = 'puuid-under-test';
const MATCH_ID = 'EUW1_7231636281'; // europe
const CLOCK = 1_000_000;

function accountOk(): RiotApiResult<AccountDto> {
  return { kind: 'ok', data: { puuid: PUUID, gameName: RIOT_ID.gameName, tagLine: RIOT_ID.tagLine } };
}

function timelineDto(events: MatchTimelineDto['info']['frames'][number]['events'], slot = 1): MatchTimelineDto {
  return {
    metadata: { matchId: MATCH_ID, participants: [PUUID] },
    info: {
      participants: [{ participantId: slot, puuid: PUUID }],
      frames: [
        { timestamp: 0, events: [] },
        { timestamp: 60_000, events },
      ],
    },
  };
}

function matchDetailWithItems(items: number[]): MatchDto {
  const [item0 = 0, item1 = 0, item2 = 0, item3 = 0, item4 = 0, item5 = 0] = items;
  return {
    metadata: { matchId: MATCH_ID, participants: [PUUID] },
    info: {
      queueId: 420,
      gameStartTimestamp: 1_700_000_000_000,
      gameDuration: 1_800,
      participants: [
        {
          puuid: PUUID,
          championName: 'Ahri',
          win: true,
          kills: 1,
          deaths: 1,
          assists: 1,
          visionScore: 1,
          item0,
          item1,
          item2,
          item3,
          item4,
          item5,
          item6: 0,
        },
      ],
    },
  };
}

interface Harness {
  options: BuildPathOrchestratorOptions;
  cache: ReturnType<typeof createInMemoryCacheStore>;
  getAccountByRiotId: Mock;
  getMatchTimeline: Mock;
  getMatchById: Mock;
  parseRuns: { count: number };
  unreconciled: Mock;
}

function harness(overrides: {
  account?: RiotApiResult<AccountDto>;
  timeline?: RiotApiResult<MatchTimelineDto>;
  matchDetail?: RiotApiResult<MatchDto>;
} = {}): Harness {
  const cache = createInMemoryCacheStore({ now: () => CLOCK });
  const getAccountByRiotId = vi.fn(() => Promise.resolve(overrides.account ?? accountOk()));
  const getMatchTimeline = vi.fn(() =>
    Promise.resolve(overrides.timeline ?? ({ kind: 'ok', data: timelineDto([]) } as RiotApiResult<MatchTimelineDto>)),
  );
  const getMatchById = vi.fn(() =>
    Promise.resolve(overrides.matchDetail ?? ({ kind: 'not_found' } as RiotApiResult<MatchDto>)),
  );
  const parseRuns = { count: 0 };
  const parseGate: ParseGate = {
    run: (task) => {
      parseRuns.count += 1;
      return task();
    },
  };
  const client = {
    getAccountByRiotId,
    getMatchTimeline,
    getMatchById,
  } as unknown as RiotApiClient;
  const unreconciled = vi.fn();

  return {
    cache,
    getAccountByRiotId,
    getMatchTimeline,
    getMatchById,
    parseRuns,
    unreconciled,
    options: {
      cache,
      riotApiClient: client,
      now: () => CLOCK,
      parseGate,
      discoveryRegion: 'americas',
      logger: { unreconciled },
    },
  };
}

describe('BuildPathOrchestrator.getBuildPath', () => {
  it('serves a cached slice without any Riot call', async () => {
    const h = harness();
    const slice: TimelineSlice = { matchId: MATCH_ID, puuid: PUUID, buildPath: [{ itemId: 1055, timestamp: 1 }], skillOrder: [1], reconciled: true };
    await h.cache.set(
      { endpoint: 'timelineSlice', routingValue: 'europe', params: { matchId: MATCH_ID, puuid: PUUID } },
      slice,
      TTL_BY_ENDPOINT.timelineSlice,
    );

    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);

    expect(result).toEqual({ kind: 'build_path', slice });
    expect(h.getMatchTimeline).not.toHaveBeenCalled();
    expect(h.parseRuns.count).toBe(0);
  });

  it('replays the timeline, reconciles against the cached match detail, and caches the slice', async () => {
    const h = harness({
      timeline: {
        kind: 'ok',
        data: timelineDto([
          { type: 'ITEM_PURCHASED', timestamp: 11_000, participantId: 1, itemId: 1055 },
          { type: 'ITEM_PURCHASED', timestamp: 480_000, participantId: 1, itemId: 3006 },
          { type: 'OTHER_EVENT', timestamp: 5_000 } as never,
        ]),
      },
    });
    await h.cache.set(
      { endpoint: 'matchDetail', routingValue: 'europe', params: { matchId: MATCH_ID } },
      matchDetailWithItems([1055, 3006]),
      TTL_BY_ENDPOINT.matchDetail,
    );

    const orchestrator = createBuildPathOrchestrator(h.options);
    const result = await orchestrator.getBuildPath(MATCH_ID, RIOT_ID);

    expect(result).toEqual({
      kind: 'build_path',
      slice: {
        matchId: MATCH_ID,
        puuid: PUUID,
        buildPath: [
          { itemId: 1055, timestamp: 11_000 },
          { itemId: 3006, timestamp: 480_000 },
        ],
        skillOrder: [],
        reconciled: true,
      },
    });
    expect(h.parseRuns.count).toBe(1);

    // Second call is a cache hit — no further timeline fetch.
    h.getMatchTimeline.mockClear();
    const again = await orchestrator.getBuildPath(MATCH_ID, RIOT_ID);
    expect(again.kind).toBe('build_path');
    expect(h.getMatchTimeline).not.toHaveBeenCalled();
  });

  it('includes the skill-level-up order in the slice', async () => {
    const h = harness({
      timeline: {
        kind: 'ok',
        data: timelineDto([
          { type: 'SKILL_LEVEL_UP', timestamp: 1000, participantId: 1, skillSlot: 3 },
          { type: 'ITEM_PURCHASED', timestamp: 2000, participantId: 1, itemId: 1055 },
          { type: 'SKILL_LEVEL_UP', timestamp: 3000, participantId: 1, skillSlot: 1 },
          { type: 'SKILL_LEVEL_UP', timestamp: 4000, participantId: 2, skillSlot: 4 },
        ]),
      },
    });

    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);

    expect(result).toMatchObject({ kind: 'build_path', slice: { skillOrder: [3, 1] } });
  });

  it('fetches the match detail on a cache miss and reconciles against it', async () => {
    const h = harness({
      timeline: {
        kind: 'ok',
        data: timelineDto([{ type: 'ITEM_PURCHASED', timestamp: 10_000, participantId: 1, itemId: 1055 }]),
      },
      matchDetail: { kind: 'ok', data: matchDetailWithItems([1055]) },
    });

    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);

    expect(h.getMatchById).toHaveBeenCalledWith('europe', MATCH_ID);
    expect(result).toMatchObject({ kind: 'build_path', slice: { reconciled: true } });
  });

  it('marks the slice unreconciled when the match detail cannot be obtained, and does NOT log a disagreement', async () => {
    const h = harness({
      timeline: {
        kind: 'ok',
        data: timelineDto([{ type: 'ITEM_PURCHASED', timestamp: 10_000, participantId: 1, itemId: 1055 }]),
      },
      matchDetail: { kind: 'not_found' },
    });

    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);

    expect(result).toEqual({
      kind: 'build_path',
      slice: { matchId: MATCH_ID, puuid: PUUID, buildPath: [{ itemId: 1055, timestamp: 10_000 }], skillOrder: [], reconciled: false },
    });
    expect(h.unreconciled).not.toHaveBeenCalled();
  });

  it('logs the diff both ways when the replay disagrees with the cached Final_Build, and still returns the path', async () => {
    const h = harness({
      timeline: {
        kind: 'ok',
        data: timelineDto([
          { type: 'ITEM_PURCHASED', timestamp: 10_000, participantId: 1, itemId: 1055 },
          { type: 'ITEM_PURCHASED', timestamp: 20_000, participantId: 1, itemId: 9999 },
        ]),
      },
    });
    // Final_Build reports 1055 and 3089 (Rabadon's); replay produced 1055 and 9999.
    await h.cache.set(
      { endpoint: 'matchDetail', routingValue: 'europe', params: { matchId: MATCH_ID } },
      matchDetailWithItems([1055, 3089]),
      TTL_BY_ENDPOINT.matchDetail,
    );

    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);

    expect(result.kind).toBe('build_path');
    expect(result).toMatchObject({ slice: { reconciled: false } });
    expect(h.unreconciled).toHaveBeenCalledWith({
      matchId: MATCH_ID,
      puuid: PUUID,
      missingFromReplay: [3089],
      unexpectedInReplay: [9999],
    });
  });

  it('returns unavailable:no_timeline on a 404 and caches nothing', async () => {
    const h = harness({ timeline: { kind: 'not_found' } });

    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);

    expect(result).toEqual({ kind: 'unavailable', reason: 'no_timeline' });
    const cached = await h.cache.get({
      endpoint: 'timelineSlice',
      routingValue: 'europe',
      params: { matchId: MATCH_ID, puuid: PUUID },
    });
    expect(cached).toBeUndefined();
  });

  it('returns unavailable:participant_absent when the PUUID is not in info.participants', async () => {
    const h = harness({
      timeline: { kind: 'ok', data: timelineDto([], 1) },
    });
    h.getMatchTimeline.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        metadata: { matchId: MATCH_ID, participants: ['someone-else'] },
        info: { participants: [{ participantId: 1, puuid: 'someone-else' }], frames: [] },
      },
    } as RiotApiResult<MatchTimelineDto>);

    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);

    expect(result).toEqual({ kind: 'unavailable', reason: 'participant_absent' });
  });

  it('rejects an unrecognised match id prefix as VALIDATION_FAILED', async () => {
    const h = harness();
    const result = await createBuildPathOrchestrator(h.options).getBuildPath('NOPE_123', RIOT_ID);
    expect(result).toEqual({ kind: 'error', code: 'VALIDATION_FAILED', retriable: false });
    expect(h.getAccountByRiotId).not.toHaveBeenCalled();
  });

  it('derives the region from a lowercase match id prefix', async () => {
    const h = harness({ timeline: { kind: 'not_found' } });
    await createBuildPathOrchestrator(h.options).getBuildPath('euw1_999', RIOT_ID);
    expect(h.getMatchTimeline).toHaveBeenCalledWith('europe', 'euw1_999');
  });

  it('maps an account not_found to PLAYER_NOT_FOUND', async () => {
    const h = harness({ account: { kind: 'not_found' } });
    const result = await createBuildPathOrchestrator(h.options).getBuildPath(MATCH_ID, RIOT_ID);
    expect(result).toEqual({ kind: 'error', code: 'PLAYER_NOT_FOUND', retriable: false });
    expect(h.getMatchTimeline).not.toHaveBeenCalled();
  });

  it('surfaces retriable and non-retriable timeline failures through the error table', async () => {
    const timeout = await createBuildPathOrchestrator(harness({ timeline: { kind: 'timeout' } }).options).getBuildPath(
      MATCH_ID,
      RIOT_ID,
    );
    expect(timeout).toEqual({ kind: 'error', code: 'TIMEOUT', retriable: false });

    const limited = await createBuildPathOrchestrator(
      harness({ timeline: { kind: 'rate_limited' } }).options,
    ).getBuildPath(MATCH_ID, RIOT_ID);
    expect(limited).toEqual({ kind: 'error', code: 'RATE_LIMITED', retriable: true });

    const server = await createBuildPathOrchestrator(
      harness({ timeline: { kind: 'server_error', status: 503 } }).options,
    ).getBuildPath(MATCH_ID, RIOT_ID);
    expect(server).toEqual({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true });
  });
});
