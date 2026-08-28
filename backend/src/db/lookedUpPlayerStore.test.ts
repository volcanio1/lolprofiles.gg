import { describe, it, expect } from 'vitest';
import {
  createInMemoryLookedUpPlayerStore,
  createNoopLookedUpPlayerStore,
  type LookedUpPlayer,
} from './lookedUpPlayerStore';

function player(overrides: Partial<LookedUpPlayer> = {}): LookedUpPlayer {
  return {
    puuid: 'puuid-1',
    gameName: 'Faker',
    tagLine: 'KR1',
    profileIconId: 6,
    region: 'kr',
    lastLookedUpAt: 1_000,
    ...overrides,
  };
}

describe('InMemoryLookedUpPlayerStore.remember — Requirement 3.1/3.3', () => {
  it('creates a record keyed by PUUID', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await store.remember(player());

    expect(await store.searchByNamePrefix('fak', 10)).toHaveLength(1);
  });

  it('upserts on repeat lookup — refreshes mutable fields, never forks', async () => {
    const store = createInMemoryLookedUpPlayerStore();

    await store.remember(player({ gameName: 'Faker', profileIconId: 6, lastLookedUpAt: 1_000 }));
    await store.remember(
      player({ gameName: 'Faker Renamed', tagLine: 'KR2', profileIconId: 99, region: 'kr', lastLookedUpAt: 2_000 }),
    );

    expect(store.size).toBe(1);
    const [row] = await store.searchByNamePrefix('faker', 10);
    expect(row).toMatchObject({
      gameName: 'Faker Renamed',
      tagLine: 'KR2',
      profileIconId: 99,
      lastLookedUpAt: 2_000,
    });
  });

  it('keeps distinct PUUIDs as distinct records even with the same name', async () => {
    const store = createInMemoryLookedUpPlayerStore();

    await store.remember(player({ puuid: 'a', gameName: 'Bob', tagLine: 'NA1', lastLookedUpAt: 1 }));
    await store.remember(player({ puuid: 'b', gameName: 'Bob', tagLine: 'EUW', lastLookedUpAt: 2 }));

    expect(await store.searchByNamePrefix('bob', 10)).toHaveLength(2);
  });

  it('tolerates a null profileIconId', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await store.remember(player({ profileIconId: null }));

    const [row] = await store.searchByNamePrefix('fak', 10);
    expect(row.profileIconId).toBeNull();
  });
});

describe('InMemoryLookedUpPlayerStore.searchByNamePrefix — Requirement 3.5 / 2.x', () => {
  async function seeded() {
    const store = createInMemoryLookedUpPlayerStore();
    await store.remember(player({ puuid: '1', gameName: 'Faker', lastLookedUpAt: 300 }));
    await store.remember(player({ puuid: '2', gameName: 'FakerFan', lastLookedUpAt: 500 }));
    await store.remember(player({ puuid: '3', gameName: 'faketaxi', lastLookedUpAt: 100 }));
    await store.remember(player({ puuid: '4', gameName: 'Notrelated', lastLookedUpAt: 900 }));
    return store;
  }

  it('matches a start-anchored prefix, case-insensitively', async () => {
    const store = await seeded();

    const names = (await store.searchByNamePrefix('FAK', 10)).map((p) => p.gameName);
    expect(names).toEqual(expect.arrayContaining(['Faker', 'FakerFan', 'faketaxi']));
    expect(names).not.toContain('Notrelated');
  });

  it('does not match a substring that is not a prefix', async () => {
    const store = await seeded();
    expect(await store.searchByNamePrefix('related', 10)).toEqual([]);
  });

  it('orders by lastLookedUpAt descending', async () => {
    const store = await seeded();
    const names = (await store.searchByNamePrefix('fak', 10)).map((p) => p.gameName);
    expect(names).toEqual(['FakerFan', 'Faker', 'faketaxi']);
  });

  it('caps at the limit, keeping the most recent', async () => {
    const store = await seeded();
    const names = (await store.searchByNamePrefix('fak', 2)).map((p) => p.gameName);
    expect(names).toEqual(['FakerFan', 'Faker']);
  });

  it('returns empty for a non-positive limit or a blank prefix', async () => {
    const store = await seeded();
    expect(await store.searchByNamePrefix('fak', 0)).toEqual([]);
    expect(await store.searchByNamePrefix('fak', -3)).toEqual([]);
    expect(await store.searchByNamePrefix('   ', 10)).toEqual([]);
    expect(await store.searchByNamePrefix('', 10)).toEqual([]);
  });

  it('treats regex metacharacters in the prefix as literal text', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await store.remember(player({ puuid: 'x', gameName: 'a.b', lastLookedUpAt: 1 }));
    await store.remember(player({ puuid: 'y', gameName: 'axb', lastLookedUpAt: 2 }));

    const names = (await store.searchByNamePrefix('a.', 10)).map((p) => p.gameName);
    expect(names).toEqual(['a.b']);
  });

  it('returns copies — mutating the result does not change the store', async () => {
    const store = await seeded();
    const rows = await store.searchByNamePrefix('faker', 10);
    rows[0].gameName = 'mutated';

    const again = await store.searchByNamePrefix('faker', 10);
    expect(again.some((p) => p.gameName === 'mutated')).toBe(false);
  });
});

describe('InMemoryLookedUpPlayerStore.findByRiotId — autofill-search Requirement 9.2', () => {
  async function seeded() {
    const store = createInMemoryLookedUpPlayerStore();
    await store.remember(player({ puuid: 'a', gameName: 'Faker', tagLine: 'KR1' }));
    await store.remember(player({ puuid: 'b', gameName: 'Faker', tagLine: 'EUW' }));
    return store;
  }

  it('matches gameName and tagLine exactly, case-insensitively', async () => {
    const store = await seeded();
    expect(await store.findByRiotId('faker', 'kr1')).toMatchObject({ puuid: 'a' });
    expect(await store.findByRiotId('  FAKER  ', ' Euw ')).toMatchObject({ puuid: 'b' });
  });

  it('returns null when the tagLine does not match a known gameName', async () => {
    const store = await seeded();
    expect(await store.findByRiotId('Faker', 'NA1')).toBeNull();
  });

  it('returns null for an unknown name, or a blank part', async () => {
    const store = await seeded();
    expect(await store.findByRiotId('Chovy', 'KR1')).toBeNull();
    expect(await store.findByRiotId('', 'KR1')).toBeNull();
    expect(await store.findByRiotId('Faker', '  ')).toBeNull();
  });

  it('returns a copy — mutating it does not change the store', async () => {
    const store = await seeded();
    const found = await store.findByRiotId('Faker', 'KR1');
    found!.gameName = 'mutated';
    expect((await store.findByRiotId('Faker', 'KR1'))?.gameName).toBe('Faker');
  });
});

describe('InMemoryLookedUpPlayerStore.deleteByPuuid — Requirement 5.1', () => {
  it('removes the record and returns 1, then 0 on a repeat', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    await store.remember(player());

    expect(await store.deleteByPuuid('puuid-1')).toBe(1);
    expect(await store.deleteByPuuid('puuid-1')).toBe(0);
    expect(await store.searchByNamePrefix('fak', 10)).toEqual([]);
  });

  it('returns 0 for a PUUID that was never remembered', async () => {
    const store = createInMemoryLookedUpPlayerStore();
    expect(await store.deleteByPuuid('nobody')).toBe(0);
  });
});

describe('createNoopLookedUpPlayerStore — disabled Persistent_Store', () => {
  it('remembers nothing and searches empty', async () => {
    const store = createNoopLookedUpPlayerStore();

    await expect(store.remember(player())).resolves.toBeUndefined();
    expect(await store.searchByNamePrefix('faker', 10)).toEqual([]);
    expect(await store.findByRiotId('faker', 'kr1')).toBeNull();
    expect(await store.deleteByPuuid('puuid-1')).toBe(0);
  });
});
