/**
 * Lookup Orchestrator — the generic cache-or-fetch helper.
 *
 * PURE COORDINATION. This module performs no I/O of its own: the cache and the
 * fetch function are both supplied by the caller, and the clock is injected, so
 * no test needs a real timer, a network, or a credential. It is the single place
 * where Requirements 10.5-10.8 are implemented, and every sub-fetch of a
 * Lookup_Session (account, summoner, league, match-ids, each match detail) goes
 * through it — that is what makes partial cache hits possible, and what makes the
 * cache semantics testable once instead of once per endpoint.
 *
 * Implements:
 *  - 10.5: a non-stale cache entry is returned WITHOUT invoking `fetch`.
 *  - 10.6: on a stale-or-absent entry, `fetch` runs and a successful response
 *    both updates the cache and is returned to the caller.
 *  - 10.7: a FAILED fetch never overwrites the cache. An absent entry stays
 *    absent, a stale entry keeps its previous value, and the caller is told the
 *    lookup failed.
 *  - 10.8: a cache WRITE failure is swallowed. The caller still receives the
 *    successfully fetched value and no failure is reported.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. TWO ADDITIVE EXTENSIONS TO design.md's DECLARED SIGNATURE. design.md
 *    declares:
 *
 *      cacheOrFetch<T>(cache, key, ttlMs, fetch)
 *        : Promise<{ value: T; fromCache: boolean } | { failed: true }>
 *
 *    Two things are added, both required to satisfy requirements the helper's
 *    callers must meet, and both strictly additive (the declared discriminants
 *    `value`/`failed` and the declared fields are unchanged, so every consumer
 *    written against the declared shape still type-checks):
 *
 *      a. `failure: RiotApiFailure` on the failure branch. A bare
 *         `{ failed: true }` cannot say WHY the fetch failed, and Requirement 9's
 *         error table maps each distinct Riot outcome onto a distinct user-facing
 *         error (9.2 not-found, 9.3 unavailable, 9.4 timeout, 9.5 auth,
 *         9.8 rate-limited, 9.9 network). Without the reason the orchestrator
 *         could not produce those codes at all. This is the same class of gap as
 *         task 5.4's `deleteByPuuid(): Promise<void>`, which likewise could not
 *         report the one fact its caller needed.
 *
 *      b. `retrievedAt: number` on the success branch. Requirement 11.4 requires
 *         the report to display the last-updated timestamp OF THE DATA USED, and
 *         11.5 requires "being retrieved for the first time" when no prior
 *         retrieval exists. Both are functions of when each component was
 *         obtained, which only this helper knows.
 *
 *    See the implementation log for the corresponding design.md amendment.
 *
 * 2. THE CLOCK IS AN EXPLICIT PARAMETER, NOT `Date.now()`. Staleness is a
 *    function of the current time (`isStale(entry, now)`), and every module in
 *    this build injects its clock rather than reading the wall clock inline
 *    (`InMemoryCacheStore`, `InMemoryRateLimitManager`, `HttpRiotApiClient` all
 *    do). design.md's snippets omit injected dependencies throughout — the
 *    declared `CacheStore` and `RiotApiClient` interfaces show none either — so
 *    passing the clock is a continuation of the established convention rather
 *    than a change of contract. Callers must pass the SAME clock function they
 *    gave the cache store, so `retrievedAt` values are comparable.
 *
 * 3. A CACHE READ THAT THROWS IS TREATED AS A MISS. Requirement 10.8 only
 *    addresses write failures, so read failures are unspecified. Treating a
 *    failed read as "absent" is the only fail-safe choice: it degrades to a fresh
 *    fetch, which is correct-but-slower, and it can never fail a lookup that the
 *    Riot API could still have served. The alternative — propagating the error —
 *    would let a cache outage take down lookups that do not need the cache.
 *
 * 4. `fetch` THROWING IS A DEFECT AND PROPAGATES. The `RiotApiClient` contract
 *    returns a typed `RiotApiResult` for every expected outcome, including
 *    timeouts, rate limiting and transport failures (see that module's decision
 *    1). An exception out of `fetch` therefore means a bug, not a lookup outcome,
 *    and is not converted into `{ failed: true }` — swallowing it would hide the
 *    defect behind a plausible-looking user-facing error.
 *
 * 5. THE STALENESS CHECK SAMPLES THE CLOCK ONCE. `now()` is read once for the
 *    staleness decision and once more only after a successful fetch (for
 *    `retrievedAt`), so a slow fetch cannot retroactively change the staleness
 *    verdict that authorized it.
 */

import { isStale, type CacheEntry, type CacheKey, type CacheStore } from '../cache';
import type { RiotApiResult } from '../riotApiClient';

/**
 * Every `RiotApiResult` variant other than `ok`, derived from the client's own
 * union so it cannot drift if that union gains a variant.
 */
export type RiotApiFailure = Exclude<RiotApiResult<unknown>, { kind: 'ok' }>;

/** A value was produced, either from the cache or from a fresh fetch. */
export interface CacheOrFetchSuccess<T> {
  value: T;
  /** True when the value came from a non-stale cache entry (Requirement 10.5). */
  fromCache: boolean;
  /**
   * Epoch ms at which this value was obtained from Riot: the cache entry's
   * `retrievedAt` for a cache hit, or the fetch time for a fresh fetch. Feeds
   * Requirements 11.4/11.5 (decision 1b).
   */
  retrievedAt: number;
}

/** The fetch was attempted and failed; the cache is unchanged (Requirement 10.7). */
export interface CacheOrFetchFailure {
  failed: true;
  /** Why the fetch failed, so callers can apply Requirement 9's error table. */
  failure: RiotApiFailure;
}

export type CacheOrFetchOutcome<T> = CacheOrFetchSuccess<T> | CacheOrFetchFailure;

/** Discriminates the two branches of `CacheOrFetchOutcome`. */
export function isCacheOrFetchFailure<T>(
  outcome: CacheOrFetchOutcome<T>,
): outcome is CacheOrFetchFailure {
  return 'failed' in outcome;
}

/**
 * Requirements 10.5-10.8. Returns the cached value when it is non-stale,
 * otherwise fetches, caching only on success.
 *
 * @param cache  the store to read from and write through
 * @param key    endpoint + routing value + request-identifying params (10.1)
 * @param ttlMs  retention for this endpoint; use `TTL_BY_ENDPOINT[endpoint]`
 * @param fetch  the Riot call to make on a miss; invoked at most once, and NOT
 *               invoked at all on a non-stale hit (10.5)
 * @param now    injected clock, shared with the cache store (decision 2)
 */
export async function cacheOrFetch<T>(
  cache: CacheStore,
  key: CacheKey,
  ttlMs: number | 'infinite',
  fetch: () => Promise<RiotApiResult<T>>,
  now: () => number,
): Promise<CacheOrFetchOutcome<T>> {
  // Decision 3: a read that throws degrades to a miss rather than an error.
  let existing: CacheEntry<T> | undefined;
  try {
    existing = await cache.get<T>(key);
  } catch {
    existing = undefined;
  }

  // Requirement 10.5: serve the cache and do not call Riot at all.
  if (existing !== undefined && !isStale(existing, now())) {
    return { value: existing.value, fromCache: true, retrievedAt: existing.retrievedAt };
  }

  // Requirement 10.6 (and 10.7 on failure): the entry is stale or absent.
  const result = await fetch();

  if (result.kind !== 'ok') {
    // Requirement 10.7: nothing is written, so an absent entry stays absent and
    // a stale entry keeps the value it had. The caller is told it failed.
    return { failed: true, failure: result };
  }

  const retrievedAt = now();

  try {
    // Requirement 10.6: refresh the entry with the new response.
    await cache.set(key, result.data, ttlMs);
  } catch {
    // Requirement 10.8: persistence is best-effort. The value was retrieved
    // successfully, so the lookup succeeds regardless of the cache's health.
  }

  return { value: result.data, fromCache: false, retrievedAt };
}
