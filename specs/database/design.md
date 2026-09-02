# Design Document

## Overview

This feature adds the first persistent storage this project has ever had. It is small in surface area — two collections, two interfaces, one connection, two write hooks, one route extension — and the design keeps it that way on purpose. Everything about it is shaped by one rule: **the lookup path does not know or care whether the database exists.**

The store is reached only through two storage-agnostic interfaces, `RankHistoryStore` and `LookedUpPlayerStore`, mirroring the pattern already established by `CacheStore` (interface first, in-memory implementation as the default, a real backend swapped in at the composition root without any caller changing). The MongoDB driver appears in exactly one new directory and nowhere else.

The two consumers of this store live in other specs:

- `specs/profile-sidebar/` Requirement 10 reads `RankHistoryStore.history(puuid, queueType)` to build the rank graph and adds the `rankHistory` field to the Profile_Report payload.
- `specs/autofill-search/` calls `LookedUpPlayerStore.searchByNamePrefix(prefix, limit)` behind a new endpoint.

Neither is implemented here. This spec delivers the storage layer and the write path that fills it, tested against in-memory fakes, plus the privacy-route extension that keeps `POST /api/privacy/delete` honest.

## Why MongoDB Atlas M0

The `profile-sidebar` design listed three storage options (extend the in-memory cache — ruled out; a flat file on a persistent disk; a real database) and declined to choose. The choice, made with the user on 2026-08-28, is a fourth: a managed document database on a free tier.

| Concern | How M0 handles it |
|---|---|
| Survives restart / redeploy | Yes, unconditionally — it is not tied to the app host's disk, which is the flat-file option's weak point on Render's lower tiers. |
| New infra to operate | A managed cluster and one connection string. No migrations engine, no schema DDL, no backup jobs to own. |
| New dependency footprint | One package: the official `mongodb` driver. No ODM (no Mongoose) — the data is trivial and the driver's typed collection API is enough. |
| Cost | Free (M0). |
| Multi-instance safe | Yes — unlike a flat file, concurrent writers are fine. |

### M0 ceilings, and why the data model clears them

| Limit | Reality for this workload |
|---|---|
| **512 MB storage** | A Rank_Snapshot document is ~130 bytes with the index. Requirement 2.2 keeps one only every ~3 ranked games (or on a rank change) per player per queue — strictly fewer than the old one-per-day cap for anyone playing under ~3 ranked games/day, and at most a handful per day for a heavy grinder. At an implausibly steady 500 distinct active ranked players each generating, say, 3 kept snapshots/day, that is ~500 × 3 × 365 ≈ 550 k documents/year ≈ **~70 MB/year**, before any pruning. Looked_Up_Player documents are one per unique player ever searched — thousands, low single-digit MB. Years of runway. |
| **~100 ops/sec cluster-wide** | Each lookup issues a handful of small operations (Requirement 6.3): one indexed read + at most one insert for the rank snapshot, one upsert each for the checkpoint and remembered-player hooks. Hitting the ceiling needs tens of lookups/sec sustained — far beyond this site, and the writes are off the request path anyway so a throttled write just fails silently and retries next lookup. |
| **No automated backups** | Accepted. Rank_History and Looked_Up_Player are both *derived*: a total loss makes the graph younger and the autocomplete forgetful, the same failure mode `profile-sidebar` Requirement 10.4 already tolerates. Nothing here is a system of record. |
| **Deprovision after 60 days idle** | Not a concern for a deployed, trafficked site. Worth knowing for a long pause. |
| **IP allow-list** | Render's egress IPs are not static on lower tiers, so the Atlas project allows `0.0.0.0/0` and relies on SCRAM + TLS. Documented in the README setup steps. |

### Pruning (Requirement 6.4)

Not implemented in this spec, but the escape valve is chosen so it can be added without a data migration: **retain the most recent 60 Rank_Snapshots per `(puuid, queueType)`**. 60 lookups of one player is already a dense graph, and `profile-sidebar` Requirement 10.5 labels the axis "lookups over time," not a fixed calendar window. Implementation, when needed, is a capped delete after each insert, or a scheduled sweep — both are a few lines against the compound index.

## Architecture

```
backend/src/index.ts  (composition root)
  ├─ createDatabaseClient({ uri: process.env.MONGODB_URI })   NEW — returns a connected
  │     │                                                     client, or a disabled sentinel
  │     ▼
  ├─ createMongoRankHistoryStore({ client, now })   NEW  ─┐
  ├─ createMongoLookedUpPlayerStore({ client, now })  NEW ─┤ both implement the
  │                                                        │ storage-agnostic interfaces;
  │                                                        │ both are the disabled no-op
  │                                                        │ store when client is disabled
  ▼                                                        │
  createLookupOrchestrator({                               │
    cache, riotApiClient, now, matchHistoryCount,          │
    rankHistoryStore,     ◄─────────────────────────────────┤  NEW params, optional,
    lookedUpPlayerStore,  ◄─────────────────────────────────┘  default to no-op stores
  })
       │
       │  on a `kind: 'success'` result with a real (non-fallback) report:
       ▼
   void this.recordLookupSideEffects(report, soloGamesPlayed)   NEW — unawaited, self-contained
       ├─ if report.stats.rankedByQueue['RANKED_SOLO_5x5']:
       │     rankHistoryStore.record({ puuid, queueType, tier, division, leaguePoints, gamesPlayed, observedAt })
       │       └─ kept only if no prior snapshot, rank changed, count fell, or ≥3 games since (shouldRecordSnapshot)
       └─ lookedUpPlayerStore.remember({ puuid, gameName, tagLine, profileIconId, region, lastLookedUpAt: observedAt })

backend/src/app.ts  (privacy route)
  POST /api/privacy/delete  ─ also calls  rankHistoryStore.deleteByPuuid + lookedUpPlayerStore.deleteByPuuid
```

New files, all under `backend/src/db/`:

| File | Contents |
|---|---|
| `db/client.ts` | `createDatabaseClient` — wraps `MongoClient`, returns a small `{ db(), close(), enabled }` handle or a disabled sentinel. Owns pool sizing, TLS, the startup `connect()` with its catch, and `ensureIndexes()`. |
| `db/rankHistoryStore.ts` | The `RankHistoryStore` interface, `InMemoryRankHistoryStore`, `MongoRankHistoryStore`, `createNoopRankHistoryStore`. |
| `db/lookedUpPlayerStore.ts` | The `LookedUpPlayerStore` interface, `InMemoryLookedUpPlayerStore`, `MongoLookedUpPlayerStore`, `createNoopLookedUpPlayerStore`. |
| `db/*.test.ts` | Unit tests against the in-memory fakes and a throwing fake. |
| `db/mongo.integration.test.ts` | Opt-in, gated by `MONGODB_TEST_URI`. Skipped by default. |

## Interfaces

```typescript
// db/rankHistoryStore.ts

export interface RankSnapshot {
  puuid: string;
  queueType: string;          // raw League-V4 queueType, e.g. 'RANKED_SOLO_5x5'
  tier: string;               // e.g. 'GOLD'
  division: string;           // e.g. 'II' ('' for apex tiers, matching LeagueEntry)
  leaguePoints: number;
  gamesPlayed: number;        // League-V4 wins + losses for this queue at observation time
  observedAt: number;         // epoch ms, from the injected clock
}

export interface RankHistoryStore {
  /**
   * Requirement 2.1-2.4. Keeps `snapshot` only when `shouldRecordSnapshot`
   * agrees with the latest kept snapshot for this (puuid, queueType): no prior
   * one, a tier/division change, a lower `gamesPlayed` (reset), or a
   * `gamesPlayed` delta ≥ MIN_GAMES_BETWEEN_SNAPSHOTS. Otherwise a no-op — a
   * lookup landing between data points is the expected case. Never throws for
   * the skipped case; resolves whether or not a row was written.
   */
  record(snapshot: RankSnapshot): Promise<void>;

  /**
   * Requirement 2.5. A PUUID's snapshots for one queue, oldest observedAt first.
   * Empty array when there are none or the store is disabled.
   */
  history(puuid: string, queueType: string): Promise<RankSnapshot[]>;

  /** Requirement 5.1. Removes every snapshot for this PUUID. Returns the count removed. */
  deleteByPuuid(puuid: string): Promise<number>;
}
```

```typescript
// db/lookedUpPlayerStore.ts

export interface LookedUpPlayer {
  puuid: string;
  gameName: string;
  tagLine: string;
  profileIconId: number | null;
  region: string;             // resolved platform routing value, e.g. 'euw1'
  lastLookedUpAt: number;     // epoch ms
}

export interface LookedUpPlayerStore {
  /** Requirement 3.1-3.3. Upsert keyed by puuid; updates the mutable fields, never forks. */
  remember(player: LookedUpPlayer): Promise<void>;

  /**
   * Requirement 3.5. Case-insensitive gameName-prefix match, most recently
   * looked up first, capped at `limit`. Consumed by specs/autofill-search/.
   * Empty array when the store is disabled.
   */
  searchByNamePrefix(namePrefix: string, limit: number): Promise<LookedUpPlayer[]>;

  /** Requirement 5.1. Removes this PUUID's record. Returns 1 if one existed, else 0. */
  deleteByPuuid(puuid: string): Promise<number>;
}
```

Every method is `Promise`-returning even where the in-memory implementation resolves synchronously — the same choice `CacheStore` made so a real backend drops in without touching callers.

## MongoDB collections

Database name: `lolprofiles`. Two collections.

### `rank_snapshots`

```jsonc
{
  "_id": ObjectId,
  "puuid": "…",
  "queueType": "RANKED_SOLO_5x5",
  "tier": "GOLD",
  "division": "II",
  "leaguePoints": 47,
  "gamesPlayed": 118,            // League-V4 wins + losses at observation time; diffed by shouldRecordSnapshot
  "observedAt": ISODate          // stored as a BSON date; mapped to/from epoch ms at the boundary
}
```

Indexes (created by `ensureIndexes()`):

- `{ puuid: 1, queueType: 1, observedAt: 1 }` — serves the `history()` read in sorted order, the `record()` "latest kept snapshot" read (index walked backwards), and the `deleteByPuuid` sweep.

There is **no unique index** (Requirement 6.2). The keep/skip rule (`shouldRecordSnapshot`) is a `gamesPlayed` delta against the latest kept snapshot plus a tier/division check — nothing a unique index can express — so `MongoRankHistoryStore.record` does a `findOne(..., { sort: { observedAt: -1 } })` then, if the rule agrees, an `insertOne`. The old `uniq_puuid_queue_day` index is dropped in `ensureIndexes` (best-effort; absent on a fresh database). Two genuinely concurrent fresh lookups of the same player can each insert a point; that is rare (a cached lookup records nothing) and harmless — the graph just gains one near-duplicate vertex.

`gamesPlayed` is absent on documents written before this change; it reads back as `0`, which only ever makes the next lookup record a fresh baseline point.

### `looked_up_players`

```jsonc
{
  "_id": "…",                    // the puuid IS the _id — upsert-by-key for free, no separate unique index
  "gameName": "Faker",
  "gameNameLower": "faker",      // lowercased, for the case-insensitive prefix search
  "tagLine": "KR1",
  "profileIconId": 6,            // or null
  "region": "kr",
  "lastLookedUpAt": ISODate
}
```

Indexes:

- `_id` is the puuid — `remember()` is `updateOne({ _id: puuid }, { $set: {...} }, { upsert: true })`, which satisfies Requirement 3.1/3.3 (update the mutable fields, never fork) with no extra index.
- `{ gameNameLower: 1, lastLookedUpAt: -1 }` — serves `searchByNamePrefix`. The query is an anchored regex `^<escaped-lowercased-prefix>` on `gameNameLower` with `.sort({ lastLookedUpAt: -1 }).limit(limit)`. An anchored regex uses the index as a range scan. The prefix is regex-escaped before use.

## The write path

A new private method on the orchestrator, called once, unawaited, from the single place a successful non-fallback report is produced:

```typescript
// in runPipeline, replacing `return { kind: 'success', report: … }`
const report = this.assembleReport({ … });
this.recordLookupSideEffects(report);   // NOT awaited — Requirement 4.1
return { kind: 'success', report };

private recordLookupSideEffects(report: ProfileReport, soloGamesPlayed: number): void {
  const observedAt = this.now();
  const solo = report.stats.rankedByQueue['RANKED_SOLO_5x5'];   // Requirement 2.1

  void Promise.allSettled([
    solo
      ? this.rankHistoryStore.record({
          puuid: report.puuid,
          queueType: 'RANKED_SOLO_5x5',
          tier: solo.tier,
          division: solo.division,
          leaguePoints: solo.leaguePoints,
          gamesPlayed: soloGamesPlayed,   // League-V4 wins + losses, read from the league entries
          observedAt,
        })
      : Promise.resolve(),
    this.lookedUpPlayerStore.remember({
      puuid: report.puuid,
      gameName: report.riotId.gameName,
      tagLine: report.riotId.tagLine,
      profileIconId: report.profileIconId,
      region: report.resolvedPlatform,
      lastLookedUpAt: observedAt,
    }),
  ]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') this.logger.storeWriteFailed(r.reason);   // Requirement 4.2
    }
  });
}
```

Key points, each tied to a requirement:

- **Not awaited (4.1).** `runLookup` returns while the writes are still in flight. Because the process is long-lived (an Express server), the microtask completes; there is no risk of the runtime tearing down mid-write as there would be in a lambda.
- **`Promise.allSettled` + `void` + a `.then` that only logs (4.2).** No path from a store rejection to the request. No unhandled rejection.
- **`RANKED_SOLO_5x5` only (2.1, 2.7).** Flex and the rest are out of scope; `profile-sidebar` Requirement 10.3 scopes the graph to solo/duo.
- **Reads only `report` (4.5).** No new Riot call. Everything needed is already on the assembled report.
- **`leaguePoints` on `RankedQueueStanding`.** `ProfileStats.rankedByQueue` today carries `{ tier, division, winRatePercent }` — it does **not** carry `leaguePoints`. This is the one upstream change this spec needs: `rankedByQueueOf` in `backend/src/insight/stats.ts` already has `entry.leaguePoints` in hand (see `RankedQueueStanding` construction) and must also surface it on the standing. That is a purely additive field on an internal type; `profile-sidebar` will surface it to the payload. **This is called out in Open Questions.**

### Fallback reports do not record (3.4, 2.1)

`buildFallbackReport` (the Requirement 11.3 stale-cache path) also produces `kind: 'success'`. The side-effect call is placed only on the *fresh* `runPipeline` success, not in `runLookup`'s fallback branch, so a degraded lookup writes nothing. A `not_found` or `error` result never reaches the call at all.

## The disabled state

`createDatabaseClient` returns `{ enabled: false }` when `MONGODB_URI` is unset (Requirement 1.3) or when the startup `connect()` throws (Requirement 1.4). In that case the composition root builds `createNoopRankHistoryStore()` and `createNoopLookedUpPlayerStore()` — every method resolves to `undefined` / `[]` / `0` with no log line (Requirement 4.3). This is what keeps the entire existing test suite and every local run working with zero configuration.

The orchestrator's new constructor params are optional and default to the no-op stores, so existing orchestrator tests construct unchanged.

## Privacy route extension

`backend/src/app.ts`'s `POST /api/privacy/delete` handler today calls `cache.deleteByPuuid(puuid)` and shapes a `PuuidDeletionResult` into the response. It gains two more calls:

```typescript
const [cacheResult, snapshotsRemoved, playerRemoved] = await Promise.all([
  cache.deleteByPuuid(puuid),
  rankHistoryStore.deleteByPuuid(puuid).catch(() => 0),   // Requirement 5.3
  lookedUpPlayerStore.deleteByPuuid(puuid).catch(() => 0),
]);
```

The `.catch(() => 0)` keeps a Persistent_Store outage from failing a request whose cache-eviction half succeeded (Requirement 5.3). `found` in the response becomes true if *any* of the three removed something (Requirement 5.4). **The response body stays exactly `{ found, deletedAt }`** — `privacy.ts` decision 1 keeps row counts out of the response so an unauthenticated caller cannot probe how much data is held for a PUUID, and adding `persistentRowsRemoved` would reintroduce that leak. The counts stay internal (the store tests assert them). The route stays unauthenticated exactly as today — the README "Known gaps" note about that is unchanged and still applies.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGODB_URI` | No | *(unset)* | Atlas SRV connection string. Unset ⇒ Persistent_Store disabled, the site runs exactly as before this feature. A set-but-unreachable value logs once at startup (credentials stripped) and also runs disabled — it never crashes the process. |

`backend/src/config/index.ts` gains one optional field, `mongodbUri?: string`, read and trimmed like the others. No validation beyond "non-empty if present" — the driver validates the string shape, and an invalid one lands in the Requirement 1.4 disabled path.

## Testing

- **`InMemoryRankHistoryStore` / `InMemoryLookedUpPlayerStore`** — `Map`-backed, injected clock, model the same keep/skip and upsert semantics as the Mongo versions. Unit tests use these.
- **Keep/skip (2.2):** `shouldRecordSnapshot` table (no prior ⇒ keep; <3 games newer ⇒ skip; ≥3 games newer ⇒ keep; tier/division change ⇒ keep regardless; lower `gamesPlayed` ⇒ keep); and the same through `InMemoryRankHistoryStore.record`.
- **Unranked no-op (2.4):** a report with no `RANKED_SOLO_5x5` standing ⇒ `record` never called (asserted on a spy store).
- **Upsert-not-fork (3.3):** two `remember` calls for one puuid with different names ⇒ one record, latest name.
- **Ordering (2.5, 3.5):** `history` ascending by `observedAt`; `searchByNamePrefix` descending by `lastLookedUpAt`, prefix-anchored, case-insensitive, respects `limit`.
- **Failure isolation (4.2):** a throwing fake store injected into the orchestrator ⇒ `runLookup` still returns the success result, no rejection escapes (assert with an unhandled-rejection listener in the test).
- **Fallback path (3.4):** a lookup that returns the stale-cache fallback ⇒ neither store is touched.
- **Privacy (5.1-5.4):** deletion removes from all three stores; a throwing persistent store ⇒ route still 200s with the cache half done.
- **`mongo.integration.test.ts`** — gated by `MONGODB_TEST_URI`, skipped otherwise. Exercises the real unique-index rejection and the regex prefix scan against a throwaway database.

## Open Questions For The User

1. **`leaguePoints` on `RankedQueueStanding`.** Recording a Rank_Snapshot needs the player's current LP, and `ProfileStats.rankedByQueue` does not carry it today (only `tier`, `division`, `winRatePercent`). The fix is one additive field on an internal insight type, with the value already in hand at the mapping boundary. Confirm this small upstream change belongs in this spec rather than being pushed to `profile-sidebar` (which needs the field on the payload anyway).
2. **Pruning now or later.** Requirement 6.4 documents "retain the most recent 60 per (puuid, queueType)" as the strategy but leaves implementation deferred. Given the ~50 MB/year estimate, deferring seems clearly right — flagging it so the deferral is a decision, not an omission.
3. **`0.0.0.0/0` on the Atlas project.** Render's lower tiers have no static egress IP, so the network allow-list has to be open, leaning on SCRAM + TLS. If the deployment later moves to a tier or provider with a fixed egress IP, tighten it. Acceptable for now?
4. **Database and collection names** (`lolprofiles`, `rank_snapshots`, `looked_up_players`) — reasonable defaults, but say if you'd rather they were configurable or named differently.
