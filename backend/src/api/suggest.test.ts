import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  createInMemoryLookedUpPlayerStore,
  createNoopLookedUpPlayerStore,
  type LookedUpPlayer,
  type LookedUpPlayerStore,
} from '../db/lookedUpPlayerStore';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import { createInMemoryCacheStore } from '../cache';
import { createApiRouter, type ApiLogger } from './index';
import { clampLimit, MAX_SUGGESTIONS } from './suggest';

/**
 * Integration tests for `GET /api/players/suggest` (specs/autofill-search/ task 1.4).
 *
 * Wired to the real `InMemoryLookedUpPlayerStore` so what is asserted is the
 * end-to-end behaviour — prefix semantics, ordering, clamping, and the "always
 * an empty 200" degradation — not that the route forwards a call.
 */

const NOW = 1_700_000_000_000;

const stubOrchestrator: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};
const stubBuildPathOrchestrator: BuildPathOrchestrator = {
  getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
};

interface Harness {
  app: Express;
  suggestErrors: unknown[];
}

function makeHarness(lookedUpPlayerStore?: LookedUpPlayerStore): Harness {
  const suggestErrors: unknown[] = [];
  const logger: Partial<ApiLogger> = {
    suggestFailed: ({ error }) => {
      suggestErrors.push(error);
    },
  };

  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubOrchestrator,
      buildPathOrchestrator: stubBuildPathOrchestrator,
      cache: createInMemoryCacheStore({ now: () => NOW }),
      now: () => NOW,
      logger,
      dataDragonVersion: '16.17.1',
      lookedUpPlayerStore,
    }),
  );

  return { app, suggestErrors };
}

function player(overrides: Partial<LookedUpPlayer>): LookedUpPlayer {
  return {
    puuid: 'puuid-default',
    gameName: 'Default',
    tagLine: 'NA1',
    profileIconId: 1,
    region: 'na1',
    lastLookedUpAt: NOW,
    ...overrides,
  };
}

async function seed(store: LookedUpPlayerStore, players: LookedUpPlayer[]): Promise<void> {
  for (const p of players) {
    await store.remember(p);
  }
}

describe('GET /api/players/suggest — matching and ordering', () => {
  it('returns prefix matches, case-insensitively, most-recently-looked-up first', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await seed(store, [
      player({ puuid: 'p1', gameName: 'Faker', tagLine: 'KR1', lastLookedUpAt: NOW - 5_000 }),
      player({ puuid: 'p2', gameName: 'fakerino', tagLine: 'EUW', lastLookedUpAt: NOW - 1_000 }),
      player({ puuid: 'p3', gameName: 'Chovy', tagLine: 'KR2', lastLookedUpAt: NOW }),
    ]);
    const harness = makeHarness(store);

    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'FAK' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { gameName: 'fakerino', tagLine: 'EUW', profileIconId: 1, region: 'na1' },
      { gameName: 'Faker', tagLine: 'KR1', profileIconId: 1, region: 'na1' },
    ]);
  });

  it('anchors at the start of gameName — no substring or fuzzy match', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await seed(store, [player({ puuid: 'p1', gameName: 'TheFaker' }), player({ puuid: 'p2', gameName: 'Faker' })]);
    const harness = makeHarness(store);

    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'faker' });

    expect(response.body).toEqual([{ gameName: 'Faker', tagLine: 'NA1', profileIconId: 1, region: 'na1' }]);
  });

  it('carries a null profileIconId through unchanged', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await seed(store, [player({ gameName: 'Noicon', profileIconId: null })]);
    const harness = makeHarness(store);

    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'no' });

    expect(response.body).toEqual([{ gameName: 'Noicon', tagLine: 'NA1', profileIconId: null, region: 'na1' }]);
  });

  it('never leaks puuid or lastLookedUpAt', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await seed(store, [player({ puuid: 'secret-puuid', gameName: 'Leaky' })]);
    const harness = makeHarness(store);

    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'le' });

    expect(JSON.stringify(response.body)).not.toContain('secret-puuid');
    expect(JSON.stringify(response.body)).not.toContain('lastLookedUpAt');
    expect(Object.keys(response.body[0]).sort()).toEqual(['gameName', 'profileIconId', 'region', 'tagLine']);
  });
});

describe('GET /api/players/suggest — limit clamping (Requirement 1.6)', () => {
  async function harnessWithTen(): Promise<Harness> {
    const store = createInMemoryLookedUpPlayerStore();
    await seed(
      store,
      Array.from({ length: 10 }, (_, i) =>
        player({ puuid: `p${String(i)}`, gameName: `Prefix${String(i)}`, lastLookedUpAt: NOW - i }),
      ),
    );
    return makeHarness(store);
  }

  it('defaults to MAX_SUGGESTIONS when limit is absent', async () => {
    const harness = await harnessWithTen();
    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'prefix' });
    expect(response.body).toHaveLength(MAX_SUGGESTIONS);
  });

  it.each([
    ['0', 1],
    ['-3', 1],
    ['1', 1],
    ['5', 5],
    ['999', MAX_SUGGESTIONS],
    ['not-a-number', MAX_SUGGESTIONS],
    ['3.9', 3],
  ])('clamps limit=%s to %i rows', async (limit, expected) => {
    const harness = await harnessWithTen();
    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'prefix', limit });
    expect(response.body).toHaveLength(expected);
  });
});

describe('GET /api/players/suggest — not-yet-useful queries are empty 200s (Requirement 1.5)', () => {
  it.each([
    ['absent q', {}],
    ['blank q', { q: '   ' }],
    ['single character', { q: 'f' }],
    ['contains #', { q: 'faker#kr' }],
    ['repeated q param', { q: ['fa', 'ke'] }],
  ])('%s ⇒ [] with 200', async (_label, query) => {
    const store = createInMemoryLookedUpPlayerStore();
    await seed(store, [player({ gameName: 'Faker' })]);
    const harness = makeHarness(store);

    const response = await request(harness.app).get('/api/players/suggest').query(query);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe('GET /api/players/suggest — degradation', () => {
  it('returns [] with 200 when the store is the disabled no-op', async () => {
    const harness = makeHarness(createNoopLookedUpPlayerStore());

    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'faker' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(harness.suggestErrors).toHaveLength(0);
  });

  it('returns [] with 200 and logs once when the store rejects (Requirement 1.8)', async () => {
    const throwing: LookedUpPlayerStore = {
      remember: () => Promise.resolve(),
      searchByNamePrefix: () => Promise.reject(new Error('mongo down, with sensitive detail')),
      findByRiotId: () => Promise.resolve(null),
      deleteByPuuid: () => Promise.resolve(0),
    };
    const harness = makeHarness(throwing);

    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'faker' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain('sensitive detail');
    expect(harness.suggestErrors).toHaveLength(1);
  });

  it('behaves as a disabled store when no lookedUpPlayerStore is provided at all', async () => {
    const harness = makeHarness(undefined);

    const response = await request(harness.app).get('/api/players/suggest').query({ q: 'faker' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe('clampLimit (unit)', () => {
  it.each([
    [undefined, MAX_SUGGESTIONS],
    ['', MAX_SUGGESTIONS],
    ['abc', MAX_SUGGESTIONS],
    [['5', '6'], 5],
    ['0', 1],
    [-1, 1],
    [4, 4],
    [8, 8],
    [100, MAX_SUGGESTIONS],
    ['2.7', 2],
  ])('clampLimit(%o) === %i', (input, expected) => {
    expect(clampLimit(input)).toBe(expected);
  });
});
