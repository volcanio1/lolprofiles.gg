import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  TTL_BY_ENDPOINT,
  createInMemoryCacheStore,
  type CacheEntry,
  type CacheEndpoint,
  type CacheKey,
  type CacheStore,
  type InMemoryCacheStore,
  type PuuidDeletionResult,
} from '../cache';
import type { RiotApiResult } from '../riotApiClient';
import { cacheOrFetch, isCacheOrFetchFailure, type RiotApiFailure } from './cacheOrFetch';

/**
 * Properties 18 and 19 (tasks 13.2 and 13.3).
 *
 * The REAL `InMemoryCacheStore` is used, wrapped in a fault-injecting decorator,
 * so these properties exercise the actual staleness semantics rather than a
 * simplified stand-in. The clock is a fake counter; no wall-clock read, no real
 * timer, no network and no credential appears anywhere in this file.
 */

const ENDPOINTS: readonly CacheEndpoint[] = ['account', 'summoner', 'league', 'matchIds', 'matchDetail'];

/**
 * Retention transcribed independently from Requirements 10.2-10.4 rather than
 * imported, so the oracle for "is this entry stale" is stated from the
 * specification instead of from the module under test.
 */
const EXPECTED_RETENTION_MS: Readonly<Record<CacheEndpoint, number | 'infinite'>> = {
  account: 60 * 60 * 1000,
  summoner: 60 * 60 * 1000,
  league: 10 * 60 * 1000,
  matchIds: 10 * 60 * 1000,
  matchDetail: 'infinite',
};

/** Independent staleness oracle: non-stale up to and including the boundary. */
function expectedStale(endpoint: CacheEndpoint, elapsed: number): boolean {
  const retention = EXPECTED_RETENTION_MS[endpoint];
  return retention === 'infinite' ? false : elapsed > retention;
}

/** Payload shape stored in the cache; distinguishable per source. */
interface Payload {
  source: 'cached' | 'fetched';
  token: string;
}

/**
 * Wraps a real store so a test can make `get` or `set` throw. Requirement 10.8
 * (write failure) and `cacheOrFetch`'s decision 3 (read failure) are both about
 * a cache that misbehaves, which cannot be exercised through a healthy store.
 */
class FaultInjectingCacheStore implements CacheStore {
  setCalls = 0;
  constructor(
    private readonly inner: InMemoryCacheStore,
    private readonly faults: { failGet?: boolean; failSet?: boolean } = {},
  ) {}

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | undefined> {
    if (this.faults.failGet === true) {
      throw new Error('cache read unavailable');
    }
    return this.inner.get<T>(key);
  }

  async set<T>(key: CacheKey, value: T, ttlMs: number | 'infinite'): Promise<void> {
    this.setCalls += 1;
    if (this.faults.failSet === true) {
      throw new Error('cache write unavailable');
    }
    return this.inner.set(key, value, ttlMs);
  }

  async deleteByPuuid(puuid: string): Promise<PuuidDeletionResult> {
    return this.inner.deleteByPuuid(puuid);
  }
}

const endpointArb = fc.constantFrom(...ENDPOINTS);
const tokenArb = fc.string({ minLength: 1, maxLength: 8 });

const keyForArb = (endpoint: CacheEndpoint): fc.Arbitrary<CacheKey> =>
  fc.record({
    endpoint: fc.constant(endpoint),
    routingValue: fc.constantFrom('americas', 'europe', 'asia', 'sea', 'na1', 'euw1', 'kr'),
    params: fc.oneof(
      fc.record({ puuid: tokenArb }),
      fc.record({ matchId: tokenArb }),
      fc.record({ gameName: tokenArb, tagLine: tokenArb }),
    ),
  });

/** Every non-`ok` variant of `RiotApiResult`, so the failure branch is exhaustive. */
const failureArb: fc.Arbitrary<RiotApiFailure> = fc.oneof(
  fc.constant<RiotApiFailure>({ kind: 'not_found' }),
  fc.constant<RiotApiFailure>({ kind: 'rate_limited' }),
  fc.integer({ min: 0, max: 120 }).map<RiotApiFailure>((retryAfterSeconds) => ({
    kind: 'rate_limited',
    retryAfterSeconds,
  })),
  fc.constantFrom<500 | 502 | 503 | 504>(500, 502, 503, 504).map<RiotApiFailure>((status) => ({
    kind: 'server_error',
    status,
  })),
  fc.constantFrom<401 | 403>(401, 403).map<RiotApiFailure>((status) => ({ kind: 'auth_error', status })),
  fc.constant<RiotApiFailure>({ kind: 'timeout' }),
  fc.constant<RiotApiFailure>({ kind: 'network_error' }),
);

describe('cacheOrFetch properties', () => {
  // Feature: lolprofiles-gg, Property 18: Non-stale cache entries are served without invoking the Riot API client
  // **Validates: Requirements 10.5**
  it('returns the cached value and never invokes the fetch function when a non-stale entry exists', async () => {
    /**
     * `elapsed` is constrained to the endpoint's retention period, so every
     * generated case really does have a non-stale entry — the situation the
     * property quantifies over.
     */
    const caseArb = endpointArb.chain((endpoint) => {
      const retention = EXPECTED_RETENTION_MS[endpoint];
      const elapsedArb =
        retention === 'infinite'
          ? fc.oneof(
              fc.integer({ min: 0, max: 365 * 24 * 60 * 60 * 1000 }),
              fc.constantFrom(0, 1, Number.MAX_SAFE_INTEGER / 2),
            )
          : fc.oneof(fc.integer({ min: 0, max: retention }), fc.constantFrom(0, 1, retention));
      return fc.record({
        endpoint: fc.constant(endpoint),
        key: keyForArb(endpoint),
        elapsed: elapsedArb,
        cachedToken: tokenArb,
        start: fc.integer({ min: 0, max: 1_000_000 }),
      });
    });

    const endpointCounts: Record<CacheEndpoint, number> = {
      account: 0,
      summoner: 0,
      league: 0,
      matchIds: 0,
      matchDetail: 0,
    };
    let boundaryCount = 0;

    await fc.assert(
      fc.asyncProperty(caseArb, async ({ endpoint, key, elapsed, cachedToken, start }) => {
        endpointCounts[endpoint] += 1;
        const retention = EXPECTED_RETENTION_MS[endpoint];
        if (retention !== 'infinite' && elapsed === retention) {
          boundaryCount += 1;
        }
        // Guard: this generator must only produce non-stale cases.
        expect(expectedStale(endpoint, elapsed)).toBe(false);

        let clock = start;
        const inner = createInMemoryCacheStore({ now: () => clock });
        const store = new FaultInjectingCacheStore(inner);
        const cached: Payload = { source: 'cached', token: cachedToken };
        await store.set(key, cached, TTL_BY_ENDPOINT[endpoint]);
        const setCallsAfterSeeding = store.setCalls;

        clock = start + elapsed;

        let fetchCalls = 0;
        const outcome = await cacheOrFetch<Payload>(
          store,
          key,
          TTL_BY_ENDPOINT[endpoint],
          () => {
            fetchCalls += 1;
            // Deliberately a DIFFERENT value: if the implementation fetched, the
            // value assertions below could not pass by accident.
            return Promise.resolve<RiotApiResult<Payload>>({
              kind: 'ok',
              data: { source: 'fetched', token: `${cachedToken}-fresh` },
            });
          },
          () => clock,
        );

        // The Riot API client is never reached.
        expect(fetchCalls).toBe(0);
        // Nor is the cache written again.
        expect(store.setCalls).toBe(setCallsAfterSeeding);

        expect(isCacheOrFetchFailure(outcome)).toBe(false);
        if (isCacheOrFetchFailure(outcome)) {
          return;
        }
        expect(outcome.value).toEqual(cached);
        expect(outcome.fromCache).toBe(true);
        expect(outcome.retrievedAt).toBe(start);

        // The stored entry is untouched.
        const stillStored = await inner.get<Payload>(key);
        expect(stillStored?.value).toEqual(cached);
        expect(stillStored?.retrievedAt).toBe(start);
      }),
      {
        numRuns: 300,
        /**
         * Examples run BEFORE random generation, which makes the coverage guards
         * below guarantees rather than seed-dependent likelihoods. One per
         * endpoint, each sitting exactly ON the inclusive staleness boundary —
         * the case most likely to be missed by a random draw and the one most
         * likely to regress, since Requirements 10.2/10.3 say "at least".
         */
        examples: ENDPOINTS.map((endpoint) => {
          const retention = EXPECTED_RETENTION_MS[endpoint];
          return [
            {
              endpoint,
              key: {
                endpoint,
                routingValue: 'na1',
                params: { puuid: 'boundary' },
              } as CacheKey,
              elapsed: retention === 'infinite' ? 365 * 24 * 60 * 60 * 1000 : retention,
              cachedToken: 'boundary',
              start: 1_000,
            },
          ] as const;
        }) as [{ endpoint: CacheEndpoint; key: CacheKey; elapsed: number; cachedToken: string; start: number }][],
      },
    );

    // Guard against degenerate coverage: every endpoint, and the inclusive
    // staleness boundary itself, must have been exercised.
    for (const endpoint of ENDPOINTS) {
      expect(endpointCounts[endpoint]).toBeGreaterThan(0);
    }
    expect(boundaryCount).toBeGreaterThan(0);
  });

  // Feature: lolprofiles-gg, Property 19: Cache refresh either fully succeeds or leaves prior state untouched
  // **Validates: Requirements 10.6, 10.7, 10.8**
  it('refreshes stale-or-absent entries atomically, never overwrites on failure, and survives cache-write failures', async () => {
    type Prior = 'absent' | 'stale';
    type Fetch = { kind: 'ok' } | { kind: 'failure'; failure: RiotApiFailure };

    /**
     * `matchDetail` is excluded here: its TTL is `'infinite'`, so a stale entry is
     * unreachable for it (Requirement 10.4) and the "absent" case it can still
     * reach is already covered by the other endpoints. Including it would make the
     * `prior: 'stale'` branch silently unsatisfiable for a fifth of all runs.
     */
    const finiteEndpointArb = fc.constantFrom<CacheEndpoint>('account', 'summoner', 'league', 'matchIds');

    const caseArb = finiteEndpointArb.chain((endpoint) => {
      const retention = EXPECTED_RETENTION_MS[endpoint] as number;
      return fc.record({
        endpoint: fc.constant(endpoint),
        key: keyForArb(endpoint),
        prior: fc.constantFrom<Prior>('absent', 'stale'),
        // Strictly past the boundary, so the seeded entry really is stale.
        elapsed: fc.oneof(
          fc.integer({ min: retention + 1, max: retention * 4 }),
          fc.constant(retention + 1),
        ),
        fetchOutcome: fc.oneof(
          fc.constant<Fetch>({ kind: 'ok' }),
          failureArb.map<Fetch>((failure) => ({ kind: 'failure', failure })),
        ),
        failSet: fc.boolean(),
        cachedToken: tokenArb,
        fetchedToken: tokenArb,
        start: fc.integer({ min: 0, max: 1_000_000 }),
      });
    });

    let refreshedCount = 0;
    let failedFetchCount = 0;
    let writeFailureCount = 0;
    let staleCount = 0;
    let absentCount = 0;

    await fc.assert(
      fc.asyncProperty(
        caseArb,
        async ({ endpoint, key, prior, elapsed, fetchOutcome, failSet, cachedToken, fetchedToken, start }) => {
          let clock = start;
          const inner = createInMemoryCacheStore({ now: () => clock });
          const store = new FaultInjectingCacheStore(inner, { failSet });
          const ttl = TTL_BY_ENDPOINT[endpoint];

          const cached: Payload = { source: 'cached', token: cachedToken };
          if (prior === 'stale') {
            staleCount += 1;
            await inner.set(key, cached, ttl);
          } else {
            absentCount += 1;
          }

          clock = start + elapsed;
          // Guard: the seeded state really is the state the property assumes.
          const seeded = await inner.get<Payload>(key);
          if (prior === 'stale') {
            expect(seeded).toBeDefined();
            expect(expectedStale(endpoint, elapsed)).toBe(true);
          } else {
            expect(seeded).toBeUndefined();
          }

          const before = JSON.stringify(inner.dumpForVerification());
          const fetched: Payload = { source: 'fetched', token: fetchedToken };
          let fetchCalls = 0;

          const outcome = await cacheOrFetch<Payload>(
            store,
            key,
            ttl,
            () => {
              fetchCalls += 1;
              return Promise.resolve<RiotApiResult<Payload>>(
                fetchOutcome.kind === 'ok' ? { kind: 'ok', data: fetched } : fetchOutcome.failure,
              );
            },
            () => clock,
          );

          // Requirement 10.6: a stale-or-absent entry always triggers exactly one
          // refresh attempt.
          expect(fetchCalls).toBe(1);

          if (fetchOutcome.kind === 'failure') {
            failedFetchCount += 1;
            // The caller is informed of failure, with the reason preserved.
            expect(isCacheOrFetchFailure(outcome)).toBe(true);
            if (!isCacheOrFetchFailure(outcome)) {
              return;
            }
            expect(outcome.failure).toEqual(fetchOutcome.failure);
            // Requirement 10.7: the cache is byte-identical to before the attempt.
            // Absent stays absent; a stale entry keeps its previous value.
            expect(JSON.stringify(inner.dumpForVerification())).toBe(before);
            expect(store.setCalls).toBe(0);
            return;
          }

          // Requirements 10.6 / 10.8: a successful fetch is always returned.
          expect(isCacheOrFetchFailure(outcome)).toBe(false);
          if (isCacheOrFetchFailure(outcome)) {
            return;
          }
          expect(outcome.value).toEqual(fetched);
          expect(outcome.fromCache).toBe(false);
          expect(outcome.retrievedAt).toBe(clock);
          expect(store.setCalls).toBe(1);

          if (failSet) {
            writeFailureCount += 1;
            // Requirement 10.8: no failure is reported, and the store is exactly
            // as it was — the write never landed.
            expect(JSON.stringify(inner.dumpForVerification())).toBe(before);
            return;
          }

          // Requirement 10.6: the cache now holds exactly the new value.
          refreshedCount += 1;
          const stored = await inner.get<Payload>(key);
          expect(stored).toBeDefined();
          expect(stored?.value).toEqual(fetched);
          expect(stored?.retrievedAt).toBe(clock);
          expect(stored?.ttlMs).toEqual(ttl);
          // And nothing else in the store was disturbed.
          expect(inner.dumpForVerification()).toHaveLength(1);
        },
      ),
      {
        numRuns: 300,
        /**
         * Deterministic coverage of all four outcome shapes and both prior states
         * (see Property 18's note): a successful refresh over a stale entry, a
         * successful fetch whose cache write throws (Requirement 10.8), and a
         * failed refresh that must leave a stale entry intact (Requirement 10.7).
         */
        examples: [
          [
            {
              endpoint: 'league' as CacheEndpoint,
              key: { endpoint: 'league', routingValue: 'na1', params: { puuid: 'p' } } as CacheKey,
              prior: 'stale' as const,
              elapsed: (EXPECTED_RETENTION_MS.league as number) + 1,
              fetchOutcome: { kind: 'ok' } as Fetch,
              failSet: false,
              cachedToken: 'old',
              fetchedToken: 'new',
              start: 1_000,
            },
          ],
          [
            {
              endpoint: 'summoner' as CacheEndpoint,
              key: { endpoint: 'summoner', routingValue: 'na1', params: { puuid: 'p' } } as CacheKey,
              prior: 'absent' as const,
              elapsed: (EXPECTED_RETENTION_MS.summoner as number) + 1,
              fetchOutcome: { kind: 'ok' } as Fetch,
              failSet: true,
              cachedToken: 'old',
              fetchedToken: 'new',
              start: 1_000,
            },
          ],
          [
            {
              endpoint: 'matchIds' as CacheEndpoint,
              key: { endpoint: 'matchIds', routingValue: 'americas', params: { puuid: 'p' } } as CacheKey,
              prior: 'stale' as const,
              elapsed: (EXPECTED_RETENTION_MS.matchIds as number) + 1,
              fetchOutcome: { kind: 'failure', failure: { kind: 'server_error', status: 503 } } as Fetch,
              failSet: false,
              cachedToken: 'old',
              fetchedToken: 'new',
              start: 1_000,
            },
          ],
        ],
      },
    );

    // Guard against degenerate coverage: all four outcome shapes and both prior
    // states must have been exercised.
    expect(refreshedCount).toBeGreaterThan(0);
    expect(failedFetchCount).toBeGreaterThan(0);
    expect(writeFailureCount).toBeGreaterThan(0);
    expect(staleCount).toBeGreaterThan(0);
    expect(absentCount).toBeGreaterThan(0);
  });
});
