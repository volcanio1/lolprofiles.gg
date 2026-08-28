import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCacheStore } from '../cache';
import type { RegionResolver } from '../regionResolver';
import type { RiotApiClient, RiotApiResult } from '../riotApiClient';
import { createLiveGameOrchestrator, type LiveGameOrchestratorOptions } from './orchestrator';
import type { ParticipantEnricher } from './enricher';
import type { CurrentGameInfo, ParticipantCard } from './types';

const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });

const RESOLVED: RegionResolver = { resolve: () => Promise.resolve({ kind: 'resolved', platform: 'na1', region: 'americas' }) };

const PASSTHROUGH_ENRICHER: ParticipantEnricher = {
  enrichAll: (_platform, _region, participants) =>
    Promise.resolve(
      participants.map(
        (p): ParticipantCard => ({
          puuid: p.puuid,
          teamId: p.teamId,
          championId: p.championId,
          spell1Id: p.spell1Id,
          spell2Id: p.spell2Id,
          perkIds: p.perks?.perkIds ?? [],
          isBot: p.bot,
          riotId: null,
          rankedEntries: null,
          championMasteryPoints: p.championId === 99 ? 5_000 : null,
          championMasteryLevel: null,
        }),
      ),
    ),
};

function currentGame(overrides: Partial<CurrentGameInfo> = {}): CurrentGameInfo {
  return {
    gameId: 4567,
    platformId: 'NA1',
    gameStartTime: 1_700_000_000_000,
    gameLength: 600,
    gameMode: 'CLASSIC',
    gameType: 'MATCHED_GAME',
    mapId: 11,
    gameQueueConfigId: 420,
    bannedChampions: [
      { championId: 1, teamId: 100, pickTurn: 1 },
      { championId: -1, teamId: 200, pickTurn: 2 },
    ],
    participants: [
      { puuid: 'a', teamId: 100, championId: 99, spell1Id: 4, spell2Id: 7, bot: false, perks: { perkIds: [1], perkStyle: 8000, perkSubStyle: 8100 } },
      { puuid: 'b', teamId: 200, championId: 12, spell1Id: 4, spell2Id: 14, bot: false },
    ],
    ...overrides,
  };
}

interface ClientOverrides {
  account?: () => RiotApiResult<{ puuid: string; gameName: string; tagLine: string }>;
  active?: () => RiotApiResult<CurrentGameInfo>;
}

function fakeClient(overrides: ClientOverrides = {}) {
  const reject = () => Promise.reject(new Error('not used'));
  const getActiveGameByPuuid = vi.fn(() => Promise.resolve(overrides.active?.() ?? ok(currentGame())));
  const getAccountByRiotId = vi.fn(() =>
    Promise.resolve(overrides.account?.() ?? ok({ puuid: 'puuid-a', gameName: 'A', tagLine: 'NA1' })),
  );
  const client = {
    getAccountByRiotId,
    getRegionByPuuid: reject,
    getSummonerByPuuid: reject,
    getLeagueEntriesByPuuid: reject,
    getMatchIdsByPuuid: reject,
    getMatchById: reject,
    getMatchTimeline: reject,
    getActiveGameByPuuid,
    getAccountByPuuid: reject,
    getChampionMastery: reject,
  } as unknown as RiotApiClient;
  return { client, getActiveGameByPuuid, getAccountByRiotId };
}

function makeOrchestrator(overrides: Partial<LiveGameOrchestratorOptions> & { client: RiotApiClient }) {
  return createLiveGameOrchestrator({
    cache: createInMemoryCacheStore({ now: () => 1_000 }),
    now: () => 1_000,
    regionResolver: RESOLVED,
    enricher: PASSTHROUGH_ENRICHER,
    ...overrides,
  });
}

const RIOT_ID = { gameName: 'A', tagLine: 'NA1' };

describe('createLiveGameOrchestrator.getLiveGame', () => {
  it('assembles an in_game lobby: derived matchId, banned champions, insights', async () => {
    const { client } = fakeClient();
    const result = await makeOrchestrator({ client }).getLiveGame(RIOT_ID);

    expect(result.kind).toBe('in_game');
    if (result.kind !== 'in_game') return;
    expect(result.lobby.matchId).toBe('NA1_4567');
    expect(result.lobby.queueId).toBe(420);
    expect(result.lobby.bannedChampionIds).toEqual([1]); // -1 (no ban) dropped
    expect(result.lobby.participants.map((c) => c.puuid)).toEqual(['a', 'b']);
    // champion 99 has 5000 mastery + a ranked-less card => off-champion needs a record; here mastery record exists.
    expect(result.lobby.insights.offChampion).toEqual(['a']);
  });

  it('treats a zero start timestamp as Pre_Game (null), not a clock', async () => {
    const { client } = fakeClient({ active: () => ok(currentGame({ gameStartTime: 0 })) });
    const result = await makeOrchestrator({ client }).getLiveGame(RIOT_ID);
    expect(result.kind).toBe('in_game');
    if (result.kind !== 'in_game') return;
    expect(result.lobby.gameStartTime).toBeNull();
  });

  it('returns not_in_game (a state, no error) on a Spectator-V5 404, and does not cache the absence', async () => {
    const { client, getActiveGameByPuuid } = fakeClient({ active: () => ({ kind: 'not_found' }) });
    const orchestrator = makeOrchestrator({ client });

    expect(await orchestrator.getLiveGame(RIOT_ID)).toEqual({ kind: 'not_in_game' });
    await orchestrator.getLiveGame(RIOT_ID);
    // second call re-queries Riot rather than being answered from a cached 404
    expect(getActiveGameByPuuid).toHaveBeenCalledTimes(2);
  });

  it('serves a cached active game within the 30s TTL without a second Spectator call', async () => {
    const { client, getActiveGameByPuuid } = fakeClient();
    const orchestrator = makeOrchestrator({ client });
    await orchestrator.getLiveGame(RIOT_ID);
    await orchestrator.getLiveGame(RIOT_ID);
    expect(getActiveGameByPuuid).toHaveBeenCalledTimes(1);
  });

  it('maps account not-found to PLAYER_NOT_FOUND', async () => {
    const { client } = fakeClient({ account: () => ({ kind: 'not_found' }) });
    expect(await makeOrchestrator({ client }).getLiveGame(RIOT_ID)).toEqual({
      kind: 'error',
      code: 'PLAYER_NOT_FOUND',
      retriable: false,
    });
  });

  it('maps region-resolution outcomes through the shared error table', async () => {
    const { client } = fakeClient();
    const noAccount = makeOrchestrator({ client, regionResolver: { resolve: () => Promise.resolve({ kind: 'no_lol_account' }) } });
    expect(await noAccount.getLiveGame(RIOT_ID)).toEqual({ kind: 'error', code: 'NO_LOL_ACCOUNT', retriable: false });
  });

  it('maps a Spectator-V5 server error to a retriable RIOT_UNAVAILABLE and a timeout to TIMEOUT', async () => {
    const serverErr = fakeClient({ active: () => ({ kind: 'server_error', status: 502 }) });
    expect(await makeOrchestrator({ client: serverErr.client }).getLiveGame(RIOT_ID)).toEqual({
      kind: 'error',
      code: 'RIOT_UNAVAILABLE',
      retriable: true,
    });
    const timeout = fakeClient({ active: () => ({ kind: 'timeout' }) });
    expect(await makeOrchestrator({ client: timeout.client }).getLiveGame(RIOT_ID)).toEqual({
      kind: 'error',
      code: 'TIMEOUT',
      retriable: false,
    });
  });
});
