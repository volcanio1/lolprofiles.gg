/**
 * clash-scouting task 10.2 — full Scouting Report assembly over the REAL stack.
 *
 * `createApiRouter` down is production code: the route, the Scouting
 * Orchestrator, the Region Resolver, the Roster Enricher, the Scouting Insight
 * Engine, the cache store, the rate limit manager and the Riot API client. The
 * only substitution is the HTTP transport, which serves canned Riot payloads —
 * same discipline as `liveGame/integration.test.ts`.
 *
 * The five-member roster exercises every degradation path design.md's Testing
 * Strategy calls out at once: a League-V4 failure (p3), a Recent_Form with two
 * individually-failing match retrievals (p2, alongside its one success driving
 * an observed-role mismatch against its declared position), a FILL declaration
 * that must never be flagged regardless of what it plays (p4), and two members
 * who share a match and so count toward Stack_Cohesion (p4, p5).
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApiRouter } from '../api';
import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import { createLiveGameOrchestrator } from '../liveGame/orchestrator';
import { createRateLimitManager } from '../rateLimit';
import { createRiotApiClient, type RiotHttpResponse, type RiotHttpTransport } from '../riotApiClient';
import { createScoutingOrchestrator } from './orchestrator';

const API_KEY = 'RGAPI-clash-integration-fake';
const SEARCHER_PUUID = 'p1'; // the captain; the visitor scouts by naming them.
const TEAM_ID = 'team-1';

function headers() {
  return { get: () => null };
}
function json(status: number, body: unknown): RiotHttpResponse {
  return { status, headers: headers(), json: () => Promise.resolve(body) };
}

const TEAM = {
  id: TEAM_ID,
  tournamentId: 500,
  name: 'Test Team',
  iconId: 1,
  tier: 1,
  captain: 'p1',
  abbreviation: 'TST',
  players: [
    { puuid: 'p1', position: 'TOP', role: 'CAPTAIN' },
    { puuid: 'p2', position: 'JUNGLE', role: 'MEMBER' },
    { puuid: 'p3', position: 'MIDDLE', role: 'MEMBER' },
    { puuid: 'p4', position: 'FILL', role: 'MEMBER' },
    { puuid: 'p5', position: 'BOTTOM', role: 'MEMBER' },
  ],
};

const MATCH_IDS_BY_PUUID: Record<string, string[]> = {
  p1: ['M1'],
  p2: ['M2a', 'M2b', 'M2c'],
  p3: [],
  p4: ['M_shared'],
  p5: ['M_shared'],
};

function matchDetail(matchId: string): { status: number; body: unknown } | undefined {
  if (matchId === 'M1') {
    return {
      status: 200,
      body: {
        metadata: { matchId, participants: ['p1', 'x1', 'x2'] },
        info: {
          queueId: 700,
          gameStartTimestamp: 0,
          gameDuration: 1_800,
          participants: [{ puuid: 'p1', championName: 'Aatrox', championId: 266, teamPosition: 'TOP', win: true, kills: 0, deaths: 0, assists: 0, visionScore: 0 }],
        },
      },
    };
  }
  if (matchId === 'M2a') {
    return {
      status: 200,
      body: {
        metadata: { matchId, participants: ['p2', 'x1', 'x2'] },
        info: {
          queueId: 700,
          gameStartTimestamp: 0,
          gameDuration: 1_800,
          participants: [{ puuid: 'p2', championName: 'Ahri', championId: 103, teamPosition: 'MIDDLE', win: true, kills: 0, deaths: 0, assists: 0, visionScore: 0 }],
        },
      },
    };
  }
  if (matchId === 'M2b') {
    return { status: 500, body: {} }; // individually-failing retrieval (server_error)
  }
  if (matchId === 'M2c') {
    return { status: 404, body: {} }; // individually-failing retrieval (not_found)
  }
  if (matchId === 'M_shared') {
    return {
      status: 200,
      body: {
        metadata: { matchId, participants: ['p4', 'p5', 'x1', 'x2'] },
        info: {
          queueId: 700,
          gameStartTimestamp: 0,
          gameDuration: 1_800,
          participants: [
            { puuid: 'p4', championName: 'Jinx', championId: 222, teamPosition: 'BOTTOM', win: true, kills: 0, deaths: 0, assists: 0, visionScore: 0 },
            { puuid: 'p5', championName: 'Lulu', championId: 117, teamPosition: 'BOTTOM', win: true, kills: 0, deaths: 0, assists: 0, visionScore: 0 },
          ],
        },
      },
    };
  }
  return undefined;
}

function leagueBodyFor(puuid: string): { status: number; body: unknown } {
  if (puuid === 'p3') {
    return { status: 500, body: {} }; // Requirement 2.5: League-V4 failure
  }
  return { status: 200, body: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 10, losses: 10 }] };
}

function makeApp() {
  const now = () => 1_700_000_100_000;

  const transport: RiotHttpTransport = (url) => {
    if (url.includes('/riot/account/v1/accounts/by-riot-id/')) {
      return Promise.resolve(json(200, { puuid: SEARCHER_PUUID, gameName: 'Captain', tagLine: 'NA1' }));
    }
    if (url.includes('/riot/account/v1/region/by-game/')) {
      return Promise.resolve(json(200, { puuid: SEARCHER_PUUID, game: 'lol', region: 'na1' }));
    }
    if (url.includes('/lol/clash/v1/players/by-puuid/')) {
      return Promise.resolve(json(200, [{ puuid: SEARCHER_PUUID, teamId: TEAM_ID, position: 'TOP', role: 'CAPTAIN' }]));
    }
    if (url.includes(`/lol/clash/v1/teams/${TEAM_ID}`)) {
      return Promise.resolve(json(200, TEAM));
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
    const masteryTop = /\/champion-masteries\/by-puuid\/([^/]+)\/top/.exec(url);
    if (masteryTop !== null) {
      return Promise.resolve(json(200, [{ championId: 1, championLevel: 7, championPoints: 10_000 }]));
    }
    const matchIds = /\/lol\/match\/v5\/matches\/by-puuid\/([^/]+)\/ids/.exec(url);
    if (matchIds !== null) {
      return Promise.resolve(json(200, MATCH_IDS_BY_PUUID[matchIds[1]] ?? []));
    }
    const matchById = /\/lol\/match\/v5\/matches\/([^/?]+)$/.exec(url);
    if (matchById !== null) {
      const found = matchDetail(matchById[1]);
      return Promise.resolve(found === undefined ? json(404, {}) : json(found.status, found.body));
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

describe('GET /api/clash/scout — mixed-roster integration', () => {
  it('assembles five cards in roster order with a bounded ban list, one mismatch and the expected stack cohesion', async () => {
    const res = await request(makeApp()).get('/api/clash/scout').query({ gameName: 'Captain', tagLine: 'NA1' });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('report');
    const report = res.body.report;

    expect(report.team).toMatchObject({ id: TEAM_ID, name: 'Test Team', captainPuuid: 'p1' });
    // Requirement 4.4: no tournamentSchedule cache entry was ever seeded.
    expect(report.tournament).toBeNull();
    expect(report.roster.map((card: { puuid: string }) => card.puuid)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);

    const byPuuid = Object.fromEntries(report.roster.map((c: { puuid: string }) => [c.puuid, c]));

    // p3: League-V4 failed -> null, distinct from a successful empty/unranked result.
    expect(byPuuid.p3.rankedEntries).toBeNull();
    expect(byPuuid.p1.rankedEntries[0].tier).toBe('GOLD');

    // p2: one individually-successful match (M2a) out of three requested; the
    // other two (server_error, not_found) are excluded, not fatal.
    expect(byPuuid.p2.recentForm).toHaveLength(1);
    expect(byPuuid.p2.recentForm[0].matchId).toBe('M2a');

    // Requirement 3.4: p2 declared JUNGLE but played MIDDLE -> flagged. Exactly one mismatch.
    expect(report.insights.positionMismatches).toEqual([
      { puuid: 'p2', declaredPosition: 'JUNGLE', observedRole: 'MIDDLE' },
    ]);
    // p4 (FILL) is never flagged regardless of what it plays (Requirement 3.5).
    expect(report.insights.positionMismatches.some((m: { puuid: string }) => m.puuid === 'p4')).toBe(false);

    // Requirement 3.7: p4 and p5 share match M_shared -> both count toward cohesion.
    expect(report.insights.stackCohesion).toBe(2);

    // Requirement 3.3: at most 5 recommendations.
    expect(report.insights.banRecommendations.length).toBeLessThanOrEqual(5);
  });
});
