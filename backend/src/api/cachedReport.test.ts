import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInMemoryCacheStore } from '../cache';
import {
  createInMemoryLookedUpPlayerStore,
  createNoopLookedUpPlayerStore,
  type LookedUpPlayerStore,
} from '../db/lookedUpPlayerStore';
import {
  createInMemoryProfileSnapshotStore,
  createNoopProfileSnapshotStore,
  type ProfileSnapshotStore,
} from '../db/profileSnapshotStore';
import type { ProfileReport } from '../orchestrator';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import type { LiveGameOrchestrator } from '../liveGame/orchestrator';
import { REFRESH_COOLDOWN_MS, SNAPSHOT_MAX_AGE_MS } from './cachedReport';
import { createApiRouter, type ApiLogger } from './index';

/**
 * Integration tests for `GET /api/players/report` (specs/autofill-search/ task 10.6).
 * Wired to the real in-memory stores so the end-to-end resolve → age-check →
 * project behaviour is what's asserted.
 */

const NOW = 1_700_000_000_000;

const stubOrchestrator: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};
const stubBuildPathOrchestrator: BuildPathOrchestrator = {
  getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
};

const stubLiveGameOrchestrator: LiveGameOrchestrator = {
  getLiveGame: () => Promise.resolve({ kind: 'not_in_game' }),
};

function report(overrides: Partial<ProfileReport> = {}): ProfileReport {
  return { puuid: 'p1', riotId: { gameName: 'Faker', tagLine: 'KR1' }, ...overrides } as ProfileReport;
}

interface Harness {
  app: Express;
  cachedReportErrors: unknown[];
}

function makeHarness(stores: {
  lookedUpPlayerStore?: LookedUpPlayerStore;
  profileSnapshotStore?: ProfileSnapshotStore;
} = {}, now: () => number = () => NOW): Harness {
  const cachedReportErrors: unknown[] = [];
  const logger: Partial<ApiLogger> = {
    cachedReportFailed: ({ error }) => {
      cachedReportErrors.push(error);
    },
  };

  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubOrchestrator,
      buildPathOrchestrator: stubBuildPathOrchestrator,
      liveGameOrchestrator: stubLiveGameOrchestrator,
      cache: createInMemoryCacheStore({ now }),
      now,
      logger,
      dataDragonVersion: '16.17.1',
      lookedUpPlayerStore: stores.lookedUpPlayerStore,
      profileSnapshotStore: stores.profileSnapshotStore,
    }),
  );
  return { app, cachedReportErrors };
}

async function seed(fetchedAt: number) {
  const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
  const profileSnapshotStore = createInMemoryProfileSnapshotStore();
  await lookedUpPlayerStore.remember({
    puuid: 'p1',
    gameName: 'Faker',
    tagLine: 'KR1',
    profileIconId: 6,
    region: 'kr',
    lastLookedUpAt: fetchedAt,
  });
  await profileSnapshotStore.save('p1', report({ summonerLevel: 500 }), fetchedAt);
  return { lookedUpPlayerStore, profileSnapshotStore };
}

const get = (app: Express, q: Record<string, string> = { gameName: 'Faker', tagLine: 'KR1' }) =>
  request(app).get('/api/players/report').query(q);

describe('cached-report constants', () => {
  it('pin the documented durations (mirrored by the frontend)', () => {
    expect(SNAPSHOT_MAX_AGE_MS).toBe(15 * 24 * 60 * 60 * 1000);
    expect(REFRESH_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });
});

describe('GET /api/players/report — cache hit (Requirement 9.3)', () => {
  it('returns the stored report and an ISO fetchedAt when the snapshot is fresh', async () => {
    const stores = await seed(NOW - 1_000);
    const response = await get(makeHarness(stores).app);

    expect(response.status).toBe(200);
    expect(response.body.source).toBe('cache');
    expect(response.body.report).toMatchObject({ puuid: 'p1', summonerLevel: 500 });
    expect(response.body.fetchedAt).toBe(new Date(NOW - 1_000).toISOString());
  });

  it('resolves the name case-insensitively', async () => {
    const stores = await seed(NOW - 1_000);
    const response = await get(makeHarness(stores).app, { gameName: 'faker', tagLine: 'kr1' });
    expect(response.body.source).toBe('cache');
  });

  it('is a hit exactly at the age boundary minus one and a miss at the boundary', async () => {
    const fresh = await seed(NOW - SNAPSHOT_MAX_AGE_MS + 1);
    expect((await get(makeHarness(fresh).app)).body.source).toBe('cache');

    const stale = await seed(NOW - SNAPSHOT_MAX_AGE_MS);
    expect((await get(makeHarness(stale).app)).body.source).toBe('miss');
  });
});

describe('GET /api/players/report — miss (Requirement 9.4)', () => {
  it('misses on an unknown Riot ID', async () => {
    const stores = await seed(NOW);
    const response = await get(makeHarness(stores).app, { gameName: 'Chovy', tagLine: 'KR2' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ source: 'miss' });
  });

  it('misses when the player is known but has no snapshot', async () => {
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    await lookedUpPlayerStore.remember({
      puuid: 'p1', gameName: 'Faker', tagLine: 'KR1', profileIconId: 6, region: 'kr', lastLookedUpAt: NOW,
    });
    const response = await get(makeHarness({ lookedUpPlayerStore, profileSnapshotStore: createInMemoryProfileSnapshotStore() }).app);
    expect(response.body).toEqual({ source: 'miss' });
  });

  it.each([
    ['blank gameName', { gameName: '  ', tagLine: 'KR1' }],
    ['absent tagLine', { gameName: 'Faker' }],
  ])('misses on %s', async (_label, q) => {
    const stores = await seed(NOW);
    const response = await get(makeHarness(stores).app, q as Record<string, string>);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ source: 'miss' });
  });

  it('misses with a disabled store', async () => {
    const response = await get(
      makeHarness({
        lookedUpPlayerStore: createNoopLookedUpPlayerStore(),
        profileSnapshotStore: createNoopProfileSnapshotStore(),
      }).app,
    );
    expect(response.body).toEqual({ source: 'miss' });
  });

  it('misses with no stores configured at all', async () => {
    const response = await get(makeHarness().app);
    expect(response.body).toEqual({ source: 'miss' });
  });

  it('misses and logs once when a store read rejects (Requirement 9.5)', async () => {
    const throwingSnapshots: ProfileSnapshotStore = {
      save: () => Promise.resolve(),
      get: () => Promise.reject(new Error('mongo down with sensitive detail')),
      deleteByPuuid: () => Promise.resolve(0),
    };
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    await lookedUpPlayerStore.remember({
      puuid: 'p1', gameName: 'Faker', tagLine: 'KR1', profileIconId: 6, region: 'kr', lastLookedUpAt: NOW,
    });
    const harness = makeHarness({ lookedUpPlayerStore, profileSnapshotStore: throwingSnapshots });

    const response = await get(harness.app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ source: 'miss' });
    expect(JSON.stringify(response.body)).not.toContain('sensitive detail');
    expect(harness.cachedReportErrors).toHaveLength(1);
  });
});
