import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';

/**
 * Route tests for the pinned Data Dragon version endpoint. The orchestrator is a
 * stub and the cache is the real in-memory store on a fixed clock, so nothing here
 * touches a network, a credential or a real timer.
 */

const stubOrchestrator: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};

const stubBuildPathOrchestrator: BuildPathOrchestrator = {
  getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
};

function makeApp(dataDragonVersion = '16.17.1') {
  const now = () => 1_000;
  return createApp({
    dataDragonVersion,
    orchestrator: stubOrchestrator,
    buildPathOrchestrator: stubBuildPathOrchestrator,
    cache: createInMemoryCacheStore({ now }),
    now,
    logger: { unexpectedError: () => undefined },
  });
}

describe('GET /api/static-data', () => {
  it('responds with 200 and the configured version', async () => {
    const response = await request(makeApp()).get('/api/static-data');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dataDragonVersion: '16.17.1' });
  });

  it('serves whatever version was configured, without substituting a default', async () => {
    const response = await request(makeApp('15.24.1')).get('/api/static-data');

    expect(response.body).toEqual({ dataDragonVersion: '15.24.1' });
  });

  it('never serves the moving alias, since config rejects it before assembly', async () => {
    const response = await request(makeApp()).get('/api/static-data');

    expect(response.body.dataDragonVersion).not.toBe('latest');
  });

  it('marks the response no-cache so a version bump propagates promptly', async () => {
    const response = await request(makeApp()).get('/api/static-data');

    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('issues no Riot call and needs no orchestrator interaction', async () => {
    let runLookupCalls = 0;
    const now = () => 1_000;
    const app = createApp({
      dataDragonVersion: '16.17.1',
      orchestrator: {
        runLookup: () => {
          runLookupCalls += 1;
          return Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true });
        },
      },
      buildPathOrchestrator: stubBuildPathOrchestrator,
      cache: createInMemoryCacheStore({ now }),
      now,
      logger: { unexpectedError: () => undefined },
    });

    await request(app).get('/api/static-data');

    expect(runLookupCalls).toBe(0);
  });
});
