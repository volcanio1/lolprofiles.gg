import { describe, it, expect } from 'vitest';
import {
  createInMemoryRankHistoryStore,
  createNoopRankHistoryStore,
  shouldRecordSnapshot,
  MIN_GAMES_BETWEEN_SNAPSHOTS,
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
    gamesPlayed: 100,
    observedAt: BASE,
    ...overrides,
  };
}

describe('shouldRecordSnapshot — Requirement 2.2', () => {
  it('records when there is no prior snapshot', () => {
    expect(shouldRecordSnapshot(undefined, snap())).toBe(true);
  });

  it('skips when fewer than MIN_GAMES_BETWEEN_SNAPSHOTS games have been played since', () => {
    const previous = snap({ gamesPlayed: 100 });
    for (let delta = 0; delta < MIN_GAMES_BETWEEN_SNAPSHOTS; delta += 1) {
      expect(shouldRecordSnapshot(previous, snap({ gamesPlayed: 100 + delta, leaguePoints: 60 }))).toBe(false);
    }
  });

  it('records once exactly MIN_GAMES_BETWEEN_SNAPSHOTS games have been played since', () => {
    const previous = snap({ gamesPlayed: 100 });
    expect(
      shouldRecordSnapshot(previous, snap({ gamesPlayed: 100 + MIN_GAMES_BETWEEN_SNAPSHOTS })),
    ).toBe(true);
  });

  it('records on a tier change even within MIN_GAMES_BETWEEN_SNAPSHOTS games', () => {
    const previous = snap({ tier: 'GOLD', division: 'I', gamesPlayed: 100 });
    expect(shouldRecordSnapshot(previous, snap({ tier: 'PLATINUM', division: 'IV', gamesPlayed: 101 }))).toBe(true);
  });

  it('records on a division change even within MIN_GAMES_BETWEEN_SNAPSHOTS games', () => {
    const previous = snap({ tier: 'GOLD', division: 'III', gamesPlayed: 100 });
    expect(shouldRecordSnapshot(previous, snap({ tier: 'GOLD', division: 'II', gamesPlayed: 101 }))).toBe(true);
  });

  it('records when the game count went backwards (a season / MMR reset)', () => {
    const previous = snap({ gamesPlayed: 300 });
    expect(shouldRecordSnapshot(previous, snap({ gamesPlayed: 2, tier: 'SILVER', division: 'IV' }))).toBe(true);
    // Even with the tier unchanged, a lower count means the old baseline is stale.
    expect(shouldRecordSnapshot(snap({ gamesPlayed: 300 }), snap({ gamesPlayed: 1 }))).toBe(true);
  });
});

describe('InMemoryRankHistoryStore.record — Requirement 2.2', () => {
  it('keeps the first snapshot and ignores a later one under 3 games newer', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ leaguePoints: 47, gamesPlayed: 100, observedAt: BASE }));
    await store.record(snap({ leaguePoints: 99, gamesPlayed: 102, observedAt: BASE + 3_600_000 }));

    const history = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ leaguePoints: 47, observedAt: BASE });
  });

  it('records a second snapshot once 3+ games have been played, same day', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ gamesPlayed: 100, observedAt: BASE }));
    await store.record(snap({ gamesPlayed: 103, leaguePoints: 62, observedAt: BASE + 3_600_000 }));

    const history = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    expect(history.map((s) => s.leaguePoints)).toEqual([47, 62]);
  });

  it('records a promotion immediately, regardless of games played since', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ tier: 'GOLD', division: 'I', gamesPlayed: 100, observedAt: BASE }));
    await store.record(
      snap({ tier: 'PLATINUM', division: 'IV', leaguePoints: 12, gamesPlayed: 101, observedAt: BASE + 3_600_000 }),
    );

    const history = await store.history('puuid-1', 'RANKED_SOLO_5x5');
    expect(history.map((s) => s.tier)).toEqual(['GOLD', 'PLATINUM']);
  });

  it('tracks each queue independently', async () => {
    const store = createInMemoryRankHistoryStore();

    await store.record(snap({ queueType: 'RANKED_SOLO_5x5', observedAt: BASE }));
    await store.record(snap({ queueType: 'RANKED_FLEX_SR', observedAt: BASE }));

    expect(await store.history('puuid-1', 'RANKED_SOLO_5x5')).toHaveLength(1);
    expect(await store.history('puuid-1', 'RANKED_FLEX_SR')).toHaveLength(1);
  });

  it('tracks each PUUID independently', async () => {
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

    await store.record(snap({ observedAt: BASE + 2 * DAY_MS, leaguePoints: 3, gamesPlayed: 120 }));
    await store.record(snap({ observedAt: BASE, leaguePoints: 1, gamesPlayed: 100 }));
    await store.record(snap({ observedAt: BASE + DAY_MS, leaguePoints: 2, gamesPlayed: 110 }));

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

    await store.record(snap({ observedAt: BASE, gamesPlayed: 100 }));
    await store.record(snap({ observedAt: BASE + DAY_MS, gamesPlayed: 110 }));
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
