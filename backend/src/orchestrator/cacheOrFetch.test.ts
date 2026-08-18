import { describe, it, expect } from 'vitest';
import {
  TTL_BY_ENDPOINT,
  createInMemoryCacheStore,
  type CacheEntry,
  type CacheKey,
  type CacheStore,
  type PuuidDeletionResult,
} from '../cache';
import type { RiotApiResult } from '../riotApiClient';
import { cacheOrFetch, isCacheOrFetchFailure } from './cacheOrFetch';

/**
 * Example tests for `cacheOrFetch` (task 13.1). The clock is a mutable counter,
 * so nothing here waits on a real timer, and the "fetch" is always a local
 * function — no network, no credential.
 */

const KEY: CacheKey = { endpoint: 'league', routingValue: 'na1', params: { puuid: 'puuid-1' } };
const LEAGUE_TTL = TTL_BY_ENDPOINT.league as number;

interface Payload {
  token: string;
}

function ok(token: string): Promise<RiotApiResult<Payload>> {
  return Promise.resolve({ kind: 'ok', data: { token } });
}

/** A store that throws on every operation, to exercise the degradation paths. */
class UnavailableCacheStore implements CacheStore {
  getCalls = 0;
  setCalls = 0;

  async get<T>(_key: CacheKey): Promise<CacheEntry<T> | undefined> {
    this.getCalls += 1;
    throw new Error('cache unavailable');
  }

  async set<T>(_key: CacheKey, _value: T, _ttlMs: number | 'infinite'): Promise<void> {
    this.setCalls += 1;
    throw new Error('cache unavailable');
  }

  async deleteByPuuid(_puuid: string): Promise<PuuidDeletionResult> {
    throw new Error('cache unavailable');
  }
}

describe('cacheOrFetch', () => {
  it('serves a fresh entry without fetching (Requirement 10.5)', async () => {
    let clock = 1_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    await cache.set(KEY, { token: 'cached' }, LEAGUE_TTL);

    clock += LEAGUE_TTL; // exactly at the boundary: still fresh
    let fetchCalls = 0;
    const outcome = await cacheOrFetch<Payload>(
      cache,
      KEY,
      LEAGUE_TTL,
      () => {
        fetchCalls += 1;
        return ok('fresh');
      },
      () => clock,
    );

    expect(fetchCalls).toBe(0);
    expect(outcome).toEqual({ value: { token: 'cached' }, fromCache: true, retrievedAt: 1_000 });
  });

  it('refetches once the entry is stale and reports the value as not from cache', async () => {
    let clock = 1_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    await cache.set(KEY, { token: 'cached' }, LEAGUE_TTL);

    clock += LEAGUE_TTL + 1;
    const outcome = await cacheOrFetch<Payload>(cache, KEY, LEAGUE_TTL, () => ok('fresh'), () => clock);

    expect(outcome).toEqual({ value: { token: 'fresh' }, fromCache: false, retrievedAt: clock });
    const stored = await cache.get<Payload>(KEY);
    expect(stored?.value).toEqual({ token: 'fresh' });
    expect(stored?.retrievedAt).toBe(clock);
  });

  it('passes the caller-supplied TTL through to the store', async () => {
    const clock = 500;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const matchKey: CacheKey = { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'NA1_1' } };

    await cacheOrFetch<Payload>(
      cache,
      matchKey,
      TTL_BY_ENDPOINT.matchDetail,
      () => ok('match'),
      () => clock,
    );

    const stored = await cache.get<Payload>(matchKey);
    expect(stored?.ttlMs).toBe('infinite');
  });

  it('preserves the failure reason so callers can apply the Requirement 9 error table', async () => {
    const clock = 0;
    const cache = createInMemoryCacheStore({ now: () => clock });

    const outcome = await cacheOrFetch<Payload>(
      cache,
      KEY,
      LEAGUE_TTL,
      () => Promise.resolve<RiotApiResult<Payload>>({ kind: 'auth_error', status: 403 }),
      () => clock,
    );

    expect(isCacheOrFetchFailure(outcome)).toBe(true);
    expect(outcome).toEqual({ failed: true, failure: { kind: 'auth_error', status: 403 } });
  });

  it('leaves a stale entry in place when the refresh fails (Requirement 10.7)', async () => {
    let clock = 1_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    await cache.set(KEY, { token: 'cached' }, LEAGUE_TTL);

    clock += LEAGUE_TTL + 1;
    const outcome = await cacheOrFetch<Payload>(
      cache,
      KEY,
      LEAGUE_TTL,
      () => Promise.resolve<RiotApiResult<Payload>>({ kind: 'server_error', status: 503 }),
      () => clock,
    );

    expect(isCacheOrFetchFailure(outcome)).toBe(true);
    const stored = await cache.get<Payload>(KEY);
    expect(stored?.value).toEqual({ token: 'cached' });
    expect(stored?.retrievedAt).toBe(1_000);
  });

  it('still returns the fetched value when the cache write throws (Requirement 10.8)', async () => {
    const cache = new UnavailableCacheStore();
    const clock = 42;

    const outcome = await cacheOrFetch<Payload>(cache, KEY, LEAGUE_TTL, () => ok('fresh'), () => clock);

    expect(cache.setCalls).toBe(1);
    expect(outcome).toEqual({ value: { token: 'fresh' }, fromCache: false, retrievedAt: 42 });
  });

  it('treats a cache read failure as a miss rather than a lookup failure', async () => {
    const cache = new UnavailableCacheStore();
    const clock = 7;
    let fetchCalls = 0;

    const outcome = await cacheOrFetch<Payload>(
      cache,
      KEY,
      LEAGUE_TTL,
      () => {
        fetchCalls += 1;
        return ok('fresh');
      },
      () => clock,
    );

    expect(cache.getCalls).toBe(1);
    expect(fetchCalls).toBe(1);
    expect(isCacheOrFetchFailure(outcome)).toBe(false);
  });

  it('propagates an exception out of fetch instead of disguising a defect as a failure', async () => {
    const clock = 0;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const defect = new Error('client defect');

    await expect(
      cacheOrFetch<Payload>(cache, KEY, LEAGUE_TTL, () => Promise.reject(defect), () => clock),
    ).rejects.toBe(defect);
  });
});
