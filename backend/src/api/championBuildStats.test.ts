import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { RunePage } from '../insight/stats';
import {
  createInMemoryChampionStatsStore,
  createNoopChampionStatsStore,
  type ChampionAggregate,
  type ChampionStatsStore,
  type ItemPathAggregate,
} from '../db/championStatsStore';
import { createChampionBuildStatsHandler } from './championBuildStats';
import { createApiRouter, type ApiLogger } from './index';
import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import type { LiveGameOrchestrator } from '../liveGame/orchestrator';
import type { ScoutingOrchestrator } from '../clashScouting/orchestrator';

/**
 * Handler tests for `GET /api/champions/:championKey/build-stats`
 * (specs/champion-build-stats/ task 6.1). Mounted on a bare router so the full
 * `ApiDependencies` fan-out (task 4) is not needed to exercise the boundary.
 */

const RUNES: RunePage = {
  primaryStyle: 8100,
  secondaryStyle: 8000,
  primarySelections: [8112, 8126, 8138, 8135],
  secondarySelections: [9111, 8014],
  statShards: [5008, 5008, 5001],
};

function path(coreItems: number[], games: number, wins: number): ItemPathAggregate {
  return {
    coreItems,
    games,
    wins,
    skillOrders: [{ value: { maxOrder: ['Q', 'W', 'E'], perLevel: [1, 3, 2] }, games }],
    runePages: [{ value: RUNES, games }],
    spellPairs: [{ value: [4, 7], games }],
    startingItems: [{ value: [1055], games }],
  };
}

function jinxCell(overrides: Partial<ChampionAggregate> = {}): ChampionAggregate {
  const itemPaths = overrides.itemPaths ?? [path([3006, 3031, 3036], 900, 500)];
  return {
    championKey: 'Jinx',
    role: 'BOTTOM',
    rank: 'EMERALD_PLUS',
    region: 'world',
    patch: '16.17',
    lastUpdatedAt: 1_700_000_000_000,
    games: itemPaths.reduce((s, p) => s + p.games, 0),
    wins: itemPaths.reduce((s, p) => s + p.wins, 0),
    pickRate: 0.22,
    itemPaths,
    ...overrides,
  };
}

function mount(store: ChampionStatsStore, onError?: (e: unknown) => void): Express {
  const app = express();
  app.get(
    '/api/champions/:championKey/build-stats',
    createChampionBuildStatsHandler({ championStatsStore: store, onError }),
  );
  return app;
}

describe('GET /api/champions/:championKey/build-stats', () => {
  it('404s an unknown champion key without touching the store (Requirement 10.3)', async () => {
    let touched = false;
    const store: ChampionStatsStore = {
      async getBuildStats() {
        touched = true;
        return null;
      },
    };
    const res = await request(mount(store)).get('/api/champions/NotAChamp/build-stats');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CHAMPION_NOT_FOUND');
    expect(touched).toBe(false);
  });

  it('clamps unknown filter values to defaults and echoes them (Requirement 10.4)', async () => {
    const res = await request(mount(createInMemoryChampionStatsStore([jinxCell()])))
      .get('/api/champions/Jinx/build-stats')
      .query({ role: 'midlane', rank: 'IRON_PLUS', region: 'atlantis' });
    expect(res.status).toBe(200);
    expect(res.body.filtersApplied).toEqual({ role: 'ALL', rank: 'ALL', region: 'world' });
  });

  it('passes known filter values through', async () => {
    const res = await request(mount(createInMemoryChampionStatsStore([jinxCell()])))
      .get('/api/champions/Jinx/build-stats')
      .query({ role: 'BOTTOM', rank: 'EMERALD_PLUS', region: 'world' });
    expect(res.status).toBe(200);
    expect(res.body.filtersApplied).toEqual({ role: 'BOTTOM', rank: 'EMERALD_PLUS', region: 'world' });
    expect(res.body.champion).toEqual({ key: 'Jinx', name: 'Jinx' });
    expect(res.body.popular.coreItems).toEqual([3006, 3031, 3036]);
    expect(res.body.meta.overall.totalGames).toBe(900);
  });

  it('resolves the display name for a key that differs from it (Requirement 11.1)', async () => {
    const res = await request(mount(createNoopChampionStatsStore())).get(
      '/api/champions/MonkeyKing/build-stats',
    );
    expect(res.status).toBe(200);
    expect(res.body.champion).toEqual({ key: 'MonkeyKing', name: 'Wukong' });
  });

  it('returns a 200 empty-state for a disabled store (Requirement 12.3)', async () => {
    const res = await request(mount(createNoopChampionStatsStore())).get(
      '/api/champions/Jinx/build-stats',
    );
    expect(res.status).toBe(200);
    expect(res.body.popular).toBeNull();
    expect(res.body.highestWinRate).toBeNull();
    expect(res.body.meta.availableRoles).toEqual([]);
    expect(res.body.meta.availableRanks).toEqual([]);
    expect(res.body.meta.availableRegions).toEqual([]);
    expect(res.body.meta.overall).toEqual({ winRate: 0, pickRate: 0, totalGames: 0 });
  });

  it('degrades to the empty-state 200 and logs once when the store throws (Requirement 12.3)', async () => {
    const errors: unknown[] = [];
    const store: ChampionStatsStore = {
      async getBuildStats() {
        throw new Error('mongo down');
      },
    };
    const res = await request(mount(store, (e) => errors.push(e))).get(
      '/api/champions/Jinx/build-stats',
    );
    expect(res.status).toBe(200);
    expect(res.body.popular).toBeNull();
    expect(res.body.meta.availableRoles).toEqual([]);
    expect(errors).toHaveLength(1);
    // no internal detail leaks into the body
    expect(JSON.stringify(res.body)).not.toContain('mongo down');
  });

  it('serializes a store result whose popular is null as Not_Enough_Data (Requirement 11.5)', async () => {
    // 40 games total — below BACKEND_DISPLAY_FLOOR, so the store nulls both builds
    // but still populates the meta lists.
    const res = await request(
      mount(createInMemoryChampionStatsStore([jinxCell({ itemPaths: [path([1, 2, 3], 40, 20)] })])),
    )
      .get('/api/champions/Jinx/build-stats')
      .query({ role: 'BOTTOM', rank: 'EMERALD_PLUS' });
    expect(res.status).toBe(200);
    expect(res.body.popular).toBeNull();
    expect(res.body.highestWinRate).toBeNull();
    expect(res.body.meta.availableRoles).toContain('BOTTOM');
  });

  it('gates highestWinRate on MIN_SAMPLE (Requirement 11.4)', async () => {
    const res = await request(
      mount(
        createInMemoryChampionStatsStore([
          jinxCell({ itemPaths: [path([3006, 3031, 3036], 300, 250), path([6672, 3094, 3036], 400, 210)] }),
        ]),
      ),
    )
      .get('/api/champions/Jinx/build-stats')
      .query({ role: 'BOTTOM', rank: 'EMERALD_PLUS' });
    expect(res.status).toBe(200);
    expect(res.body.popular).not.toBeNull();
    expect(res.body.highestWinRate).toBeNull();
  });

  it('has no seam for a Riot client or rate limiter (Requirement 10.2)', () => {
    // The dependency object accepts exactly a store (+ an error sink) — there is
    // no field through which a rate-limited call could be made from this handler.
    const deps = { championStatsStore: createNoopChampionStatsStore() };
    expect(Object.keys(deps)).toEqual(['championStatsStore']);
  });
});

// ---------------------------------------------------------------------------
// Through the real `createApiRouter` — the route is registered, mounted under
// `/api`, and degrades exactly like the handler in isolation.
// ---------------------------------------------------------------------------

const stubOrchestrator: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};
const stubBuildPath: BuildPathOrchestrator = {
  getBuildPath: () => Promise.resolve({ kind: 'unavailable', reason: 'no_timeline' }),
};
const stubLiveGame: LiveGameOrchestrator = { getLiveGame: () => Promise.resolve({ kind: 'not_in_game' }) };
const stubScouting: ScoutingOrchestrator = { scout: () => Promise.resolve({ kind: 'not_registered' }) };

function routerApp(store: ChampionStatsStore, onError?: (e: unknown) => void): Express {
  const app = express();
  const logger: Partial<ApiLogger> = onError
    ? { championBuildStatsFailed: ({ error }) => onError(error) }
    : {};
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubOrchestrator,
      buildPathOrchestrator: stubBuildPath,
      liveGameOrchestrator: stubLiveGame,
      scoutingOrchestrator: stubScouting,
      championStatsStore: store,
      cache: createInMemoryCacheStore({ now: () => 1_700_000_000_000 }),
      now: () => 1_700_000_000_000,
      dataDragonVersion: '16.17.1',
      logger,
    }),
  );
  return app;
}

describe('GET /api/champions/:championKey/build-stats — via createApiRouter', () => {
  it('is registered and mounted under /api', async () => {
    const res = await request(routerApp(createNoopChampionStatsStore())).get(
      '/api/champions/Jinx/build-stats',
    );
    expect(res.status).toBe(200);
    expect(res.body.champion.key).toBe('Jinx');
    // not reachable without the /api prefix (SPA fallback territory, not this router)
    const bare = await request(routerApp(createNoopChampionStatsStore())).get(
      '/champions/Jinx/build-stats',
    );
    expect(bare.status).toBe(404);
  });

  it('404s an unknown key through the router', async () => {
    const res = await request(routerApp(createInMemoryChampionStatsStore([jinxCell()]))).get(
      '/api/champions/Nope/build-stats',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CHAMPION_NOT_FOUND');
  });

  it('routes a store throw to logger.championBuildStatsFailed and still answers 200', async () => {
    const errors: unknown[] = [];
    const store: ChampionStatsStore = {
      async getBuildStats() {
        throw new Error('boom');
      },
    };
    const res = await request(routerApp(store, (e) => errors.push(e))).get(
      '/api/champions/Jinx/build-stats',
    );
    expect(res.status).toBe(200);
    expect(res.body.popular).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('clamps filters through the router (Requirement 10.4)', async () => {
    const res = await request(routerApp(createInMemoryChampionStatsStore([jinxCell()])))
      .get('/api/champions/Jinx/build-stats')
      .query({ role: 'nonsense', rank: 'nonsense' });
    expect(res.status).toBe(200);
    expect(res.body.filtersApplied).toEqual({ role: 'ALL', rank: 'ALL', region: 'world' });
  });
});
