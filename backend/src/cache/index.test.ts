import { describe, it, expect } from 'vitest';
import {
  TTL_BY_ENDPOINT,
  buildCacheKey,
  createInMemoryCacheStore,
  isStale,
  type CacheKey,
} from './index';

const ONE_HOUR_MS = 3_600_000;
const TEN_MINUTES_MS = 600_000;
const TWENTY_FOUR_HOURS_MS = 86_400_000;

/** Fake clock: tests never rely on wall-clock time. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('TTL_BY_ENDPOINT', () => {
  // Requirements 10.2, 10.3, 10.4 / design.md TTL table
  it('matches the design TTL table exactly', () => {
    expect(TTL_BY_ENDPOINT).toEqual({
      account: ONE_HOUR_MS,
      accountRegion: TWENTY_FOUR_HOURS_MS,
      summoner: ONE_HOUR_MS,
      league: TEN_MINUTES_MS,
      matchIds: TEN_MINUTES_MS,
      matchDetail: 'infinite',
      timelineSlice: 'infinite',
    });
  });
});

describe('buildCacheKey', () => {
  // Requirement 10.1
  it('is deterministic for the same input', () => {
    const key: CacheKey = { endpoint: 'summoner', routingValue: 'na1', params: { puuid: 'p-1' } };
    expect(buildCacheKey(key)).toBe(buildCacheKey({ ...key, params: { ...key.params } }));
  });

  it('ignores param insertion order', () => {
    const a = buildCacheKey({
      endpoint: 'account',
      routingValue: 'americas',
      params: { gameName: 'Faker', tagLine: 'KR1' },
    });
    const b = buildCacheKey({
      endpoint: 'account',
      routingValue: 'americas',
      params: { tagLine: 'KR1', gameName: 'Faker' },
    });
    expect(a).toBe(b);
  });

  it('distinguishes different endpoints', () => {
    const params = { puuid: 'p-1' };
    expect(buildCacheKey({ endpoint: 'summoner', routingValue: 'na1', params })).not.toBe(
      buildCacheKey({ endpoint: 'league', routingValue: 'na1', params }),
    );
  });

  it('distinguishes different routing values', () => {
    const params = { puuid: 'p-1' };
    expect(buildCacheKey({ endpoint: 'league', routingValue: 'na1', params })).not.toBe(
      buildCacheKey({ endpoint: 'league', routingValue: 'euw1', params }),
    );
  });

  it('distinguishes different param values and different param sets', () => {
    const base = { endpoint: 'matchDetail', routingValue: 'americas' } as const;
    expect(buildCacheKey({ ...base, params: { matchId: 'NA1_1' } })).not.toBe(
      buildCacheKey({ ...base, params: { matchId: 'NA1_2' } }),
    );
    expect(buildCacheKey({ ...base, params: { matchId: 'NA1_1' } })).not.toBe(
      buildCacheKey({ ...base, params: { matchId: 'NA1_1', extra: '' } }),
    );
  });

  // Delimiter-collision aliasing: a naive join(':') would map these to one key
  it('does not alias tuples whose params contain delimiter-like characters', () => {
    const base = { endpoint: 'account', routingValue: 'americas' } as const;
    expect(buildCacheKey({ ...base, params: { 'a:b': 'c' } })).not.toBe(
      buildCacheKey({ ...base, params: { a: 'b:c' } }),
    );
    expect(buildCacheKey({ ...base, params: { 'a|b': 'c' } })).not.toBe(
      buildCacheKey({ ...base, params: { a: 'b|c' } }),
    );
    expect(buildCacheKey({ ...base, params: { 'a=b': '' } })).not.toBe(
      buildCacheKey({ ...base, params: { a: '=b' } }),
    );
    expect(
      buildCacheKey({ endpoint: 'account', routingValue: 'americas#europe', params: {} }),
    ).not.toBe(buildCacheKey({ endpoint: 'account', routingValue: 'americas', params: { '#europe': '' } }));
  });
});

describe('isStale', () => {
  // Requirement 10.2 / 10.3: non-stale at the boundary, stale just past it
  it('treats finite TTLs as fresh up to and including the boundary', () => {
    for (const ttlMs of [ONE_HOUR_MS, TEN_MINUTES_MS]) {
      const entry = { value: 1, retrievedAt: 1_000, ttlMs };
      expect(isStale(entry, 1_000)).toBe(false);
      expect(isStale(entry, 1_000 + ttlMs - 1)).toBe(false);
      expect(isStale(entry, 1_000 + ttlMs)).toBe(false);
      expect(isStale(entry, 1_000 + ttlMs + 1)).toBe(true);
    }
  });

  // Requirement 10.4
  it('never treats an infinite entry as stale, even after a very long time', () => {
    const entry = { value: 'match', retrievedAt: 0, ttlMs: 'infinite' as const };
    expect(isStale(entry, 0)).toBe(false);
    expect(isStale(entry, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('treats a backwards clock as non-stale rather than stale', () => {
    expect(isStale({ value: 1, retrievedAt: 5_000, ttlMs: 1_000 }, 4_000)).toBe(false);
  });
});

describe('InMemoryCacheStore', () => {
  it('returns the stored entry with the clock-derived retrievedAt and given ttl', async () => {
    const clock = fakeClock(50_000);
    const store = createInMemoryCacheStore({ now: clock.now });
    const key: CacheKey = { endpoint: 'summoner', routingValue: 'na1', params: { puuid: 'p-1' } };

    await store.set(key, { summonerLevel: 300 }, TTL_BY_ENDPOINT.summoner);

    const entry = await store.get<{ summonerLevel: number }>(key);
    expect(entry).toEqual({
      value: { summonerLevel: 300 },
      retrievedAt: 50_000,
      ttlMs: ONE_HOUR_MS,
    });
  });

  it('returns undefined for an absent key', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    expect(await store.get({ endpoint: 'league', routingValue: 'na1', params: { puuid: 'nope' } })).toBeUndefined();
  });

  it('reads back a value written under a differently-ordered params object', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await store.set(
      { endpoint: 'account', routingValue: 'americas', params: { gameName: 'Faker', tagLine: 'KR1' } },
      { puuid: 'p-1' },
      TTL_BY_ENDPOINT.account,
    );
    const entry = await store.get<{ puuid: string }>({
      endpoint: 'account',
      routingValue: 'americas',
      params: { tagLine: 'KR1', gameName: 'Faker' },
    });
    expect(entry?.value).toEqual({ puuid: 'p-1' });
  });

  // Requirement 10.7 depends on `get` surfacing stale entries
  it('returns a stale entry rather than undefined', async () => {
    const clock = fakeClock(0);
    const store = createInMemoryCacheStore({ now: clock.now });
    const key: CacheKey = { endpoint: 'league', routingValue: 'na1', params: { puuid: 'p-1' } };

    await store.set(key, ['entry'], TTL_BY_ENDPOINT.league);
    clock.advance(TEN_MINUTES_MS + 1);

    const entry = await store.get<string[]>(key);
    expect(entry).toBeDefined();
    expect(entry?.value).toEqual(['entry']);
    expect(isStale(entry!, clock.now())).toBe(true);
  });

  it('overwrites an existing entry with a new retrievedAt', async () => {
    const clock = fakeClock(0);
    const store = createInMemoryCacheStore({ now: clock.now });
    const key: CacheKey = { endpoint: 'league', routingValue: 'na1', params: { puuid: 'p-1' } };

    await store.set(key, 'first', TTL_BY_ENDPOINT.league);
    clock.advance(1_234);
    await store.set(key, 'second', TTL_BY_ENDPOINT.league);

    expect(await store.get(key)).toEqual({ value: 'second', retrievedAt: 1_234, ttlMs: TEN_MINUTES_MS });
    expect(store.size).toBe(1);
  });

  it('keeps entries for different endpoints and routing values separate', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    const params = { puuid: 'p-1' };

    await store.set({ endpoint: 'summoner', routingValue: 'na1', params }, 'summoner-na1', TTL_BY_ENDPOINT.summoner);
    await store.set({ endpoint: 'league', routingValue: 'na1', params }, 'league-na1', TTL_BY_ENDPOINT.league);
    await store.set({ endpoint: 'summoner', routingValue: 'euw1', params }, 'summoner-euw1', TTL_BY_ENDPOINT.summoner);

    expect(store.size).toBe(3);
    expect((await store.get({ endpoint: 'summoner', routingValue: 'na1', params }))?.value).toBe('summoner-na1');
    expect((await store.get({ endpoint: 'league', routingValue: 'na1', params }))?.value).toBe('league-na1');
    expect((await store.get({ endpoint: 'summoner', routingValue: 'euw1', params }))?.value).toBe('summoner-euw1');
  });
});

describe('InMemoryCacheStore.deleteByPuuid', () => {
  const TARGET = 'puuid-target';
  const OTHER = 'puuid-other';

  /** A MatchDto-shaped value with two participants, one of them the target. */
  function matchDetailValue(targetPuuid: string) {
    return {
      metadata: { matchId: 'NA1_1', participants: [targetPuuid, OTHER] },
      info: {
        gameDuration: 1800,
        participants: [
          {
            puuid: targetPuuid,
            summonerName: 'TargetName',
            summonerId: 'summ-target',
            riotIdGameName: 'Target',
            riotIdTagline: 'NA1',
            championName: 'Ahri',
            teamPosition: 'MIDDLE',
            kills: 7,
            deaths: 2,
            assists: 9,
            visionScore: 21,
            win: true,
          },
          {
            puuid: OTHER,
            summonerName: 'OtherName',
            summonerId: 'summ-other',
            championName: 'Garen',
            teamPosition: 'TOP',
            kills: 1,
            deaths: 8,
            assists: 3,
            visionScore: 9,
            win: false,
          },
        ],
      },
    };
  }

  async function populate(store: ReturnType<typeof createInMemoryCacheStore>, puuid: string) {
    await store.set({ endpoint: 'summoner', routingValue: 'na1', params: { puuid } }, { summonerLevel: 300 }, TTL_BY_ENDPOINT.summoner);
    await store.set({ endpoint: 'league', routingValue: 'na1', params: { puuid } }, [{ tier: 'GOLD' }], TTL_BY_ENDPOINT.league);
    await store.set({ endpoint: 'matchIds', routingValue: 'americas', params: { puuid } }, ['NA1_1'], TTL_BY_ENDPOINT.matchIds);
    await store.set(
      { endpoint: 'account', routingValue: 'americas', params: { gameName: 'Target', tagLine: 'NA1' } },
      { puuid, gameName: 'Target', tagLine: 'NA1' },
      TTL_BY_ENDPOINT.account,
    );
    await store.set(
      { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_1' } },
      matchDetailValue(puuid),
      TTL_BY_ENDPOINT.matchDetail,
    );
  }

  // Requirement 12.4, 12.5
  it('removes summoner, league and matchIds entries keyed by the PUUID', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await populate(store, TARGET);

    const result = await store.deleteByPuuid(TARGET);

    expect(result.found).toBe(true);
    expect(await store.get({ endpoint: 'summoner', routingValue: 'na1', params: { puuid: TARGET } })).toBeUndefined();
    expect(await store.get({ endpoint: 'league', routingValue: 'na1', params: { puuid: TARGET } })).toBeUndefined();
    expect(await store.get({ endpoint: 'matchIds', routingValue: 'americas', params: { puuid: TARGET } })).toBeUndefined();
  });

  // Requirement 12.4/12.5: account entries are keyed by name/tag but their value
  // is a Riot-ID-to-PUUID association, so they are removed too.
  it('removes account entries whose cached value contains the PUUID', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await populate(store, TARGET);

    await store.deleteByPuuid(TARGET);

    expect(
      await store.get({ endpoint: 'account', routingValue: 'americas', params: { gameName: 'Target', tagLine: 'NA1' } }),
    ).toBeUndefined();
  });

  /**
   * Requirement 12.5. Match details in which the subject participated are EVICTED,
   * not retained-and-redacted.
   *
   * The original design redacted the subject's participant record in place, on the
   * theory that Requirement 12.4 permits keeping aggregate non-identifying data.
   * Live testing showed that breaks the subject's future reports permanently —
   * indefinitely-cached entries (Requirement 10.4) are never stale, so the redacted
   * copy is served forever and every one of their matches is excluded — and the
   * privacy argument never held either, since nine other participants' PUUIDs and
   * summoner names remain in the retained value.
   */
  it('evicts a matchDetail entry in which the subject participated', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await populate(store, TARGET);

    const result = await store.deleteByPuuid(TARGET);

    expect(result.removedMatchDetailCount).toBe(1);
    expect(
      await store.get({ endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_1' } }),
    ).toBeUndefined();
  });

  it('leaves the PUUID nowhere in the store, in any key or value', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await populate(store, TARGET);

    await store.deleteByPuuid(TARGET);

    expect(JSON.stringify(store.dumpForVerification())).not.toContain(TARGET);
  });

  it('never mutates a retained value, so a caller holding a reference sees no change', async () => {
    // Eviction replaced in-place redaction precisely so cached values are immutable
    // snapshots; a match with no involvement from the subject must come back
    // byte-identical.
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    const untouched = matchDetailValue(OTHER);
    const before = JSON.stringify(untouched);
    await store.set(
      { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_9' } },
      untouched,
      TTL_BY_ENDPOINT.matchDetail,
    );

    await store.deleteByPuuid(TARGET);

    const entry = await store.get<ReturnType<typeof matchDetailValue>>({
      endpoint: 'matchDetail',
      routingValue: 'americas',
      params: { matchId: 'NA1_9' },
    });
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry!.value)).toBe(before);
  });

  it('does not evict a match the subject did not play in, even in the same store', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await populate(store, TARGET);
    await store.set(
      { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_2' } },
      matchDetailValue(OTHER),
      TTL_BY_ENDPOINT.matchDetail,
    );

    const result = await store.deleteByPuuid(TARGET);

    expect(result.removedMatchDetailCount).toBe(1);
    expect(
      await store.get({ endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_2' } }),
    ).toBeDefined();
  });

  it('leaves entries belonging to an unrelated PUUID untouched', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await store.set({ endpoint: 'summoner', routingValue: 'na1', params: { puuid: OTHER } }, { summonerLevel: 42 }, TTL_BY_ENDPOINT.summoner);
    await store.set({ endpoint: 'league', routingValue: 'na1', params: { puuid: TARGET } }, ['x'], TTL_BY_ENDPOINT.league);

    await store.deleteByPuuid(TARGET);

    expect((await store.get<{ summonerLevel: number }>({ endpoint: 'summoner', routingValue: 'na1', params: { puuid: OTHER } }))?.value).toEqual({
      summonerLevel: 42,
    });
    expect(store.size).toBe(1);
  });

  // Requirement 12.5 then 12.6
  it('reports found on the first call and not-found on an immediate repeat', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await populate(store, TARGET);

    expect((await store.deleteByPuuid(TARGET)).found).toBe(true);

    const second = await store.deleteByPuuid(TARGET);
    expect(second).toEqual({ found: false, removedEntryCount: 0, removedMatchDetailCount: 0 });
  });

  // Requirement 12.6: never an error
  it('reports not-found for a PUUID that was never cached', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await store.set({ endpoint: 'summoner', routingValue: 'na1', params: { puuid: OTHER } }, 'x', TTL_BY_ENDPOINT.summoner);

    await expect(store.deleteByPuuid('puuid-never-seen')).resolves.toEqual({
      found: false,
      removedEntryCount: 0,
      removedMatchDetailCount: 0,
    });
    expect(store.size).toBe(1);
  });

  it('reports found when only a matchDetail eviction occurred, with no keyed entries present', async () => {
    const store = createInMemoryCacheStore({ now: fakeClock().now });
    await store.set(
      { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_1' } },
      matchDetailValue(TARGET),
      TTL_BY_ENDPOINT.matchDetail,
    );

    const result = await store.deleteByPuuid(TARGET);

    expect(result).toEqual({ found: true, removedEntryCount: 0, removedMatchDetailCount: 1 });
    expect(store.size).toBe(0);
  });
});
