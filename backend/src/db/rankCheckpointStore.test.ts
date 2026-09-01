import { describe, it, expect } from 'vitest';
import { createInMemoryRankCheckpointStore, createNoopRankCheckpointStore, type RankCheckpoint } from './rankCheckpointStore';

const DAY_MS = 86_400_000;
/** 2026-08-28T12:00:00.000Z */
const BASE = Date.UTC(2026, 7, 28, 12, 0, 0);

function checkpoint(overrides: Partial<RankCheckpoint> = {}): RankCheckpoint {
  return {
    puuid: 'puuid-1',
    queueType: 'RANKED_SOLO_5x5',
    tier: 'GOLD',
    division: 'II',
    leaguePoints: 47,
    observedAt: BASE,
    ...overrides,
  };
}

describe('InMemoryRankCheckpointStore.record — no dedup, unlike RankHistoryStore', () => {
  it('records every call, even multiple within the same UTC day', async () => {
    const store = createInMemoryRankCheckpointStore();

    await store.record(checkpoint({ leaguePoints: 47, observedAt: BASE }));
    await store.record(checkpoint({ leaguePoints: 62, observedAt: BASE + 3_600_000 }));
    await store.record(checkpoint({ leaguePoints: 55, observedAt: BASE + 7_200_000 }));

    const history = await store.historyAll('puuid-1');
    expect(history.map((c) => c.leaguePoints)).toEqual([47, 62, 55]);
  });
});

describe('InMemoryRankCheckpointStore.historyAll', () => {
  it('returns every queue for a PUUID together, oldest first', async () => {
    const store = createInMemoryRankCheckpointStore();

    await store.record(checkpoint({ queueType: 'RANKED_FLEX_SR', observedAt: BASE + DAY_MS }));
    await store.record(checkpoint({ queueType: 'RANKED_SOLO_5x5', observedAt: BASE }));

    const history = await store.historyAll('puuid-1');
    expect(history.map((c) => c.queueType)).toEqual(['RANKED_SOLO_5x5', 'RANKED_FLEX_SR']);
  });

  it('is empty for an unknown PUUID', async () => {
    const store = createInMemoryRankCheckpointStore();
    await store.record(checkpoint({ observedAt: BASE }));

    expect(await store.historyAll('unknown')).toEqual([]);
  });

  it('returns copies — mutating the result does not change the store', async () => {
    const store = createInMemoryRankCheckpointStore();
    await store.record(checkpoint({ observedAt: BASE }));

    const first = await store.historyAll('puuid-1');
    first[0].leaguePoints = -1;

    const second = await store.historyAll('puuid-1');
    expect(second[0].leaguePoints).toBe(47);
  });
});

describe('InMemoryRankCheckpointStore.deleteByPuuid', () => {
  it('removes every checkpoint for the PUUID across queues, and returns the count', async () => {
    const store = createInMemoryRankCheckpointStore();

    await store.record(checkpoint({ observedAt: BASE }));
    await store.record(checkpoint({ observedAt: BASE + DAY_MS }));
    await store.record(checkpoint({ queueType: 'RANKED_FLEX_SR', observedAt: BASE }));
    await store.record(checkpoint({ puuid: 'other', observedAt: BASE }));

    const removed = await store.deleteByPuuid('puuid-1');

    expect(removed).toBe(3);
    expect(await store.historyAll('puuid-1')).toEqual([]);
    expect(await store.historyAll('other')).toHaveLength(1);
  });

  it('is idempotent and returns 0 for a PUUID with nothing stored', async () => {
    const store = createInMemoryRankCheckpointStore();
    await store.record(checkpoint({ observedAt: BASE }));

    expect(await store.deleteByPuuid('puuid-1')).toBe(1);
    expect(await store.deleteByPuuid('puuid-1')).toBe(0);
    expect(await store.deleteByPuuid('never-seen')).toBe(0);
  });
});

describe('createNoopRankCheckpointStore — disabled Persistent_Store', () => {
  it('accepts records silently and always reads back empty', async () => {
    const store = createNoopRankCheckpointStore();

    await expect(store.record(checkpoint({ observedAt: BASE }))).resolves.toBeUndefined();
    expect(await store.historyAll('puuid-1')).toEqual([]);
    expect(await store.deleteByPuuid('puuid-1')).toBe(0);
  });
});
