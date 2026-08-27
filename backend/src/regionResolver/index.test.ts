import { describe, it, expect } from 'vitest';
import { createInMemoryCacheStore } from '../cache';
import type { AccountRegionDto, RiotApiClient, RiotApiResult } from '../riotApiClient';
import { createRegionResolver } from './index';

const PUUID = 'puuid-1';

/** Only `getRegionByPuuid` is exercised by this resolver; everything else throws if reached. */
function fakeClient(respond: (puuid: string) => Promise<RiotApiResult<AccountRegionDto>>): RiotApiClient {
  return {
    getAccountByRiotId: () => {
      throw new Error('not used by RegionResolver');
    },
    getRegionByPuuid: (_region, _game, puuid) => respond(puuid),
    getSummonerByPuuid: () => {
      throw new Error('not used by RegionResolver');
    },
    getLeagueEntriesByPuuid: () => {
      throw new Error('not used by RegionResolver');
    },
    getMatchIdsByPuuid: () => {
      throw new Error('not used by RegionResolver');
    },
    getMatchById: () => {
      throw new Error('not used by RegionResolver');
    },
    getMatchTimeline: () => {
      throw new Error('not used by RegionResolver');
    },
  };
}

function fixedClock(value = 1_000_000) {
  return () => value;
}

describe('RegionResolver', () => {
  it('resolves a supported lowercase platform to its region', async () => {
    let calls = 0;
    const client = fakeClient((puuid) => {
      calls += 1;
      return Promise.resolve({ kind: 'ok', data: { puuid, game: 'lol', region: 'euw1' } });
    });
    const resolver = createRegionResolver({
      client,
      cache: createInMemoryCacheStore(),
      discoveryRegion: 'europe',
      now: fixedClock(),
    });

    await expect(resolver.resolve(PUUID)).resolves.toEqual({
      kind: 'resolved',
      platform: 'euw1',
      region: 'europe',
    });
    expect(calls).toBe(1);
  });

  it('normalises an uppercase platform before checking support (Requirement 3.4)', async () => {
    const client = fakeClient(() =>
      Promise.resolve({ kind: 'ok', data: { puuid: PUUID, game: 'lol', region: 'NA1' } }),
    );
    const resolver = createRegionResolver({
      client,
      cache: createInMemoryCacheStore(),
      discoveryRegion: 'americas',
      now: fixedClock(),
    });

    await expect(resolver.resolve(PUUID)).resolves.toEqual({
      kind: 'resolved',
      platform: 'na1',
      region: 'americas',
    });
  });

  it('reports unsupported_platform for a platform outside the closed mapping, naming it verbatim', async () => {
    const client = fakeClient(() =>
      Promise.resolve({ kind: 'ok', data: { puuid: PUUID, game: 'lol', region: 'vn2' } }),
    );
    const resolver = createRegionResolver({
      client,
      cache: createInMemoryCacheStore(),
      discoveryRegion: 'asia',
      now: fixedClock(),
    });

    await expect(resolver.resolve(PUUID)).resolves.toEqual({
      kind: 'unsupported_platform',
      platform: 'vn2',
    });
  });

  it('reports no_lol_account on a 404 (decision 1)', async () => {
    const client = fakeClient(() => Promise.resolve({ kind: 'not_found' }));
    const resolver = createRegionResolver({
      client,
      cache: createInMemoryCacheStore(),
      discoveryRegion: 'americas',
      now: fixedClock(),
    });

    await expect(resolver.resolve(PUUID)).resolves.toEqual({ kind: 'no_lol_account' });
  });

  it('reports failed with the underlying cause for any other Riot failure', async () => {
    const client = fakeClient(() => Promise.resolve({ kind: 'rate_limited', retryAfterSeconds: 3 }));
    const resolver = createRegionResolver({
      client,
      cache: createInMemoryCacheStore(),
      discoveryRegion: 'americas',
      now: fixedClock(),
    });

    await expect(resolver.resolve(PUUID)).resolves.toEqual({
      kind: 'failed',
      cause: { kind: 'rate_limited', retryAfterSeconds: 3 },
    });
  });

  it('serves a cached resolution without calling the client again (Requirement 6.2/6.3)', async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      return Promise.resolve({ kind: 'ok', data: { puuid: PUUID, game: 'lol', region: 'euw1' } });
    });
    const cache = createInMemoryCacheStore();
    const resolver = createRegionResolver({ client, cache, discoveryRegion: 'europe', now: fixedClock() });

    await resolver.resolve(PUUID);
    const second = await resolver.resolve(PUUID);

    expect(calls).toBe(1);
    expect(second).toEqual({ kind: 'resolved', platform: 'euw1', region: 'europe' });
  });

  it('keys the cache entry so two different PUUIDs never share a cached resolution', async () => {
    const responses: Record<string, string> = { 'puuid-a': 'euw1', 'puuid-b': 'na1' };
    let calls = 0;
    const client = fakeClient((puuid) => {
      calls += 1;
      return Promise.resolve({ kind: 'ok', data: { puuid, game: 'lol', region: responses[puuid] } });
    });
    const cache = createInMemoryCacheStore();
    const resolver = createRegionResolver({ client, cache, discoveryRegion: 'europe', now: fixedClock() });

    const a = await resolver.resolve('puuid-a');
    const b = await resolver.resolve('puuid-b');

    expect(calls).toBe(2);
    expect(a).toEqual({ kind: 'resolved', platform: 'euw1', region: 'europe' });
    expect(b).toEqual({ kind: 'resolved', platform: 'na1', region: 'americas' });
  });
});
