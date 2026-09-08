import { describe, it, expect, vi } from 'vitest';
import type { Db } from 'mongodb';
import type {
  LadderSource,
  MatchDto,
  MatchTimelineDto,
  RiotApiClient,
  RiotApiResult,
} from '../../riotApiClient';
import type { RepeatingScheduler } from '../../clashScouting/tournamentRefresher';
import { createCrawlWorker, type CrawlLogger, type CrawlWorkerConfig } from './crawlWorker';

const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });

const CONFIG: CrawlWorkerConfig = {
  enabled: true,
  budgetFraction: 1,
  rps: 1000,
  seedsPerCycle: 5,
  matchesPerSeed: 10,
};

/**
 * A tiny in-memory fake of the handful of MongoDB operations the worker (and the
 * seeder + aggregator it builds) call. Enough to run one full cycle.
 */
function fakeDb(seedDocs: { _id: string; tier: string; platform: string }[]): {
  db: Db;
  processed: Map<string, unknown>;
  aggregates: Map<string, unknown>;
  state: Map<string, unknown>;
} {
  const seeds = [...seedDocs];
  const processed = new Map<string, unknown>();
  const aggregates = new Map<string, unknown>();
  const totals = new Map<string, unknown>();
  const state = new Map<string, unknown>();

  const cursorFrom = (q: { skip?: number; limit?: number; sortId?: boolean } = {}) => {
    let rows = [...seeds];
    if (q.sortId) rows.sort((a, b) => a._id.localeCompare(b._id));
    if (q.skip) rows = rows.slice(q.skip);
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows;
  };

  function collection(name: string) {
    const store =
      name === 'crawl_processed'
        ? processed
        : name === 'champion_build_aggregates'
          ? aggregates
          : name === 'champion_build_totals'
            ? totals
            : name === 'crawl_state'
              ? state
              : new Map<string, unknown>();

    return {
      distinct: () => Promise.resolve([]),
      deleteMany: () => Promise.resolve({ deletedCount: 0 }),
      countDocuments: () => Promise.resolve(seeds.length),
      findOne: (filter: { _id?: string; $in?: unknown } = {}) =>
        Promise.resolve(filter._id !== undefined ? (store.get(filter._id) ?? null) : null),
      insertOne: (doc: { _id: string }) => {
        if (store.has(doc._id)) return Promise.reject(new Error('E11000 duplicate key'));
        store.set(doc._id, doc);
        return Promise.resolve({});
      },
      updateOne: (filter: { _id: string }, update: { $set: Record<string, unknown> }) => {
        store.set(filter._id, { _id: filter._id, ...(store.get(filter._id) as object), ...update.$set });
        return Promise.resolve({});
      },
      bulkWrite: (ops: { updateOne: { filter: { _id: string }; update: unknown } }[]) => {
        for (const op of ops) {
          const cur = (store.get(op.updateOne.filter._id) as Record<string, unknown>) ?? { _id: op.updateOne.filter._id };
          store.set(op.updateOne.filter._id, { ...cur, touched: true });
        }
        return Promise.resolve({});
      },
      find: (filter: { _id?: { $in?: string[] } } = {}) => {
        const inList = filter._id?.$in;
        const q: { skip?: number; limit?: number; sortId?: boolean } = {};
        const cursor = {
          sort: () => {
            q.sortId = true;
            return cursor;
          },
          skip: (n: number) => {
            q.skip = n;
            return cursor;
          },
          limit: (n: number) => {
            q.limit = n;
            return cursor;
          },
          next: () => Promise.resolve(null),
          toArray: () => {
            if (inList) return Promise.resolve(inList.filter((id) => store.has(id)).map((id) => store.get(id) ?? { _id: id }));
            if (name === 'crawl_seeds') return Promise.resolve(cursorFrom(q));
            return Promise.resolve([]);
          },
        };
        return cursor;
      },
    };
  }

  return { db: { collection } as unknown as Db, processed, aggregates, state };
}

function fakeClient(overrides: {
  matchIds?: () => RiotApiResult<string[]>;
  detail?: () => RiotApiResult<MatchDto>;
  timeline?: () => RiotApiResult<MatchTimelineDto>;
} = {}): RiotApiClient & LadderSource {
  const match420: MatchDto = {
    metadata: { matchId: 'M', participants: ['A'] },
    info: {
      queueId: 420,
      gameVersion: '16.17.1.1',
      gameStartTimestamp: 0,
      gameDuration: 100,
      participants: [
        { puuid: 'A', championName: 'Jinx', teamPosition: 'BOTTOM', win: true, kills: 0, deaths: 0, assists: 0, visionScore: 0 } as never,
      ],
    },
  };
  const timeline: MatchTimelineDto = {
    metadata: { matchId: 'M', participants: ['A'] },
    info: { participants: [{ participantId: 1, puuid: 'A' }], frames: [{ timestamp: 0, events: [] }] },
  };
  return {
    getMatchIdsByPuuid: () => Promise.resolve(overrides.matchIds?.() ?? ok(['EUW1_1', 'EUW1_2'])),
    getMatchById: () => Promise.resolve(overrides.detail?.() ?? ok(match420)),
    getMatchTimeline: () => Promise.resolve(overrides.timeline?.() ?? ok(timeline)),
    getLeagueApex: () => Promise.resolve(ok({ tier: 'X', queue: 'RANKED_SOLO_5x5', entries: [] })),
    getLeagueEntriesPage: () => Promise.resolve(ok([])),
  } as unknown as RiotApiClient & LadderSource;
}

const silentLogger: CrawlLogger = { cycle: vi.fn(), cycleFailed: vi.fn() };

/** A scheduler that just captures the tick callback so tests fire it by hand. */
function manualSchedule(): { schedule: RepeatingScheduler; fire: () => void } {
  let run: () => void = () => undefined;
  return {
    schedule: (_ms, r) => {
      run = r;
      return () => undefined;
    },
    fire: () => {
      run();
    },
  };
}

describe('createCrawlWorker', () => {
  it('is inert when disabled', async () => {
    const client = fakeClient();
    const spy = vi.spyOn(client, 'getMatchIdsByPuuid');
    const { db } = fakeDb([{ _id: 'p1', tier: 'DIAMOND', platform: 'euw1' }]);
    const worker = createCrawlWorker({ client, db, config: { ...CONFIG, enabled: false }, now: () => 0, schedule: () => () => undefined, logger: silentLogger });
    worker.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(spy).not.toHaveBeenCalled();
  });

  it('is inert with a null db', () => {
    const worker = createCrawlWorker({ client: fakeClient(), db: null, config: CONFIG, now: () => 0, schedule: () => () => undefined, logger: silentLogger });
    expect(() => {
      worker.start();
      worker.stop();
    }).not.toThrow();
  });

  it('runs a full cycle: fetches, folds, marks processed, advances the cursor', async () => {
    const client = fakeClient();
    const { db, processed, aggregates, state } = fakeDb([
      { _id: 'p1', tier: 'DIAMOND', platform: 'euw1' },
    ]);
    const cycle = vi.fn();
    const worker = createCrawlWorker({ client, db, config: CONFIG, now: () => 1_000, schedule: () => () => undefined, logger: { cycle, cycleFailed: vi.fn() } });

    worker.start();
    await vi.waitFor(() => expect(cycle).toHaveBeenCalled());

    const summary = cycle.mock.calls[0][0];
    expect(summary.matchesFetched).toBe(2);
    expect(summary.observationsFolded).toBe(2);
    expect(summary.endedEarly).toBe(false);
    expect(processed.size).toBe(2);
    expect(aggregates.size).toBeGreaterThan(0);
    expect((state.get('singleton') as { seedCursor: number }).seedCursor).toBe(CONFIG.seedsPerCycle % 1);
  });

  it('skips already-processed match ids on the second cycle (0 detail fetches)', async () => {
    const client = fakeClient();
    const detailSpy = vi.spyOn(client, 'getMatchById');
    const { db } = fakeDb([{ _id: 'p1', tier: 'DIAMOND', platform: 'euw1' }]);
    const manual = manualSchedule();
    const cycle = vi.fn();
    const worker = createCrawlWorker({ client, db, config: CONFIG, now: () => 1, schedule: manual.schedule, logger: { cycle, cycleFailed: vi.fn() } });

    worker.start();
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(1));
    const firstCalls = detailSpy.mock.calls.length;
    expect(firstCalls).toBe(2);

    manual.fire();
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(2));
    expect(detailSpy.mock.calls.length).toBe(firstCalls); // no new detail fetches
    expect(cycle.mock.calls[1][0].idsSkippedProcessed).toBe(2);
  });

  it('ends the cycle early on a rate_limited result and does not advance the cursor', async () => {
    const client = fakeClient({ matchIds: () => ({ kind: 'rate_limited' }) });
    const { db, state } = fakeDb([{ _id: 'p1', tier: 'DIAMOND', platform: 'euw1' }]);
    const cycle = vi.fn();
    const worker = createCrawlWorker({ client, db, config: CONFIG, now: () => 1, schedule: () => () => undefined, logger: { cycle, cycleFailed: vi.fn() } });

    worker.start();
    await vi.waitFor(() => expect(cycle).toHaveBeenCalled());
    expect(cycle.mock.calls[0][0].endedEarly).toBe(true);
    expect((state.get('singleton') as { seedCursor?: number }).seedCursor).toBeUndefined();
  });

  it('drops a tick that fires while a cycle is still running', async () => {
    let resolveDetail: (v: RiotApiResult<MatchDto>) => void = () => undefined;
    const client = fakeClient({ matchIds: () => ok(['EUW1_1']) });
    vi.spyOn(client, 'getMatchById').mockImplementationOnce(
      () => new Promise((resolve) => (resolveDetail = resolve as never)),
    );
    const { db } = fakeDb([{ _id: 'p1', tier: 'DIAMOND', platform: 'euw1' }]);
    const manual = manualSchedule();
    const cycle = vi.fn();
    const worker = createCrawlWorker({ client, db, config: CONFIG, now: () => 1, schedule: manual.schedule, logger: { cycle, cycleFailed: vi.fn() } });

    worker.start(); // cycle 1 starts, hangs on getMatchById
    await new Promise((r) => setTimeout(r, 5));
    manual.fire(); // cycle 2 attempt — must be dropped
    manual.fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(cycle).not.toHaveBeenCalled(); // cycle 1 still in flight

    resolveDetail({ kind: 'not_found' });
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(1)); // only the one cycle
  });

  it('catches a cycle that throws and keeps the worker alive', async () => {
    const client = fakeClient();
    vi.spyOn(client, 'getMatchIdsByPuuid').mockRejectedValueOnce(new Error('boom'));
    const { db } = fakeDb([{ _id: 'p1', tier: 'DIAMOND', platform: 'euw1' }]);
    const manual = manualSchedule();
    const cycleFailed = vi.fn();
    const cycle = vi.fn();
    const worker = createCrawlWorker({ client, db, config: CONFIG, now: () => 1, schedule: manual.schedule, logger: { cycle, cycleFailed } });

    worker.start();
    await vi.waitFor(() => expect(cycleFailed).toHaveBeenCalled());

    manual.fire(); // next tick still runs
    await vi.waitFor(() => expect(cycle).toHaveBeenCalled());
  });
});
