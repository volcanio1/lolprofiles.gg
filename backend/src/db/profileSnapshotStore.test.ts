import { describe, it, expect } from 'vitest';
import type { ProfileReport } from '../orchestrator';
import {
  createInMemoryProfileSnapshotStore,
  createNoopProfileSnapshotStore,
} from './profileSnapshotStore';

/**
 * specs/autofill-search/ task 9.4 — the store treats the report as opaque, so
 * the fixture only needs to be a distinguishable object for round-trip equality.
 */
function report(overrides: Partial<ProfileReport> = {}): ProfileReport {
  return { puuid: 'p1', riotId: { gameName: 'Faker', tagLine: 'KR1' }, ...overrides } as ProfileReport;
}

describe('InMemoryProfileSnapshotStore', () => {
  it('saves and reads back the report with its fetchedAt', async () => {
    const store = createInMemoryProfileSnapshotStore();
    await store.save('p1', report({ summonerLevel: 500 }), 1_700_000_000_000);

    expect(await store.get('p1')).toEqual({
      report: report({ summonerLevel: 500 }),
      fetchedAt: 1_700_000_000_000,
    });
  });

  it('is an upsert keyed by PUUID — the newest report wins', async () => {
    const store = createInMemoryProfileSnapshotStore();
    await store.save('p1', report({ summonerLevel: 1 }), 100);
    await store.save('p1', report({ summonerLevel: 2 }), 200);

    expect(store.size).toBe(1);
    const stored = await store.get('p1');
    expect(stored?.report).toMatchObject({ summonerLevel: 2 });
    expect(stored?.fetchedAt).toBe(200);
  });

  it('returns null for a PUUID with no snapshot', async () => {
    const store = createInMemoryProfileSnapshotStore();
    expect(await store.get('nobody')).toBeNull();
  });

  it('deleteByPuuid removes the snapshot and returns 1, then 0', async () => {
    const store = createInMemoryProfileSnapshotStore();
    await store.save('p1', report(), 100);

    expect(await store.deleteByPuuid('p1')).toBe(1);
    expect(await store.deleteByPuuid('p1')).toBe(0);
    expect(await store.get('p1')).toBeNull();
  });
});

describe('createNoopProfileSnapshotStore — disabled Persistent_Store', () => {
  it('stores nothing and always reads null', async () => {
    const store = createNoopProfileSnapshotStore();

    await expect(store.save('p1', report(), 100)).resolves.toBeUndefined();
    expect(await store.get('p1')).toBeNull();
    expect(await store.deleteByPuuid('p1')).toBe(0);
  });
});
