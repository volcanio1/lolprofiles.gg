/**
 * Cache Store.
 *
 * Pure-ish module: no network, no environment access, no logging. The in-memory
 * implementation resolves immediately but keeps the design's Promise-returning
 * signatures so a Redis-backed store can be swapped in without touching callers.
 *
 * Implements:
 *  - 10.1: entries are keyed by endpoint + routing value + the
 *    request-identifying params, via a deterministic and injective serialization
 *    (`buildCacheKey`). `params` is treated as an UNORDERED map: entries are
 *    sorted by param name before serialization.
 *  - 10.2: `account` and `summoner` entries are retained for at least 1 hour.
 *  - 10.3: `league` (and `matchIds`, which is likewise a short-lived list)
 *    entries are retained for at least 10 minutes.
 *  - 10.4: `matchDetail` entries are never stale, because completed match data
 *    is immutable.
 *
 * Two decisions worth stating explicitly, because callers depend on them:
 *
 * 1. Staleness boundary. `isStale` returns `false` while
 *    `now - retrievedAt <= ttlMs` and `true` only once elapsed time strictly
 *    exceeds `ttlMs`. Requirements 10.2/10.3 say entries are retained for "at
 *    least" the retention period, so the entry must still be fresh AT the
 *    boundary; treating exactly-`ttlMs` as stale would retain it for slightly
 *    less than the required period.
 *
 * 2. `get` returns stale entries. It never filters on staleness; callers decide
 *    via `isStale`. `cacheOrFetch` (Requirement 10.7) must distinguish "absent"
 *    from "present but stale" so a failed refresh does not overwrite a
 *    still-present stale entry, and that is only possible if `get` surfaces
 *    stale entries rather than hiding them behind `undefined`.
 *
 * Time is injected (`now: () => number`) rather than read from `Date.now()`
 * inline, so behavior is deterministic and testable without wall-clock timing.
 *
 * `deleteByPuuid` (Requirements 12.4-12.6) removes every entry in which the PUUID
 * appears, including `matchDetail` entries. See
 * `InMemoryCacheStore.deleteByPuuid` for why that is eviction rather than the
 * in-place redaction task 5.4 originally implemented.
 */

export type CacheEndpoint = 'account' | 'summoner' | 'league' | 'matchIds' | 'matchDetail';

export interface CacheKey {
  endpoint: CacheEndpoint;
  /** Regional or platform routing value used for this call. */
  routingValue: string;
  /** Request-identifying params, e.g. `{ gameName, tagLine }` / `{ puuid }` / `{ matchId }`. */
  params: Record<string, string>;
}

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms at which the value was stored, read from the injected clock. */
  retrievedAt: number;
  ttlMs: number | 'infinite';
}

/**
 * Outcome of a deletion request (Requirements 12.5/12.6).
 *
 * `found` is the flag the confirmation response reports back to the data
 * subject: `true` when the request removed anything, `false` when there was
 * nothing to act on.
 *
 * The counts are split because the two categories have very different costs: the
 * PUUID-keyed entries are cheap to re-fetch, while a match detail is shared with
 * nine other players and its eviction affects their cache hit rate too. Keeping
 * them separate makes that visible to tests and to operators.
 */
export interface PuuidDeletionResult {
  found: boolean;
  /** Non-`matchDetail` entries removed (keyed by, or whose value referenced, the PUUID). */
  removedEntryCount: number;
  /** `matchDetail` entries removed because the subject participated in them. */
  removedMatchDetailCount: number;
}

export interface CacheStore {
  get<T>(key: CacheKey): Promise<CacheEntry<T> | undefined>;
  set<T>(key: CacheKey, value: T, ttlMs: number | 'infinite'): Promise<void>;
  /**
   * Requirements 12.4-12.6. Removes EVERY entry in which the PUUID appears, in a
   * key or anywhere in a cached value. Idempotent, and never throws for a PUUID
   * that has no cached data.
   */
  deleteByPuuid(puuid: string): Promise<PuuidDeletionResult>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Single source of truth for per-endpoint retention (design.md's TTL table,
 * Requirements 10.2-10.4). Callers must not hardcode durations.
 */
export const TTL_BY_ENDPOINT: Readonly<Record<CacheEndpoint, number | 'infinite'>> = {
  account: ONE_HOUR_MS,
  summoner: ONE_HOUR_MS,
  league: TEN_MINUTES_MS,
  matchIds: TEN_MINUTES_MS,
  matchDetail: 'infinite',
};

/**
 * Length-prefixes a segment so concatenation is injective.
 *
 * A naive `join(':')` aliases distinct tuples: `{ 'a:b': 'c' }` and
 * `{ a: 'b:c' }` both flatten to `a:b:c`. Prefixing each segment with its
 * length removes the ambiguity: the decoder always knows exactly how many
 * characters belong to the current segment, so the encoding is uniquely
 * parseable and therefore injective, whatever characters the segment contains.
 */
function segment(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * Requirement 10.1: deterministic, injective serialization of
 * `(endpoint, routingValue, params)` with `params` treated as an unordered map.
 *
 * Param entries are sorted by name (by UTF-16 code unit, via the default string
 * comparison) so `{ a: '1', b: '2' }` and `{ b: '2', a: '1' }` yield the same
 * key. Param names are unique within a `Record`, so the sort is a total order
 * and the result does not depend on insertion order.
 */
export function buildCacheKey(key: CacheKey): string {
  const entries = Object.entries(key.params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = [segment(key.endpoint), segment(key.routingValue), segment(String(entries.length))];
  for (const [name, value] of entries) {
    parts.push(segment(name), segment(value));
  }
  return parts.join('');
}

/**
 * Requirements 10.2-10.4. `'infinite'` is never stale regardless of elapsed
 * time. Finite TTLs are non-stale up to and including the boundary (see the
 * module docblock for why the boundary is inclusive). A `now` earlier than
 * `retrievedAt` (clock skew) yields negative elapsed time and is not stale.
 */
export function isStale(entry: CacheEntry<unknown>, now: number): boolean {
  if (entry.ttlMs === 'infinite') {
    return false;
  }
  return now - entry.retrievedAt > entry.ttlMs;
}

/** True when `puuid` occurs anywhere inside `value`, at any nesting depth. */
function containsPuuid(value: unknown, puuid: string, seen: Set<object> = new Set()): boolean {
  if (typeof value === 'string') {
    return value.includes(puuid);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((nested) => containsPuuid(nested, puuid, seen));
}

/** Internal record: the encoded key alone loses the endpoint, which deletion needs. */
interface StoredRecord {
  key: CacheKey;
  entry: CacheEntry<unknown>;
}

export interface InMemoryCacheStoreOptions {
  /** Injected clock; defaults to `Date.now`. Never called inline in logic paths. */
  now?: () => number;
}

/**
 * In-memory `CacheStore` for single-instance deployments.
 *
 * Values are stored as-is (no cloning): callers treat cached values as read-only
 * snapshots of Riot API responses. Nothing mutates a stored value — `deleteByPuuid`
 * removes entries rather than editing them, so a caller holding a reference to a
 * cached value never sees it change underneath them.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly now: () => number;

  constructor(options: InMemoryCacheStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Returns the stored entry, stale or not, or `undefined` when absent. */
  async get<T>(key: CacheKey): Promise<CacheEntry<T> | undefined> {
    return this.records.get(buildCacheKey(key))?.entry as CacheEntry<T> | undefined;
  }

  /** Stores the value with `retrievedAt` taken from the injected clock. */
  async set<T>(key: CacheKey, value: T, ttlMs: number | 'infinite'): Promise<void> {
    this.records.set(buildCacheKey(key), {
      key: { endpoint: key.endpoint, routingValue: key.routingValue, params: { ...key.params } },
      entry: { value, retrievedAt: this.now(), ttlMs },
    });
  }

  /**
   * Requirements 12.4-12.6. Removes EVERY entry in which the PUUID appears — in a
   * key param or anywhere in the cached value, at any nesting depth.
   *
   * ---------------------------------------------------------------------------
   * WHY EVICTION AND NOT IN-PLACE SCRUBBING (revised after live testing)
   * ---------------------------------------------------------------------------
   *
   * Task 5.4 originally RETAINED `matchDetail` entries and redacted the subject's
   * participant record in place, reasoning that Requirement 12.4 permits keeping
   * "aggregate, non-personally-identifying statistics" and that the expensive match
   * cache was worth preserving. Live testing showed that produces a silent
   * data-loss bug, and the privacy argument for it does not actually hold:
   *
   * 1. THE REPORT BREAKS, SILENTLY AND PERMANENTLY. A scrubbed match detail no
   *    longer contains the subject's participant row, so the orchestrator can no
   *    longer extract their statistics from it and excludes the match. Because
   *    match details are cached INDEFINITELY (Requirement 10.4) they are never
   *    stale and therefore never re-fetched, so the exclusion is permanent. A live
   *    lookup after a deletion returned a report with the correct summoner level
   *    and ZERO champions, zero fun facts and empty stats — technically valid,
   *    silently empty, with nothing telling the visitor why.
   *
   * 2. SCRUBBING NEVER MADE THE ENTRY NON-IDENTIFYING ANYWAY. A `MatchDto` holds
   *    ten participants. Redacting one leaves nine other PUUIDs and summoner names
   *    in the cached value, so the retained entry is still personally identifying
   *    and does not fit Requirement 12.4's carve-out. The carve-out was doing no
   *    work; it was only ever protecting a cache optimization.
   *
   * 3. REQUIREMENT 12.4 PERMITS RETAINING SUCH DATA, IT DOES NOT REQUIRE IT.
   *    "Delete cached data associated with that data subject's PUUID"
   *    (Requirement 12.5) is satisfied more completely by removal than by partial
   *    redaction, and removal cannot be got subtly wrong.
   *
   * The cost is a bounded cache miss: the evicted matches are re-fetchable, and a
   * later lookup for the subject (or for any of the other nine participants)
   * repopulates them. That is the same cost already accepted for `summoner`,
   * `league` and `matchIds`, and it is the price of the report being correct.
   *
   * Note that deletion is not, and per the requirements need not be, DURABLE: a
   * subsequent lookup re-fetches everything from Riot, re-establishing the
   * association. Requirement 12.5 governs what is held at the time of the request,
   * not whether the data may lawfully be retrieved again later.
   *
   * Which entries match:
   *  - `summoner`, `league`, `matchIds` — keyed by `{ puuid }`, so the key matches.
   *  - `account` — keyed by `{ gameName, tagLine }`, but its cached BODY carries the
   *    PUUID, making the entry precisely a Riot-ID-to-PUUID association. Matched on
   *    the value.
   *  - `matchDetail` — the PUUID appears in `metadata.participants` and in the
   *    subject's participant record. Matched on the value.
   *
   * Idempotent: a second call finds nothing left and reports `found: false`.
   * Never throws for a PUUID with no cached data (Requirement 12.6). An empty
   * PUUID is treated as "no data" rather than as a wildcard matching everything.
   */
  async deleteByPuuid(puuid: string): Promise<PuuidDeletionResult> {
    if (puuid === '') {
      return { found: false, removedEntryCount: 0, removedMatchDetailCount: 0 };
    }

    let removedEntryCount = 0;
    let removedMatchDetailCount = 0;

    for (const [encodedKey, record] of [...this.records]) {
      const puuidInKeyParams = Object.values(record.key.params).some((value) => value.includes(puuid));

      if (puuidInKeyParams || containsPuuid(record.entry.value, puuid)) {
        this.records.delete(encodedKey);
        if (record.key.endpoint === 'matchDetail') {
          removedMatchDetailCount += 1;
        } else {
          removedEntryCount += 1;
        }
      }
    }

    return {
      found: removedEntryCount > 0 || removedMatchDetailCount > 0,
      removedEntryCount,
      removedMatchDetailCount,
    };
  }

  /** Number of stored entries; exposed for tests and diagnostics. */
  get size(): number {
    return this.records.size;
  }

  /**
   * Full snapshot of the store's contents, for verification only — it is NOT part
   * of the `CacheStore` contract and production code must not depend on it. The
   * deletion property test uses it to assert exhaustively that a deleted PUUID
   * appears nowhere in any key or value.
   */
  dumpForVerification(): { encodedKey: string; key: CacheKey; entry: CacheEntry<unknown> }[] {
    return [...this.records].map(([encodedKey, record]) => ({
      encodedKey,
      key: record.key,
      entry: record.entry,
    }));
  }
}

export function createInMemoryCacheStore(options: InMemoryCacheStoreOptions = {}): InMemoryCacheStore {
  return new InMemoryCacheStore(options);
}
