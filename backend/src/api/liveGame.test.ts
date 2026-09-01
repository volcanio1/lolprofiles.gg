import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import type { LiveGameOrchestrator, LiveGameResult } from '../liveGame/orchestrator';
import type { LiveGameLobby } from '../liveGame/types';
import { createApiRouter } from './index';

const stubLookup: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};
const stubBuildPath: BuildPathOrchestrator = {
  getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
};

function appWith(result: LiveGameResult) {
  const now = () => 1_000;
  const liveGameOrchestrator: LiveGameOrchestrator = { getLiveGame: () => Promise.resolve(result) };
  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubLookup,
      buildPathOrchestrator: stubBuildPath,
      liveGameOrchestrator,
      scoutingOrchestrator: { scout: () => Promise.resolve({ kind: 'not_registered' }) },
      cache: createInMemoryCacheStore({ now }),
      now,
      logger: { unexpectedError: () => undefined },
      dataDragonVersion: '16.17.1',
    }),
  );
  return app;
}

const LOBBY: LiveGameLobby = {
  gameId: 42,
  platformId: 'NA1',
  matchId: 'NA1_42',
  queueId: 420,
  mapId: 11,
  gameStartTime: 1_700_000_000_000,
  bannedChampionIds: [1, 2],
  participants: [],
  insights: { offChampion: [], oneTricks: [], rankSpread: null },
};

describe('GET /api/live-game', () => {
  it('returns 200 with the lobby when in a game', async () => {
    const res = await request(appWith({ kind: 'in_game', lobby: LOBBY }))
      .get('/api/live-game')
      .query({ gameName: 'Faker', tagLine: 'KR1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'in_game', lobby: LOBBY });
  });

  it('returns 200 with not_in_game — a state, not an error', async () => {
    const res = await request(appWith({ kind: 'not_in_game' }))
      .get('/api/live-game')
      .query({ gameName: 'Faker', tagLine: 'KR1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'not_in_game' });
  });

  it('400s when a query parameter is missing', async () => {
    const res = await request(appWith({ kind: 'not_in_game' })).get('/api/live-game').query({ gameName: 'Faker' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('tagLine');
  });

  it('400s on a Riot ID that fails validation', async () => {
    const res = await request(appWith({ kind: 'not_in_game' }))
      .get('/api/live-game')
      .query({ gameName: 'a'.repeat(100), tagLine: 'KR1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('maps PLAYER_NOT_FOUND to 404 echoing the submitted Riot ID', async () => {
    const res = await request(appWith({ kind: 'error', code: 'PLAYER_NOT_FOUND', retriable: false }))
      .get('/api/live-game')
      .query({ gameName: 'Nope', tagLine: 'NA1' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Nope');
  });

  it('maps UNSUPPORTED_PLATFORM to its message, naming the platform Riot reported', async () => {
    const res = await request(appWith({ kind: 'error', code: 'UNSUPPORTED_PLATFORM', retriable: false, platform: 'pbe1' }))
      .get('/api/live-game')
      .query({ gameName: 'A', tagLine: 'B' });
    expect(res.body.error.code).toBe('UNSUPPORTED_PLATFORM');
    expect(res.body.error.message).toContain('pbe1');
  });

  it('maps RATE_LIMITED to 429 with a Retry-After header', async () => {
    const res = await request(appWith({ kind: 'error', code: 'RATE_LIMITED', retriable: true }))
      .get('/api/live-game')
      .query({ gameName: 'A', tagLine: 'B' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('maps a retriable RIOT_UNAVAILABLE through the shared table', async () => {
    const res = await request(appWith({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }))
      .get('/api/live-game')
      .query({ gameName: 'A', tagLine: 'B' });
    expect(res.status).toBe(503);
    expect(res.body.error.retriable).toBe(true);
  });
});
