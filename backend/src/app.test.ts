import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app';
import { createInMemoryCacheStore } from './cache';
import type { LookupOrchestrator } from './orchestrator';

/**
 * App-level assembly tests. The orchestrator is a stub and the cache is the real
 * in-memory store on a fixed clock, so nothing here touches a network, a
 * credential or a real timer.
 */

const stubOrchestrator: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};

function makeApp() {
  const now = () => 1_000;
  return createApp({
    orchestrator: stubOrchestrator,
    cache: createInMemoryCacheStore({ now }),
    now,
    logger: { unexpectedError: () => undefined },
  });
}

describe('GET /health', () => {
  it('responds with 200 and { status: "ok" }', async () => {
    const response = await request(makeApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('route mounting', () => {
  it('mounts the lookup route under /api', async () => {
    const response = await request(makeApp()).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    // Reaches the handler (the stub's error), rather than 404ing as unmounted.
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('RIOT_UNAVAILABLE');
  });

  it('mounts the privacy deletion route under /api', async () => {
    const response = await request(makeApp()).post('/api/privacy/delete').send({ puuid: 'puuid-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ found: false, deletedAt: new Date(1_000).toISOString() });
  });

  it('does not expose the routes outside the /api prefix', async () => {
    const response = await request(makeApp()).post('/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(404);
  });
});
