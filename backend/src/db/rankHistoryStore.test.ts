import { describe, it, expect } from 'vitest';
import {
  createInMemoryRankHistoryStore,
  createNoopRankHistoryStore,
  snapshotDayOf,
  type RankSnapshot,
} from './rankHistoryStore';

const DAY_MS = 86_400_000;
/** 2026-08-28T12:00:00.000Z */
const BASE = Date.UTC(2026, 7, 28, 12, 0, 0);

function snap(overrides: Partial<RankSnapshot> = {}): RankSnapshot {
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

describe('snapshotDayOf', () => {
  it('is the UTC calendar date, regardless of time of day', () => {
    expect(snapshotDayOf(Date.UTC(2026, 7, 28, 0, 0, 0))).toBe('2026-08-28');
    expect(snapshotDayOf(Date.UTC(2026, 7, 28, 23, 59, 59))).toBe('2026-08-28');
  });

  it('rolls at UTC midnight, not local midnight', () => {
    expect(snapshotDayOf(Date.UTC(2026, 7, 28, 23, 59, 59, 999))).toBe('2026-08-28');
    expect(snapshotDayOf(Date.UTC(2026, 7, 29, 0, 0, 0, 0))).toBe('2026-08-29');
  });
});

describe('InMemoryRankHistoryStore.record — Requirement 2.2', () => {
  it('keeps the first observation of a UTC day and ignores a later same-day one', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ leaguePoints: 47, observedAt: BASE }));
    await store.record(snap({ leaguePoints: 99, tier: 'PLATINUM', observedAt: BASE + 3_600_000 }));

    const history = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ leaguePoints: 47, tier: 'GOLD', observedAt: BASE });
  });

  it('records a second snapshot on the next UTC day', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ observedAt: BASE }));
    await store.record(snap({ observedAt: BASE + DAY_MS, leaguePoints: 62 }));

    const history = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    expect(history.map((s) => s.leaguePoints)).toEqual([47, 62]);
  });

  it('deduplicates per queue independently', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ queueType: 'RANKED_SOLO_5x5', observedAt: BASE }));
    await store.record(snap({ queueType: 'RANKED_FLEX_SR', observedAt: BASE }));

    expect(await store.history('puuid-1', 'RANKED_SOLO_5x5')).toHaveLength(1);
    expect(await store.history('puuid-1', 'RANKED_FLEX_SR')).toHaveLength(1);
  });

  it('deduplicates per PUUID independently', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ puuid: 'puuid-1', observedAt: BASE }));
    await store.record(snap({ puuid: 'puuid-2', observedAt: BASE }));

    expect(await store.history('puuid-1', 'RANKED_SOLO_5x5')).toHaveLength(1);
    expect(await store.history('puuid-2', 'RANKED_SOLO_5x5')).toHaveLength(1);
  });
});

describe('InMemoryRankHistoryStore.history — Requirement 2.5', () => {
  it('returns snapshots oldest first even when recorded out of order', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ observedAt: BASE + 2 * DAY_MS, leaguePoints: 3 }));
    await store.record(snap({ observedAt: BASE, leaguePoints: 1 }));
    await store.record(snap({ observedAt: BASE + DAY_MS, leaguePoints: 2 }));

    const history = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    expect(history.map((s) => s.leaguePoints)).toEqual([1, 2, 3]);
  });

  it('is empty for a PUUID or queue with nothing recorded', async () => {
    const store = createInMemoryRankHistoryStore();
    await store.record(snap({ observedAt: BASE }));

    expect(await store.history('unknown', 'RANKED_SOLO_5x5')).toEqual([]);
    expect(await store.history('puuid-1', 'RANKED_FLEX_SR')).toEqual([]);
  });

  it('returns copies — mutating the result does not change the store', async () => {
    const store = createInMemoryRankHistoryStore();
    await store.record(snap({ observedAt: BASE }));

    const first = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    first[0].leaguePoints = -1;

    const second = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    expect(second[0].leaguePoints).toBe(47);
  });
});

describe('InMemoryRankHistoryStore.deleteByPuuid — Requirement 5.1', () => {
  it('removes every snapshot for the PUUID across days and queues, and returns the count', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ observedAt: BASE }));
    await store.record(snap({ observedAt: BASE + DAY_MS }));
    await store.record(snap({ queueType: 'RANKED_FLEX_SR', observedAt: BASE }));
    await store.record(snap({ puuid: 'other', observedAt: BASE }));

    const removed = await store.deleteByPuuid('puuid-1');

    expect(removed).toBe(3);
    expect(await store.history('puuid-1', 'RANKED_SOLO_5x5')).toEqual([]);
    expect(await store.history('puuid-1', 'RANKED_FLEX_SR')).toEqual([]);
    expect(await store.history('other', 'RANKED_SOLO_5x5')).toHaveLength(1);
  });

  it('is idempotent and returns 0 for a PUUID with nothing stored', async () => {
    const store = createInMemoryRankHistoryStore();
    await store.record(snap({ observedAt: BASE }));

    expect(await store.deleteByPuuid('puuid-1')).toBe(1);
    expect(await store.deleteByPuuid('puuid-1')).toBe(0);
    expect(await store.deleteByPuuid('never-seen')).toBe(0);
  });
});

describe('createNoopRankHistoryStore — disabled Persistent_Store', () => {
  it('accepts records silently and always reads back empty', async () => {
    const store = createNoopRankHistoryStore();

    await expect(store.record(snap({ observedAt: BASE }))).resolves.toBeUndefined();
    expect(await store.history('puuid-1', 'RANKED_SOLO_5x5')).toEqual([]);
    expect(await store.deleteByPuuid('puuid-1')).toBe(0);
  });
});
