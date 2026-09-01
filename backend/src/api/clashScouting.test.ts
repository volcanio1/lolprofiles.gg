import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { ScoutingOrchestrator } from '../clashScouting/orchestrator';
import type { ScoutingResult } from '../clashScouting/orchestrator';
import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import { createApiRouter } from './index';

const stubLookup: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};
const stubBuildPath: BuildPathOrchestrator = {
  getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
};

function appWith(result: ScoutingResult) {
  const now = () => 1_000;
  const scoutingOrchestrator: ScoutingOrchestrator = { scout: () => Promise.resolve(result) };
  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubLookup,
      buildPathOrchestrator: stubBuildPath,
      liveGameOrchestrator: { getLiveGame: () => Promise.resolve({ kind: 'not_in_game' }) },
      scoutingOrchestrator,
      cache: createInMemoryCacheStore({ now }),
      now,
      logger: { unexpectedError: () => undefined },
      dataDragonVersion: '16.17.1',
    }),
  );
  return app;
}

const REPORT: ScoutingResult & { kind: 'report' } = {
  kind: 'report',
  report: {
    team: { id: 't1', name: 'Team', abbreviation: 'TM', tier: 1, iconId: 1, captainPuuid: 'a' },
    tournament: null,
    roster: [],
    insights: { banRecommendations: [], positionMismatches: [], stackCohesion: 0 },
  },
};

describe('GET /api/clash/scout', () => {
  it('rejects a request with no gameName', async () => {
    const res = await request(appWith(REPORT)).get('/api/clash/scout').query({ tagLine: 'NA1' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('gameName');
  });

  it('rejects a request with no tagLine', async () => {
    const res = await request(appWith(REPORT)).get('/api/clash/scout').query({ gameName: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('tagLine');
  });

  it('rejects an invalid Riot ID', async () => {
    const res = await request(appWith(REPORT)).get('/api/clash/scout').query({ gameName: 'A', tagLine: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 200 with a report', async () => {
    const res = await request(appWith(REPORT)).get('/api/clash/scout').query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REPORT);
  });

  it('returns 200 for not_registered — a state, not an error (Requirement 1.3)', async () => {
    const res = await request(appWith({ kind: 'not_registered' }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'not_registered' });
  });

  it('returns 200 with a team picker for multiple_teams (Requirement 1.5)', async () => {
    const teams = [{ id: 't1', name: 'Team One', abbreviation: 'T1', tier: 1, iconId: 1 }];
    const res = await request(appWith({ kind: 'multiple_teams', teams }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'multiple_teams', teams });
  });

  it('forwards teamId as a query parameter', async () => {
    let receivedTeamId: string | undefined;
    const app = express();
    app.use(
      '/api',
      createApiRouter({
        orchestrator: stubLookup,
        buildPathOrchestrator: stubBuildPath,
        liveGameOrchestrator: { getLiveGame: () => Promise.resolve({ kind: 'not_in_game' }) },
        scoutingOrchestrator: {
          scout: (_riotId, teamId) => {
            receivedTeamId = teamId;
            return Promise.resolve(REPORT);
          },
        },
        cache: createInMemoryCacheStore({ now: () => 1_000 }),
        now: () => 1_000,
        logger: { unexpectedError: () => undefined },
        dataDragonVersion: '16.17.1',
      }),
    );
    await request(app).get('/api/clash/scout').query({ gameName: 'A', tagLine: 'NA1', teamId: 'team-2' });
    expect(receivedTeamId).toBe('team-2');
  });

  it('maps PLAYER_NOT_FOUND to 404 with the submitted Riot ID', async () => {
    const res = await request(appWith({ kind: 'error', code: 'PLAYER_NOT_FOUND', retriable: false }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'PLAYER_NOT_FOUND', gameName: 'A', tagLine: 'NA1' });
  });

  it('maps NO_LOL_ACCOUNT to 404', async () => {
    const res = await request(appWith({ kind: 'error', code: 'NO_LOL_ACCOUNT', retriable: false }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_LOL_ACCOUNT');
  });

  it('maps UNSUPPORTED_PLATFORM to 404, naming the platform Riot reported', async () => {
    const res = await request(
      appWith({ kind: 'error', code: 'UNSUPPORTED_PLATFORM', retriable: false, platform: 'oc1' }),
    )
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(404);
    expect(res.body.error.platform).toBe('oc1');
  });

  it('maps RIOT_UNAVAILABLE to a retriable 503', async () => {
    const res = await request(appWith({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(503);
    expect(res.body.error.retriable).toBe(true);
  });

  it('maps TIMEOUT to 504', async () => {
    const res = await request(appWith({ kind: 'error', code: 'TIMEOUT', retriable: false }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(504);
  });

  it('maps RATE_LIMITED to 429 with a Retry-After header', async () => {
    const res = await request(appWith({ kind: 'error', code: 'RATE_LIMITED', retriable: true }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('maps AUTH_FAILURE to a generic, non-descriptive 503', async () => {
    const res = await request(appWith({ kind: 'error', code: 'AUTH_FAILURE', retriable: false }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).not.toMatch(/key|credential|token|401|403/i);
  });

  it('maps NETWORK_ERROR to a retriable 502', async () => {
    const res = await request(appWith({ kind: 'error', code: 'NETWORK_ERROR', retriable: true }))
      .get('/api/clash/scout')
      .query({ gameName: 'A', tagLine: 'NA1' });
    expect(res.status).toBe(502);
    expect(res.body.error.retriable).toBe(true);
  });
});
