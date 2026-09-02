import { describe, it, expect } from 'vitest';
import {
  checkpointGamesPlayed,
  createInMemoryRankCheckpointStore,
  createNoopRankCheckpointStore,
  shouldRecordCheckpoint,
  type RankCheckpoint,
} from './rankCheckpointStore';

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

describe('shouldRecordCheckpoint / checkpointGamesPlayed', () => {
  it('checkpointGamesPlayed is wins + losses, or undefined when either is absent', () => {
    expect(checkpointGamesPlayed(checkpoint({ wins: 30, losses: 20 }))).toBe(50);
    expect(checkpointGamesPlayed(checkpoint({ wins: 30 }))).toBeUndefined();
    expect(checkpointGamesPlayed(checkpoint())).toBeUndefined();
  });

  it('keeps the first checkpoint, and any later one where the game count moved', () => {
    const first = checkpoint({ wins: 100, losses: 100 });
    expect(shouldRecordCheckpoint(undefined, first)).toBe(true);
    expect(shouldRecordCheckpoint(first, checkpoint({ wins: 101, losses: 100 }))).toBe(true);
    expect(shouldRecordCheckpoint(first, checkpoint({ wins: 100, losses: 101 }))).toBe(true);
    expect(shouldRecordCheckpoint(first, checkpoint({ wins: 2, losses: 3 }))).toBe(true); // reset
  });

  it('drops a later checkpoint with the same total game count', () => {
    const first = checkpoint({ wins: 100, losses: 100, leaguePoints: 40 });
    // Same games, just a later lookup with a different LP reading.
    expect(shouldRecordCheckpoint(first, checkpoint({ wins: 100, losses: 100, leaguePoints: 40 }))).toBe(false);
    expect(shouldRecordCheckpoint(first, checkpoint({ wins: 101, losses: 99, leaguePoints: 55 }))).toBe(false);
  });

  it('keeps a checkpoint when either side lacks game counts (cannot compare)', () => {
    expect(shouldRecordCheckpoint(checkpoint(), checkpoint({ wins: 5, losses: 5 }))).toBe(true);
    expect(shouldRecordCheckpoint(checkpoint({ wins: 5, losses: 5 }), checkpoint())).toBe(true);
  });
});

describe('InMemoryRankCheckpointStore.record', () => {
  it('records every call when checkpoints carry no game counts (nothing to compare)', async () => {
    const store = createInMemoryRankCheckpointStore();

    await store.record(checkpoint({ leaguePoints: 47, observedAt: BASE }));
    await store.record(checkpoint({ leaguePoints: 62, observedAt: BASE + 3_600_000 }));
    await store.record(checkpoint({ leaguePoints: 55, observedAt: BASE + 7_200_000 }));

    const history = await store.historyAll('puuid-1');
    expect(history.map((c) => c.leaguePoints)).toEqual([47, 62, 55]);
  });

  it('drops a repeat checkpoint with no new games, per queue', async () => {
    const store = createInMemoryRankCheckpointStore();

    await store.record(checkpoint({ wins: 60, losses: 40, leaguePoints: 47, observedAt: BASE }));
    await store.record(checkpoint({ wins: 60, losses: 40, leaguePoints: 51, observedAt: BASE + 3_600_000 })); // dropped
    await store.record(checkpoint({ wins: 61, losses: 40, leaguePoints: 71, observedAt: BASE + 7_200_000 })); // +1 game
    // A different queue is tracked independently.
    await store.record(
      checkpoint({ queueType: 'RANKED_FLEX_SR', wins: 10, losses: 10, leaguePoints: 10, observedAt: BASE + 60_000 }),
    );

    const history = await store.historyAll('puuid-1');
    expect(history.map((c) => c.leaguePoints)).toEqual([47, 10, 71]);
  });

  it('round-trips the optional League-V4 wins/losses when present', async () => {
    const store = createInMemoryRankCheckpointStore();
    await store.record(checkpoint({ wins: 120, losses: 98, observedAt: BASE }));
    await store.record(checkpoint({ observedAt: BASE + 3_600_000 })); // none set

    const [withCounts, without] = await store.historyAll('puuid-1');
    expect(withCounts).toMatchObject({ wins: 120, losses: 98 });
    expect(without.wins).toBeUndefined();
    expect(without.losses).toBeUndefined();
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
