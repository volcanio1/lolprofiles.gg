import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  TTL_BY_ENDPOINT,
  createInMemoryCacheStore,
  type CacheEntry,
  type CacheKey,
  type CacheStore,
  type InMemoryCacheStore,
  type PuuidDeletionResult,
} from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import type { BuildPathOrchestrator } from '../orchestrator/buildPath';
import type { LiveGameOrchestrator } from '../liveGame/orchestrator';
import type { ScoutingOrchestrator } from '../clashScouting/orchestrator';
import { createApiRouter, type ApiLogger } from './index';

/**
 * Task 15.4 — integration tests for `POST /api/privacy/delete`.
 *
 * Deliberately wired to the REAL `InMemoryCacheStore` rather than a fake, because
 * what these requirements constrain is the end-to-end effect on cached data:
 * `found` semantics, idempotence, and that match details are scrubbed rather than
 * evicted. A stubbed store would assert only that the route forwards a call.
 * The clock is a fake counter; no real timer, network or credential is involved.
 */

const NOW = 1_700_000_000_000;
const PUUID = 'puuid-subject';
const OTHER_PUUID = 'puuid-bystander';

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

interface Harness {
  app: Express;
  cache: InMemoryCacheStore;
  logged: unknown[];
}

interface HarnessStores {
  rankHistoryStore?: import('../db/rankHistoryStore').RankHistoryStore;
  rankCheckpointStore?: import('../db/rankCheckpointStore').RankCheckpointStore;
  lookedUpPlayerStore?: import('../db/lookedUpPlayerStore').LookedUpPlayerStore;
  profileSnapshotStore?: import('../db/profileSnapshotStore').ProfileSnapshotStore;
  matchStore?: import('../db/matchStore').MatchStore;
}

function makeHarness(cache?: CacheStore, stores: HarnessStores = {}): Harness {
  const now = () => NOW;
  const store = (cache ?? createInMemoryCacheStore({ now })) as InMemoryCacheStore;
  const logged: unknown[] = [];
  const logger: Partial<ApiLogger> = {
    unexpectedError: (info) => {
      logged.push(info);
    },
  };

  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubOrchestrator,
      buildPathOrchestrator: stubBuildPathOrchestrator,
      liveGameOrchestrator: stubLiveGameOrchestrator,
      scoutingOrchestrator: stubScoutingOrchestrator,
      cache: store,
      now,
      logger,
      dataDragonVersion: '16.17.1',
      rankHistoryStore: stores.rankHistoryStore,
      rankCheckpointStore: stores.rankCheckpointStore,
      lookedUpPlayerStore: stores.lookedUpPlayerStore,
      profileSnapshotStore: stores.profileSnapshotStore,
      matchStore: stores.matchStore,
    }),
  );

  return { app, cache: store, logged };
}

/** A match detail in which both the subject and a bystander participated. */
function sharedMatch(matchId: string) {
  return {
    metadata: { matchId, participants: [PUUID, OTHER_PUUID] },
    info: {
      queueId: 420,
      gameStartTimestamp: NOW,
      gameDuration: 1_800,
      participants: [
        {
          puuid: PUUID,
          summonerName: `Name_${PUUID}`,
          championName: 'Ahri',
          teamPosition: 'MIDDLE',
          win: true,
          kills: 7,
          deaths: 2,
          assists: 9,
          visionScore: 21,
        },
        {
          puuid: OTHER_PUUID,
          summonerName: `Name_${OTHER_PUUID}`,
          championName: 'Garen',
          teamPosition: 'TOP',
          win: false,
          kills: 1,
          deaths: 7,
          assists: 3,
          visionScore: 8,
        },
      ],
    },
  };
}

/** Seeds a realistic set of cached entries for both players. */
async function seed(cache: InMemoryCacheStore): Promise<void> {
  const entries: { key: CacheKey; value: unknown; ttl: number | 'infinite' }[] = [
    {
      key: { endpoint: 'account', routingValue: 'americas', params: { gameName: 'Subject', tagLine: 'NA1' } },
      value: { puuid: PUUID, gameName: 'Subject', tagLine: 'NA1' },
      ttl: TTL_BY_ENDPOINT.account,
    },
    {
      key: { endpoint: 'summoner', routingValue: 'na1', params: { puuid: PUUID } },
      value: { puuid: PUUID, summonerLevel: 300, profileIconId: 1 },
      ttl: TTL_BY_ENDPOINT.summoner,
    },
    {
      key: { endpoint: 'league', routingValue: 'na1', params: { puuid: PUUID } },
      value: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'I', leaguePoints: 20, wins: 5, losses: 5 }],
      ttl: TTL_BY_ENDPOINT.league,
    },
    {
      key: { endpoint: 'matchIds', routingValue: 'americas', params: { puuid: PUUID } },
      value: ['NA1_1'],
      ttl: TTL_BY_ENDPOINT.matchIds,
    },
    {
      key: { endpoint: 'summoner', routingValue: 'na1', params: { puuid: OTHER_PUUID } },
      value: { puuid: OTHER_PUUID, summonerLevel: 88, profileIconId: 2 },
      ttl: TTL_BY_ENDPOINT.summoner,
    },
    {
      key: { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_1' } },
      value: sharedMatch('NA1_1'),
      ttl: TTL_BY_ENDPOINT.matchDetail,
    },
  ];
  for (const entry of entries) {
    await cache.set(entry.key, entry.value, entry.ttl);
  }
}

describe('POST /api/privacy/delete — Requirement 12.5', () => {
  it('deletes the subject\u2019s cached data and confirms completion', async () => {
    const harness = makeHarness();
    await seed(harness.cache);
    const sizeBefore = harness.cache.size;

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ found: true, deletedAt: new Date(NOW).toISOString() });
    expect(harness.cache.size).toBeLessThan(sizeBefore);
  });

  it('leaves the PUUID nowhere in the cache afterwards', async () => {
    const harness = makeHarness();
    await seed(harness.cache);

    await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    // Exhaustive: keys, values and nested participant records.
    expect(JSON.stringify(harness.cache.dumpForVerification())).not.toContain(PUUID);
  });

  it('evicts the shared match detail the subject participated in', async () => {
    const harness = makeHarness();
    await seed(harness.cache);

    await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    // Requirement 12.5. Eviction rather than in-place redaction, so a later lookup
    // re-fetches a complete match and the subject's report is not permanently
    // emptied. The cost is a cache miss for the bystander too, which is the
    // deliberate trade.
    const matchEntry = await harness.cache.get({
      endpoint: 'matchDetail',
      routingValue: 'americas',
      params: { matchId: 'NA1_1' },
    });
    expect(matchEntry).toBeUndefined();
  });

  it('leaves the bystander\u2019s own keyed entries untouched', async () => {
    const harness = makeHarness();
    await seed(harness.cache);

    await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    const bystander = await harness.cache.get<{ puuid: string; summonerLevel: number }>({
      endpoint: 'summoner',
      routingValue: 'na1',
      params: { puuid: OTHER_PUUID },
    });
    expect(bystander?.value).toEqual({ puuid: OTHER_PUUID, summonerLevel: 88, profileIconId: 2 });
  });

  it('removes the account entry, which associates a Riot ID with the PUUID', async () => {
    const harness = makeHarness();
    await seed(harness.cache);

    await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    const account = await harness.cache.get({
      endpoint: 'account',
      routingValue: 'americas',
      params: { gameName: 'Subject', tagLine: 'NA1' },
    });
    expect(account).toBeUndefined();
  });
});

describe('POST /api/privacy/delete — Requirement 12.6', () => {
  it('confirms with found: false when no data exists, and does not treat it as an error', async () => {
    const harness = makeHarness();

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: 'never-cached' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ found: false, deletedAt: new Date(NOW).toISOString() });
    expect(response.body.error).toBeUndefined();
  });

  it('is idempotent: a repeat request confirms found: false without failing', async () => {
    const harness = makeHarness();
    await seed(harness.cache);

    const first = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });
    const afterFirst = JSON.stringify(harness.cache.dumpForVerification());
    const second = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });
    const third = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(first.body.found).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.found).toBe(false);
    expect(third.body.found).toBe(false);
    // The cache is byte-identical after the first deletion.
    expect(JSON.stringify(harness.cache.dumpForVerification())).toBe(afterFirst);
  });

  it('confirms found: false for a PUUID that only ever appeared as a bystander\u2019s match row', async () => {
    // Nothing is keyed to this PUUID and it appears in no cached value, so there
    // is genuinely nothing to act on.
    const harness = makeHarness();
    await seed(harness.cache);

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: 'puuid-absent' });

    expect(response.body.found).toBe(false);
  });
});

describe('POST /api/privacy/delete — request validation', () => {
  it('rejects a missing puuid with 400 rather than answering found: false', async () => {
    const harness = makeHarness();

    const response = await request(harness.app).post('/api/privacy/delete').send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.field).toBe('puuid');
  });

  it('rejects a blank or non-string puuid', async () => {
    const harness = makeHarness();

    for (const puuid of ['', '   ', 42, null, [], { value: 'x' }]) {
      const response = await request(harness.app).post('/api/privacy/delete').send({ puuid });
      expect(response.status).toBe(400);
    }
  });

  it('trims the submitted puuid before deleting', async () => {
    const harness = makeHarness();
    await seed(harness.cache);

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: `  ${PUUID}  ` });

    expect(response.body.found).toBe(true);
    expect(JSON.stringify(harness.cache.dumpForVerification())).not.toContain(PUUID);
  });

  it('does not report the volume of data held for a PUUID', async () => {
    // Decision 1: the internal counts stay internal, so an unauthenticated caller
    // cannot probe how much we hold about a given player.
    const harness = makeHarness();
    await seed(harness.cache);

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(Object.keys(response.body).sort()).toEqual(['deletedAt', 'found']);
  });
});

describe('POST /api/privacy/delete — Persistent_Store (specs/database/ Requirement 5)', () => {
  const SNAP = {
    puuid: PUUID,
    queueType: 'RANKED_SOLO_5x5',
    tier: 'GOLD',
    division: 'II',
    leaguePoints: 40,
    gamesPlayed: 120,
    observedAt: NOW,
  };
  const PLAYER = {
    puuid: PUUID,
    gameName: 'Subject',
    tagLine: 'EUW',
    profileIconId: 1,
    region: 'euw1',
    lastLookedUpAt: NOW,
  };

  it('clears the PUUID from both collections and still reports found: true', async () => {
    const { createInMemoryRankHistoryStore } = await import('../db/rankHistoryStore');
    const { createInMemoryLookedUpPlayerStore } = await import('../db/lookedUpPlayerStore');
    const rankHistoryStore = createInMemoryRankHistoryStore();
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    await rankHistoryStore.record(SNAP);
    await lookedUpPlayerStore.remember(PLAYER);

    // Cache is empty — the only data for this PUUID lives in the Persistent_Store.
    const harness = makeHarness(undefined, { rankHistoryStore, lookedUpPlayerStore });
    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect(await rankHistoryStore.history(PUUID, 'RANKED_SOLO_5x5')).toEqual([]);
    expect(await lookedUpPlayerStore.searchByNamePrefix('subject', 10)).toEqual([]);
  });

  it('clears rank checkpoints too, across every queue (recent-matches-lp-delta)', async () => {
    const { createInMemoryRankCheckpointStore } = await import('../db/rankCheckpointStore');
    const rankCheckpointStore = createInMemoryRankCheckpointStore();
    await rankCheckpointStore.record({ puuid: PUUID, queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', leaguePoints: 40, observedAt: NOW });
    await rankCheckpointStore.record({ puuid: PUUID, queueType: 'RANKED_FLEX_SR', tier: 'GOLD', division: 'II', leaguePoints: 10, observedAt: NOW });

    // Cache is empty — the only data for this PUUID lives in the Persistent_Store.
    const harness = makeHarness(undefined, { rankCheckpointStore });
    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect(await rankCheckpointStore.historyAll(PUUID)).toEqual([]);
  });

  it('still succeeds when a Persistent_Store deletion throws, as long as the cache half worked', async () => {
    const { createInMemoryLookedUpPlayerStore } = await import('../db/lookedUpPlayerStore');
    const throwingRankHistory = {
      record: () => Promise.resolve(),
      history: () => Promise.resolve([]),
      deleteByPuuid: () => Promise.reject(new Error('mongo down, with sensitive detail')),
    };
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    await lookedUpPlayerStore.remember(PLAYER);

    const harness = makeHarness(undefined, {
      rankHistoryStore: throwingRankHistory,
      lookedUpPlayerStore,
    });
    await seed(harness.cache); // gives the cache something to delete for PUUID

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('sensitive detail');
    expect(harness.logged).toHaveLength(0); // a swallowed store error is not a defect
    expect(await lookedUpPlayerStore.searchByNamePrefix('subject', 10)).toEqual([]);
  });

  it('clears the profile_reports snapshot too (autofill-search Requirement 8.7)', async () => {
    const { createInMemoryProfileSnapshotStore } = await import('../db/profileSnapshotStore');
    const profileSnapshotStore = createInMemoryProfileSnapshotStore();
    await profileSnapshotStore.save(PUUID, { puuid: PUUID } as never, NOW);

    const harness = makeHarness(undefined, { profileSnapshotStore });
    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect(await profileSnapshotStore.get(PUUID)).toBeNull();
  });

  it('still succeeds when only the profile snapshot deletion throws', async () => {
    const profileSnapshotStore = {
      save: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      deleteByPuuid: () => Promise.reject(new Error('snapshot store down')),
    };
    const harness = makeHarness(undefined, { profileSnapshotStore });
    await seed(harness.cache);

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect(harness.logged).toHaveLength(0);
  });

  it('evicts every stored match the PUUID participated in (specs/match-cache/ Requirement 6.1)', async () => {
    const { createInMemoryMatchStore } = await import('../db/matchStore');
    const matchStore = createInMemoryMatchStore();
    await matchStore.putMany([
      {
        matchId: 'NA1_1',
        match: { metadata: { matchId: 'NA1_1', participants: [PUUID, OTHER_PUUID] }, info: { queueId: 420, gameStartTimestamp: NOW, gameDuration: 1800, participants: [] } },
        region: 'americas',
        storedAt: NOW,
      },
      {
        matchId: 'NA1_2',
        match: { metadata: { matchId: 'NA1_2', participants: [OTHER_PUUID] }, info: { queueId: 420, gameStartTimestamp: NOW, gameDuration: 1800, participants: [] } },
        region: 'americas',
        storedAt: NOW,
      },
    ]);

    const harness = makeHarness(undefined, { matchStore });
    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect((await matchStore.getMany(['NA1_1', 'NA1_2'])).has('NA1_1')).toBe(false); // evicted
    expect((await matchStore.getMany(['NA1_2'])).has('NA1_2')).toBe(true); // bystander-only match kept
  });

  it('still succeeds when only the match-store deletion throws', async () => {
    const matchStore = {
      getMany: () => Promise.resolve(new Map()),
      putMany: () => Promise.resolve(),
      deleteByPuuid: () => Promise.reject(new Error('match store down')),
    };
    const harness = makeHarness(undefined, { matchStore });
    await seed(harness.cache);

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect(harness.logged).toHaveLength(0);
  });

  it('reports found: false when nothing exists in any store', async () => {
    const { createInMemoryRankHistoryStore } = await import('../db/rankHistoryStore');
    const { createInMemoryLookedUpPlayerStore } = await import('../db/lookedUpPlayerStore');
    const harness = makeHarness(undefined, {
      rankHistoryStore: createInMemoryRankHistoryStore(),
      lookedUpPlayerStore: createInMemoryLookedUpPlayerStore(),
    });

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: 'nobody' });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
  });

  it('the response body still carries only { found, deletedAt }', async () => {
    const { createInMemoryRankHistoryStore } = await import('../db/rankHistoryStore');
    const { createInMemoryLookedUpPlayerStore } = await import('../db/lookedUpPlayerStore');
    const rankHistoryStore = createInMemoryRankHistoryStore();
    await rankHistoryStore.record(SNAP);

    const harness = makeHarness(undefined, {
      rankHistoryStore,
      lookedUpPlayerStore: createInMemoryLookedUpPlayerStore(),
    });
    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(Object.keys(response.body).sort()).toEqual(['deletedAt', 'found']);
  });
});

describe('POST /api/privacy/delete — defect handling', () => {
  it('logs a failing cache and answers an opaque 500', async () => {
    const failing: CacheStore = {
      get: <T,>(_key: CacheKey): Promise<CacheEntry<T> | undefined> => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      deleteByPuuid: (): Promise<PuuidDeletionResult> =>
        Promise.reject(new Error('cache exploded with sensitive detail')),
    };
    const harness = makeHarness(failing);

    const response = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('sensitive detail');
    expect(harness.logged).toHaveLength(1);
  });
});
