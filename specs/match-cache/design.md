# Design Document

## Overview

This spec adds a persistent, restart-surviving tier for match details, layered under the existing in-memory `matchDetail` cache. It touches four places:

1. **`backend/src/riotApiClient`** — `getMatchById` projects Riot's response down to the `MatchDto` shape before returning it, so every layer above (Cache_Store and the new store) holds the small shape.
2. **`backend/src/db/matchStore.ts`** (new) — the `MatchStore` interface plus in-memory, no-op, and Mongo implementations, in the same mould as `rankHistoryStore` / `lookedUpPlayerStore` / `profileSnapshotStore`.
3. **`backend/src/orchestrator/index.ts`** — `fetchMatchDetails` reads the store before the Riot fan-out and writes the newly-fetched matches back (unawaited); `buildFallbackReport` reads the store too.
4. **`backend/src/api/privacy.ts`** + composition root + `ensureIndexes` — wire the store in, add the collection's indexes, extend privacy deletion.

Nothing about report assembly, rendering, transport limits, or the frontend changes. The build-path timeline (`timelineSlice`) is a separate cache entry type and is out of scope.

## Why this is worth doing

| Path | Today | With `match_details` |
|---|---|---|
| Lookup, warm process | in-memory cache hit — 0 detail calls | same |
| Lookup, **after a restart** | full `N` detail calls | ~0 detail calls (store hits, seeded into memory) |
| Refresh / stale-snapshot re-lookup of a returning player | `N` detail calls (unless same process) | only the *new* match IDs |
| Player B looked up right after player A they shared a game with | B re-fetches the shared match | store hit |
| `profile_reports` snapshot fresh (suggestion pick) | 0 calls (already) | 0 calls (unchanged) |

The match-ids call, the account/region/league calls, and Summoner-V4 are unaffected — this spec is only about the `N` in `4 + N`.

## The trimmed shape (Requirement 2)

Riot's `GET /lol/match/v5/matches/{matchId}` returns 50–120 KB: 10 participant objects of ~150 fields each, most of it `challenges` (~130 fields), `missions`, damage/healing/CC breakdowns, and ping counters. `backend/src/riotApiClient`'s `MatchDto` / `MatchParticipantDto` interfaces already declare only what the code reads — roughly:

```typescript
// the whole of what we keep, per match:
{
  metadata: { matchId, participants: string[] },          // 10 PUUIDs
  info: {
    queueId, gameMode?, gameStartTimestamp, gameDuration,
    participants: [ /* ~40 fields each */
      puuid, championName, teamPosition?, role?, teamId?, win,
      kills, deaths, assists, visionScore,
      totalMinionsKilled?, neutralMinionsKilled?,
      item0..item6, summoner1Id?, summoner2Id?,
      perks?: { statPerks?, styles?: [{ style?, selections?: [{ perk? }] }] },
      champLevel?, goldEarned?, totalDamageDealtToChampions?,
      turretKills?, dragonKills?, baronKills?, pentaKills?,
      riotIdGameName?, riotIdTagline?,
      playerAugment1..6?,
    ] x10
  }
}
```

**~4–6 KB serialised.** `~15–25×` smaller than the raw payload.

### `projectMatchDto`

A pure function in `backend/src/riotApiClient` (or a small `matchProjection.ts` beside it):

```typescript
export function projectMatchDto(raw: unknown): MatchDto {
  const r = raw as any;
  return {
    metadata: {
      matchId: r?.metadata?.matchId,
      participants: Array.isArray(r?.metadata?.participants) ? r.metadata.participants : [],
    },
    info: {
      queueId: r?.info?.queueId,
      gameMode: r?.info?.gameMode,
      gameStartTimestamp: r?.info?.gameStartTimestamp,
      gameDuration: r?.info?.gameDuration,
      participants: (Array.isArray(r?.info?.participants) ? r.info.participants : []).map(projectParticipant),
    },
  };
}
```

`getMatchById` calls it on the parsed body before returning `{ kind: 'ok', data }`. Because the Cache_Store `set` and the `MatchStore` `putMany` both receive the value `getMatchById` returned, both hold the trimmed shape with no extra step, and the in-memory cache's footprint drops by the same factor — a free win on M0's shared compute too.

**Losslessness (Requirement 2.3):** the projection keeps exactly the interface fields. Task 1 verifies with a `grep` that no consumer reads an undeclared field (`.challenges`, `.teams`, `.missions`, bracketed dynamic access) and with a golden-output test over `toIncludedMatch` / `computeRecentMatches` / the match-rating using a fixture that *includes* the dropped fields.

**One risk to check:** `killParticipationPercent` in `toMatchParticipant` is computed by summing `kills` across a participant's own team — it reads `participant.teamId` and `participant.kills`, both kept. It does **not** read `info.teams`. Confirmed against `mapping.ts` in task 1.

## `MatchStore` (Requirement 1)

`backend/src/db/matchStore.ts`, same structure as the sibling stores.

```typescript
import type { MatchDto } from '../riotApiClient';

export interface StoredMatch {
  matchId: string;
  match: MatchDto;
  region: string;      // the RegionalRoutingValue it was fetched from; diagnostic, not load-bearing
  storedAt: number;    // epoch ms
}

export interface MatchStore {
  /** Requirement 3.1. The subset of `matchIds` that are stored, as a Map keyed by matchId. */
  getMany(matchIds: readonly string[]): Promise<Map<string, StoredMatch>>;
  /** Requirement 4.1/4.2. Upsert each by matchId. */
  putMany(matches: readonly StoredMatch[]): Promise<void>;
  /** Requirement 6.1. Delete every stored match `puuid` is a participant in; resolves the count. */
  deleteByPuuid(puuid: string): Promise<number>;
}
```

- `InMemoryMatchStore` — a `Map<string, StoredMatch>`; `deleteByPuuid` scans `match.metadata.participants`.
- `createNoopMatchStore()` — `getMany` → empty `Map`, `putMany` → nothing, `deleteByPuuid` → 0. The `MONGODB_URI`-unset runtime state (Requirement 1.4).
- `MongoMatchStore` — `_id` is the `matchId`:
  - `getMany`: `find({ _id: { $in: matchIds } })` — **one operation** regardless of list length (Requirement 3.5).
  - `putMany`: `bulkWrite([{ updateOne: { filter: { _id }, update: { $set: { match, region, storedAt } }, upsert: true } }, ...])` — **one operation** (Requirement 4.5).
  - `deleteByPuuid`: `deleteMany({ 'match.metadata.participants': puuid })`.

`StoredMatch.match` is a BSON subdocument, well under the 16 MB cap. `storedAt` is a BSON `Date` at rest, epoch ms across the interface, so the TTL index can expire on it.

### The bounded, fail-safe read (Requirement 3.4)

The orchestrator must not let a slow Mongo read slow a lookup. `MongoMatchStore.getMany` runs its `find` under a short deadline (e.g. `maxTimeMS(1500)` plus a `Promise.race` against an injected-scheduler timeout), and the orchestrator wraps the call in `.catch(() => new Map())`. A store that is slow, unreachable, or erroring is indistinguishable from a store with nothing stored — the lookup falls through to Riot, worst case "as slow as today."

## `match_details` collection (Requirement 7)

```typescript
// backend/src/db/collections.ts
export const MATCH_DETAILS_COLLECTION = 'match_details';
/** Requirement 7.1. Storage bound only — matches are immutable, so an expired-and-re-fetched doc is identical. */
export const MATCH_DETAIL_TTL_SECONDS = 150 * 24 * 60 * 60; // 150 days
```

`ensureIndexes` (`backend/src/db/client.ts`) gains:

```typescript
await db.collection(MATCH_DETAILS_COLLECTION).createIndexes([
  { key: { storedAt: 1 }, name: 'ttl_storedAt', expireAfterSeconds: MATCH_DETAIL_TTL_SECONDS },
  // Serves privacy deletion; a multikey index on the participants array.
  { key: { 'match.metadata.participants': 1 }, name: 'participants' },
]);
```

Reads are by `_id` (`$in`), so no index is needed for `getMany`.

### Storage math (Requirement 2.5)

- Per document: ~5 KB `match` + ~200 B envelope + index overhead ≈ **~6 KB effective**.
- M0 ceiling: 512 MB. `rank_snapshots` + `looked_up_players` + `profile_reports` are small (`specs/database/` estimated ~50 MB/year for the first two; `profile_reports` is one ~30 KB doc per active player, so a few hundred MB only at tens of thousands of active players — revisit there, not here). Budget ~350 MB for `match_details`.
- ~350 MB / 6 KB ≈ **~58,000 stored matches** at steady state.
- With a 150-day TTL, steady state = (unique matches seen per day) × 150. The site holds ~58k matches if it sees ~390 distinct matches/day. A small-to-medium tracker sees far fewer; a popular one exceeds it and needs the escape valve.
- **Escape valve (Requirement 7.4):** shorten `MATCH_DETAIL_TTL_SECONDS`, or add `lastAccessedAt` (bumped in `getMany`) and a periodic `deleteMany({ lastAccessedAt: { $lt: cutoff } })` sweep / a capped collection. Not implemented now; the constant is one line to change.

## The read/write path in the orchestrator

### `fetchMatchDetails`

Today (simplified):

```
matchIds = truncate(rawMatchIds, MATCH_HISTORY_COUNT)
for each concurrency-batch of matchIds:
  outcomes = await Promise.all(batch.map(id => cacheOrFetch(matchDetail key, () => client.getMatchById(...))))
  classify each outcome into matches / lanelessMatches
```

Changed:

```
matchIds = truncate(rawMatchIds, MATCH_HISTORY_COUNT)

// Requirement 3.1: one store read for everything not already fresh in the in-memory cache.
// (The cache check is cheap and local; skipping stored ids the cache already has avoids
//  a pointless Mongo round trip on a warm process.)
uncachedIds = matchIds.filter(id => !(await cache.get(matchDetail key)))   // or just: all matchIds
stored = await matchStore.getMany(uncachedIds).catch(() => new Map())     // Requirement 3.4

fetchedFromRiot: MatchDto[] = []
for each concurrency-batch of matchIds:
  if gate.expired(): break
  outcomes = await Promise.all(batch.map(async id => {
    const hit = stored.get(id)
    if (hit) {
      await cache.set(matchDetail key, hit.match, 'infinite').catch(() => {})   // Requirement 3.2
      return { fromStore: true, value: hit.match }
    }
    const out = await cacheOrFetch(matchDetail key, () => client.getMatchById(region, id), now)  // Requirement 3.3
    if (!isCacheOrFetchFailure(out) && !out.fromCache) fetchedFromRiot.push(out.value)
    return out
  }))
  ...classify as today...

// Requirement 4.1: unawaited bulk write of what we just pulled from Riot.
if (fetchedFromRiot.length > 0) {
  void guard(() => matchStore.putMany(fetchedFromRiot.map(m => ({
    matchId: m.metadata.matchId, match: m, region, storedAt: now(),
  })))).catch(reason => logger.storeWriteFailed({ reason }))   // Requirement 4.4
}
```

- The concurrency bound (`MATCH_DETAIL_CONCURRENCY`) and the budget gate are unchanged — store hits resolve instantly inside a batch, Riot misses still respect the width.
- `putMany` fires once, after the fan-out, with only the Riot-fetched matches (store hits and in-memory hits are already persisted). Unawaited; a rejection goes to the existing `storeWriteFailed` logger seam (`consoleLookupLogger`).
- Requirement 4.3 ("write regardless of overall outcome"): `fetchMatchDetails` returns its window before any later stage can fail, and the `putMany` is fired from inside it, so a subsequent League/match-ids failure or a budget overrun cannot cancel it.

### `buildFallbackReport` (Requirement 3.6)

The Requirement 11.3 fallback reads match details straight from the cache via `readCached`. Add a store read for the ids `readCached` misses:

```
ids = truncate(matchIds.value, MATCH_HISTORY_COUNT)
cacheMisses = []
for id in ids:
  entry = await readCached(matchDetail key)
  if entry: use entry.value
  else cacheMisses.push(id)
stored = await matchStore.getMany(cacheMisses).catch(() => new Map())
for id in cacheMisses: if stored.has(id) use stored.get(id).match
// still-missing ids are simply excluded, exactly as today (Requirement 3.3's tolerated exclusion)
```

The fallback still issues no Riot call — it now just has a second local-ish source.

## Interaction with existing layers

- **In-memory Cache_Store:** unchanged in shape and semantics. Store hits are written into it (`ttlMs: 'infinite'`) so a same-process repeat lookup never re-reads Mongo. The `matchDetail` TTL is still `'infinite'` — the store is a *second* infinite tier, not a replacement.
- **`profile_reports` snapshot:** orthogonal. A fresh snapshot still short-circuits the whole pipeline (0 calls). `match_details` helps every path a snapshot does not: typed lookups, Refresh, stale/absent snapshots, and the case where player B benefits from player A's fetch.
- **`cacheOrFetch`:** untouched — it stays a pure two-tier (memory ↔ Riot) helper. The store tier is threaded around it in `fetchMatchDetails`, not inside it, so the generic helper keeps one job.
- **Rate Limit Manager:** a store hit issues no Riot call, so it makes no reservation — the shared budget is spent only on genuine misses.

## Privacy route extension (Requirement 6)

`backend/src/api/privacy.ts`'s `Promise.all` gains a fifth entry:

```typescript
const [cacheResult, snapshotsRemoved, playerRemoved, reportSnapshotRemoved, storedMatchesRemoved] =
  await Promise.all([
    deps.cache.deleteByPuuid(puuid),
    rankHistoryStore.deleteByPuuid(puuid).catch(() => 0),
    lookedUpPlayerStore.deleteByPuuid(puuid).catch(() => 0),
    profileSnapshotStore.deleteByPuuid(puuid).catch(() => 0),
    matchStore.deleteByPuuid(puuid).catch(() => 0),   // Requirement 6.1/6.3
  ]);

const confirmation: DeletionConfirmation = {
  found:
    cacheResult.found ||
    snapshotsRemoved > 0 ||
    playerRemoved > 0 ||
    reportSnapshotRemoved > 0 ||
    storedMatchesRemoved > 0,
  deletedAt: new Date(deps.now()).toISOString(),
};
```

Body still `{ found, deletedAt }` — no count leak (Requirement 6.3). Eviction, not redaction (Requirement 6.2): `deleteMany({ 'match.metadata.participants': puuid })`.

The in-memory Cache_Store already evicts `matchDetail` entries the PUUID participated in (`deleteByPuuid`, `backend/src/cache/index.ts`), so cache and store agree.

## Composition root

`backend/src/index.ts`, alongside the other three stores:

```typescript
const matchStore: MatchStore = databaseClient.enabled
  ? new MongoMatchStore(databaseClient.db(), { now, scheduleTimeout })
  : createNoopMatchStore();
```

Passed to `createLookupOrchestrator` and `createApp` → `createApiRouter` → `createPrivacyDeleteHandler`, exactly like `profileSnapshotStore`.

## Disabled state

`MONGODB_URI` unset → `createNoopMatchStore()`. `getMany` → empty `Map` → every id is a "miss" → the fan-out fetches from Riot exactly as today. `putMany` → nothing. `deleteByPuuid` → 0. The feature is invisible; behaviour is byte-identical to the current build.

## Configuration and docs (Requirement 8)

No new env var. README updates:
- Database table: a `match_details` row.
- A line on trimmed-not-raw storage, the ~5 KB size, the 150-day TTL.
- Caching table: the `matchDetail | Indefinite` row gains "— now spans restarts via `match_details`".
- Known gaps / rate-limit note: a restart no longer cold-caches every match.

## Testing (Requirement 9)

- `matchProjection.test.ts` — the projection keeps every declared field; a fixture with `challenges`/`missions`/`teams`/damage-breakdowns present produces the same `toIncludedMatch` / `computeRecentMatches` / match-rating output as the raw fixture would.
- `matchStore.test.ts` — in-memory + no-op: `getMany` returns only stored ids as a Map, `putMany` upserts by matchId, `deleteByPuuid` removes participant docs + count, no-op returns empty/0.
- Orchestrator tests — store hit ⇒ no `getMatchById` call + Cache_Store populated; store miss ⇒ Riot fetch + `putMany` of only the fetched; a throwing `getMany` ⇒ falls through to Riot, lookup still succeeds; a throwing `putMany` ⇒ logged via `storeWriteFailed`, swallowed; partial store coverage ⇒ only the absent ids fetched (Requirement 5.1).
- `buildFallbackReport` test — a match absent from the cache but present in the store is included in the fallback report.
- Privacy test — `deleteByPuuid` evicts the PUUID's stored matches; a throwing `MatchStore.deleteByPuuid` alone still yields a 200.
- `mongo.integration.test.ts` (skipped without `MONGODB_TEST_URI`) — `MongoMatchStore` round trip, the TTL + participants indexes exist, `deleteByPuuid` by participant works.

## Open Questions For The User

1. **TTL length.** 150 days is proposed — long enough that a returning player's last-few-months history is warm, and ~58k matches at steady state fits ~350 MB. Comfortable, or prefer 90 days (safer on storage) or 365 (warmer, needs monitoring)?
2. **Do the store read on *every* match id, or only the ones the in-memory cache misses?** Filtering by the cache first saves a Mongo round trip on a fully-warm process but adds `N` local cache `get`s before the store call. Given the cache `get` is a synchronous map lookup, filtering first is nearly free and strictly fewer Mongo bytes — the design assumes this. Confirm.
3. **`lastAccessedAt` now, or later?** The design defers it (TTL on `storedAt` alone is simpler and the constant is easy to tune). Adding it now would make the escape valve an LRU instead of a flat age cut. Defer, or build it in?
4. **Write on a lookup that later fails?** Requirement 4.3 says yes — the matches are valid regardless. This means a lookup that 404s at, say, League-V4 after fetching 20 details still writes those 20. Intended (they're free future hits), or restrict writes to fully-successful lookups for tidiness?
