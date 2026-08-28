import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator, BuildPathResult } from '../orchestrator/buildPath';
import { createApiRouter } from './index';
import { parseBuildPathRequest } from './buildPath';

const stubLookup: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};

function appWith(getBuildPath: BuildPathOrchestrator['getBuildPath']) {
  const now = () => 1_000;
  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubLookup,
      buildPathOrchestrator: { getBuildPath: vi.fn(getBuildPath) },
      liveGameOrchestrator: { getLiveGame: () => Promise.resolve({ kind: 'not_in_game' }) },
      cache: createInMemoryCacheStore({ now }),
      now,
      logger: { unexpectedError: () => undefined },
      dataDragonVersion: '16.17.1',
    }),
  );
  return app;
}

const URL = '/api/match/EUW1_7231636281/build-path';

describe('parseBuildPathRequest', () => {
  it('recombines the query params and validates them as a Riot ID', () => {
    expect(parseBuildPathRequest({ matchId: 'EUW1_1', gameName: 'Faker', tagLine: 'KR1' })).toEqual({
      ok: true,
      matchId: 'EUW1_1',
      riotId: { gameName: 'Faker', tagLine: 'KR1' },
    });
  });

  it('rejects a missing gameName', () => {
    const parsed = parseBuildPathRequest({ matchId: 'EUW1_1', gameName: undefined, tagLine: 'KR1' });
    expect(parsed).toMatchObject({ ok: false, response: { status: 400, body: { error: { field: 'gameName' } } } });
  });

  it('rejects an over-length tag line through the shared validator', () => {
    const parsed = parseBuildPathRequest({ matchId: 'EUW1_1', gameName: 'Faker', tagLine: 'TOOLONG' });
    expect(parsed).toMatchObject({
      ok: false,
      response: { body: { error: { code: 'VALIDATION_FAILED', validationRule: 'TAG_LINE_TOO_LONG' } } },
    });
  });
});

describe('GET /api/match/:matchId/build-path', () => {
  it('returns 200 and the build path on success', async () => {
    const result: BuildPathResult = {
      kind: 'build_path',
      slice: {
        matchId: 'EUW1_7231636281',
        puuid: 'p',
        buildPath: [{ itemId: 1055, timestamp: 11_000 }],
        skillOrder: [1, 2, 1, 3],
        reconciled: true,
      },
    };
    const res = await request(appWith(() => Promise.resolve(result))).get(URL).query({ gameName: 'Faker', tagLine: 'KR1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'build_path',
      buildPath: [{ itemId: 1055, timestamp: 11_000 }],
      skillOrder: [1, 2, 1, 3],
      reconciled: true,
    });
  });

  it('returns 200 with an unavailable body when there is no timeline', async () => {
    const res = await request(appWith(() => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' })))
      .get(URL)
      .query({ gameName: 'Faker', tagLine: 'KR1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'unavailable', reason: 'no_timeline' });
  });

  it('passes the match id and validated Riot ID through to the orchestrator', async () => {
    const getBuildPath = vi.fn(() => Promise.resolve<BuildPathResult>({ kind: 'unavailable', reason: 'no_timeline' }));
    await request(appWith(getBuildPath)).get(URL).query({ gameName: '  Faker  ', tagLine: 'KR1' });
    expect(getBuildPath).toHaveBeenCalledWith('EUW1_7231636281', { gameName: 'Faker', tagLine: 'KR1' });
  });

  it('400s a missing tagLine without calling the orchestrator', async () => {
    const getBuildPath = vi.fn(() => Promise.resolve<BuildPathResult>({ kind: 'unavailable', reason: 'no_timeline' }));
    const res = await request(appWith(getBuildPath)).get(URL).query({ gameName: 'Faker' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('tagLine');
    expect(getBuildPath).not.toHaveBeenCalled();
  });

  it('maps PLAYER_NOT_FOUND to 404 echoing the submitted Riot ID', async () => {
    const res = await request(
      appWith(() => Promise.resolve({ kind: 'error', code: 'PLAYER_NOT_FOUND', retriable: false })),
    )
      .get(URL)
      .query({ gameName: 'Nope', tagLine: 'X' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'PLAYER_NOT_FOUND', gameName: 'Nope', tagLine: 'X' });
  });

  it('renders an orchestrator VALIDATION_FAILED as a 400 about the match id', async () => {
    const res = await request(appWith(() => Promise.resolve({ kind: 'error', code: 'VALIDATION_FAILED', retriable: false })))
      .get('/api/match/NOPE_1/build-path')
      .query({ gameName: 'Faker', tagLine: 'KR1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'matchId' });
  });

  it('sets Retry-After on a rate-limited result', async () => {
    const res = await request(appWith(() => Promise.resolve({ kind: 'error', code: 'RATE_LIMITED', retriable: true })))
      .get(URL)
      .query({ gameName: 'Faker', tagLine: 'KR1' });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('converts an orchestrator throw into an opaque 500', async () => {
    const res = await request(
      appWith(() => {
        throw new Error('boom');
      }),
    )
      .get(URL)
      .query({ gameName: 'Faker', tagLine: 'KR1' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).not.toContain('boom');
  });
});
