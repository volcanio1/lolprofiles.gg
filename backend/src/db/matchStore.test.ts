import { describe, it, expect } from 'vitest';
import type { MatchDto } from '../riotApiClient';
import { createInMemoryMatchStore, createNoopMatchStore, type StoredMatch } from './matchStore';

function match(matchId: string, participants: string[]): MatchDto {
  return {
    metadata: { matchId, participants },
    info: { queueId: 420, gameStartTimestamp: 1_726_000_000_000, gameDuration: 1800, participants: [] },
  };
}

function stored(matchId: string, participants: string[], storedAt = 1_000): StoredMatch {
  return { matchId, match: match(matchId, participants), region: 'americas', storedAt };
}

describe('InMemoryMatchStore', () => {
  it('getMany returns only the stored ids, keyed by matchId', async () => {
    const store = createInMemoryMatchStore();
    await store.putMany([stored('NA1_1', ['a', 'b']), stored('NA1_2', ['c'])]);

    const result = await store.getMany(['NA1_1', 'NA1_3', 'NA1_2']);

    expect([...result.keys()].sort()).toEqual(['NA1_1', 'NA1_2']);
    expect(result.get('NA1_1')?.match.metadata.participants).toEqual(['a', 'b']);
    expect(result.get('NA1_3')).toBeUndefined();
  });

  it('getMany returns an empty Map for an empty id list', async () => {
    expect((await createInMemoryMatchStore().getMany([])).size).toBe(0);
  });

  it('putMany upserts by matchId — the newest write wins, no fork', async () => {
    const store = createInMemoryMatchStore();
    await store.putMany([stored('NA1_1', ['a'], 100)]);
    await store.putMany([stored('NA1_1', ['a', 'b'], 200)]);

    expect(store.size).toBe(1);
    const got = await store.getMany(['NA1_1']);
    expect(got.get('NA1_1')?.storedAt).toBe(200);
    expect(got.get('NA1_1')?.match.metadata.participants).toEqual(['a', 'b']);
  });

  it('returns copies — mutating a result does not change the store', async () => {
    const store = createInMemoryMatchStore();
    await store.putMany([stored('NA1_1', ['a'])]);
    const first = await store.getMany(['NA1_1']);
    first.get('NA1_1')!.region = 'mutated';
    expect((await store.getMany(['NA1_1'])).get('NA1_1')?.region).toBe('americas');
  });

  it('deleteByPuuid removes every match the puuid participated in and returns the count', async () => {
    const store = createInMemoryMatchStore();
    await store.putMany([
      stored('NA1_1', ['victim', 'bystander']),
      stored('NA1_2', ['bystander', 'other']),
      stored('NA1_3', ['victim']),
    ]);

    expect(await store.deleteByPuuid('victim')).toBe(2);
    expect(store.size).toBe(1);
    expect((await store.getMany(['NA1_2'])).has('NA1_2')).toBe(true);
    expect(await store.deleteByPuuid('victim')).toBe(0);
  });
});

describe('createNoopMatchStore — disabled Persistent_Store', () => {
  it('stores nothing and always reads an empty Map', async () => {
    const store = createNoopMatchStore();
    await expect(store.putMany([stored('NA1_1', ['a'])])).resolves.toBeUndefined();
    expect((await store.getMany(['NA1_1'])).size).toBe(0);
    expect(await store.deleteByPuuid('a')).toBe(0);
  });
});
