import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from './app';
import { createInMemoryCacheStore } from './cache';
import type { LookupOrchestrator } from './orchestrator';
import type { BuildPathOrchestrator } from './orchestrator/buildPath';
import type { LiveGameOrchestrator } from './liveGame/orchestrator';
import type { ScoutingOrchestrator } from './clashScouting/orchestrator';

/**
 * App-level assembly tests. The orchestrator is a stub and the cache is the real
 * in-memory store on a fixed clock, so nothing here touches a network, a
 * credential or a real timer.
 */

const stubOrchestrator: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};

const stubBuildPathOrchestrator: BuildPathOrchestrator = {
  getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
};

const stubLiveGameOrchestrator: LiveGameOrchestrator = {
  getLiveGame: () => Promise.resolve({ kind: 'not_in_game' }),
};

const stubScoutingOrchestrator: ScoutingOrchestrator = {
  scout: () => Promise.resolve({ kind: 'not_registered' }),
};

function makeApp(overrides: { staticDir?: string } = {}) {
  const now = () => 1_000;
  return createApp({
    dataDragonVersion: '16.17.1',
    orchestrator: stubOrchestrator,
    buildPathOrchestrator: stubBuildPathOrchestrator,
    liveGameOrchestrator: stubLiveGameOrchestrator,
    scoutingOrchestrator: stubScoutingOrchestrator,
    cache: createInMemoryCacheStore({ now }),
    now,
    logger: { unexpectedError: () => undefined },
    ...overrides,
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

describe('serving the SPA (staticDir)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lolprofiles-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>lolprofiles.gg</title><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app-abcd1234.js'), 'console.log("built");');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws at assembly if the directory has no index.html', () => {
    expect(() => makeApp({ staticDir: join(dir, 'nope') })).toThrow(/index\.html/);
  });

  it('serves a real built asset with a long-lived immutable cache', async () => {
    const response = await request(makeApp({ staticDir: dir })).get('/assets/app-abcd1234.js');

    expect(response.status).toBe(200);
    expect(response.text).toContain('built');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for an unknown history-mode route', async () => {
    const response = await request(makeApp({ staticDir: dir })).get('/profile?riotId=Doffy%23Smile');

    expect(response.status).toBe(200);
    expect(response.text).toContain('id="root"');
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('serves index.html at the root without directory indexing', async () => {
    const response = await request(makeApp({ staticDir: dir })).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('id="root"');
  });

  it('still 404s an unknown /api route as itself, not the SPA shell', async () => {
    const response = await request(makeApp({ staticDir: dir })).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.text).not.toContain('id="root"');
  });

  it('still answers /health as JSON', async () => {
    const response = await request(makeApp({ staticDir: dir })).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('leaves a non-GET request to fall through rather than answering with the shell', async () => {
    const response = await request(makeApp({ staticDir: dir })).post('/some/page').send({});

    expect(response.status).toBe(404);
  });
});
