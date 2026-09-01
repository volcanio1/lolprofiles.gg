/**
 * live-game task 10.1 — full Live Game assembly over the REAL stack.
 *
 * `createApiRouter` down is production code: the route, the Live Game
 * Orchestrator, the Region Resolver, the Participant Enricher, the Lobby Insight
 * Engine, the cache store, the rate limit manager and the Riot API client. The
 * only substitution is the HTTP transport, which serves canned Riot payloads.
 *
 * The mixed lobby exercises every enrichment outcome at once: a bot, an unranked
 * player, a player whose League-V4 call fails, a one-trick and an off-champion.
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApiRouter } from '../api';
import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import { createRateLimitManager } from '../rateLimit';
import { createRiotApiClient, type RiotHttpResponse, type RiotHttpTransport } from '../riotApiClient';
import { createLiveGameOrchestrator } from './orchestrator';
import { createScoutingOrchestrator } from '../clashScouting/orchestrator';

const API_KEY = 'RGAPI-livegame-integration-fake';
const SEARCHER_PUUID = 'puuid-searcher';

// puuid -> the enrichment shape it should get.
const PARTICIPANTS = [
  { puuid: 'p0', championId: 1, teamId: 100, bot: false, tier: 'GOLD', mastery: 60_000 },
  { puuid: 'p1', championId: 2, teamId: 100, bot: true, tier: null, mastery: null },
  { puuid: 'p2', championId: 3, teamId: 100, bot: false, tier: 'unranked', mastery: 30_000 },
  { puuid: 'p3', championId: 4, teamId: 100, bot: false, tier: 'league-fail', mastery: 40_000 },
  { puuid: 'p4', championId: 5, teamId: 100, bot: false, tier: 'PLATINUM', mastery: 250_000 }, // one-trick
  { puuid: 'p5', championId: 6, teamId: 200, bot: false, tier: 'SILVER', mastery: 5_000 }, // off-champion
  { puuid: 'p6', championId: 7, teamId: 200, bot: false, tier: 'DIAMOND', mastery: 80_000 },
  { puuid: 'p7', championId: 8, teamId: 200, bot: false, tier: 'GOLD', mastery: 70_000 },
  { puuid: 'p8', championId: 9, teamId: 200, bot: false, tier: 'GOLD', mastery: 55_000 },
  { puuid: 'p9', championId: 10, teamId: 200, bot: false, tier: 'unranked', mastery: 20_000 },
] as const;

function headers() {
  return { get: () => null };
}
function json(status: number, body: unknown): RiotHttpResponse {
  return { status, headers: headers(), json: () => Promise.resolve(body) };
}

function currentGameInfo() {
  return {
    gameId: 987654,
    platformId: 'NA1',
    gameStartTime: 1_700_000_000_000,
    gameLength: 600,
    gameMode: 'CLASSIC',
    gameType: 'MATCHED_GAME',
    mapId: 11,
    gameQueueConfigId: 420,
    bannedChampions: [
      { championId: 200, teamId: 100, pickTurn: 1 },
      { championId: -1, teamId: 200, pickTurn: 2 },
    ],
    participants: PARTICIPANTS.map((p) => ({
      puuid: p.puuid,
      teamId: p.teamId,
      championId: p.championId,
      spell1Id: 4,
      spell2Id: 7,
      bot: p.bot,
      perks: { perkIds: [8005, 9111], perkStyle: 8000, perkSubStyle: 8100 },
    })),
  };
}

function leagueBodyFor(puuid: string): { status: number; body: unknown } {
  const spec = PARTICIPANTS.find((p) => p.puuid === puuid);
  if (spec === undefined || spec.tier === 'league-fail') {
    return { status: 500, body: {} };
  }
  if (spec.tier === 'unranked' || spec.tier === null) {
    return { status: 200, body: [] };
  }
  return {
    status: 200,
    body: [{ queueType: 'RANKED_SOLO_5x5', tier: spec.tier, rank: 'II', leaguePoints: 40, wins: 10, losses: 10 }],
  };
}

function masteryBodyFor(puuid: string, championId: number): { status: number; body: unknown } {
  const spec = PARTICIPANTS.find((p) => p.puuid === puuid);
  if (spec === undefined || spec.mastery === null) {
    return { status: 404, body: {} };
  }
  return { status: 200, body: { championId, championLevel: 7, championPoints: spec.mastery } };
}

function makeApp() {
  const now = () => 1_700_000_100_000;

  const transport: RiotHttpTransport = (url) => {
    if (url.includes('/riot/account/v1/accounts/by-riot-id/')) {
      return Promise.resolve(json(200, { puuid: SEARCHER_PUUID, gameName: 'Watcher', tagLine: 'NA1' }));
    }
    if (url.includes('/riot/account/v1/region/by-game/')) {
      return Promise.resolve(json(200, { puuid: SEARCHER_PUUID, game: 'lol', region: 'na1' }));
    }
    if (url.includes('/lol/spectator/v5/active-games/by-summoner/')) {
      return Promise.resolve(json(200, currentGameInfo()));
    }
    const byPuuidAccount = /\/riot\/account\/v1\/accounts\/by-puuid\/([^/?]+)/.exec(url);
    if (byPuuidAccount !== null) {
      const puuid = byPuuidAccount[1];
      return Promise.resolve(json(200, { puuid, gameName: `Name-${puuid}`, tagLine: 'NA1' }));
    }
    const league = /\/lol\/league\/v4\/entries\/by-puuid\/([^/?]+)/.exec(url);
    if (league !== null) {
      const { status, body } = leagueBodyFor(league[1]);
      return Promise.resolve(json(status, body));
    }
    const mastery = /\/champion-masteries\/by-puuid\/([^/]+)\/by-champion\/([^/?]+)/.exec(url);
    if (mastery !== null) {
      const { status, body } = masteryBodyFor(mastery[1], Number(mastery[2]));
      return Promise.resolve(json(status, body));
    }
    return Promise.resolve(json(404, {}));
  };

  const cache = createInMemoryCacheStore({ now });
  const riotApiClient = createRiotApiClient({
    fetch: transport,
    apiKey: API_KEY,
    rateLimitManager: createRateLimitManager({ now, sleep: () => Promise.resolve() }),
    now,
    scheduleTimeout: () => () => undefined,
    sleep: () => Promise.resolve(),
  });

  const stubLookup: LookupOrchestrator = {
    runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
  };
  const stubBuildPath: BuildPathOrchestrator = {
    getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
  };

  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubLookup,
      buildPathOrchestrator: stubBuildPath,
      liveGameOrchestrator: createLiveGameOrchestrator({ client: riotApiClient, cache, now }),
      scoutingOrchestrator: createScoutingOrchestrator({ client: riotApiClient, cache, now }),
      cache,
      now,
      logger: { unexpectedError: () => undefined },
      dataDragonVersion: '16.17.1',
    }),
  );
  return app;
}

describe('GET /api/live-game — mixed-lobby integration', () => {
  it('assembles ten cards in order with the expected per-participant enrichment and insight set', async () => {
    const res = await request(makeApp()).get('/api/live-game').query({ gameName: 'Watcher', tagLine: 'NA1' });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('in_game');
    const lobby = res.body.lobby;

    expect(lobby.matchId).toBe('NA1_987654');
    expect(lobby.bannedChampionIds).toEqual([200]); // -1 dropped
    expect(lobby.participants.map((c: { puuid: string }) => c.puuid)).toEqual(PARTICIPANTS.map((p) => p.puuid));

    const byPuuid = Object.fromEntries(
      lobby.participants.map((c: { puuid: string }) => [c.puuid, c]),
    );

    // bot: no enrichment
    expect(byPuuid.p1).toMatchObject({ isBot: true, riotId: null, rankedEntries: null, championMasteryPoints: null });
    // unranked: successful empty League result
    expect(byPuuid.p2.rankedEntries).toEqual([]);
    // League call failed: null, distinct from unranked
    expect(byPuuid.p3.rankedEntries).toBeNull();
    // a resolved player carries its Riot ID + ranked entry + mastery
    expect(byPuuid.p0.riotId).toEqual({ gameName: 'Name-p0', tagLine: 'NA1' });
    expect(byPuuid.p0.rankedEntries[0].tier).toBe('GOLD');
    expect(byPuuid.p0.championMasteryPoints).toBe(60_000);

    expect(lobby.insights.oneTricks).toEqual(['p4']);
    expect(lobby.insights.offChampion).toEqual(['p5']);
    // ranked in solo queue: p0 GOLD, p4 PLATINUM, p5 SILVER, p6 DIAMOND, p7/p8 GOLD
    expect(lobby.insights.rankSpread).toEqual({ highest: 'DIAMOND', lowest: 'SILVER' });
  });
});
