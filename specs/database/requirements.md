# Requirements Document

## Introduction

Every piece of state this backend keeps today is disposable. `backend/src/cache/index.ts` is an in-memory map with per-endpoint TTLs; it is *designed* to lose data on a restart, because everything in it can be re-fetched from Riot. That has been the right call for a pure lookup tool, and the README's "Known gaps" states the posture plainly: no `.env` loader, no database.

Two features on the roadmap cannot be built on that foundation.

The `profile-sidebar` spec's **Rank_History graph** (its Requirement 10) needs a record that *grows* and *survives redeploys*. Riot's API exposes only a player's current rank, never a history of it, so the only way to have a graph at all is for this system to record a snapshot each time someone is looked up, from the day it ships forward. The `profile-sidebar` design deliberately stopped short of choosing where those snapshots live — it listed three options and left the decision to be made explicitly, "because introducing the first database this project has ever had is a bigger commitment than anything else in that spec."

The **autofill search** feature (its own spec, `specs/autofill-search/`) has the same root need for a different reason. Riot has no name-search endpoint, so an as-you-type Riot ID suggester can only work by querying this site's own record of players it has already looked up. Without a persistent store there is nothing to query.

This spec introduces that store. The decision, made with the user on 2026-08-28, is **MongoDB Atlas on the free M0 tier** (512 MB storage, shared compute, 500-connection ceiling). Redis was considered alongside it — the roadmap note originally paired "a db and redis" — and is **explicitly deferred**: nothing in `profile-sidebar` or autofill needs a shared cache or shared rate-limit state, and the existing in-memory `CacheStore` continues to serve those. Redis becomes a question only if and when this backend runs as more than one instance.

Three properties shape the work, and each is a place a naive implementation goes wrong rather than merely slower.

**The store is not on the critical path and must never join it.** A lookup's job is to return a Profile_Report. Recording a rank snapshot and remembering the player are side effects of a successful lookup, not steps in producing one. A slow, erroring, or unreachable database must degrade to "the graph is a little younger and the autocomplete is missing one name," never to a slow lookup or a failed one. This is enforced structurally: the write calls are not awaited on the request path.

**The M0 tier has hard ceilings, and the design has to fit inside them rather than assume them away.** 512 MB of storage, roughly 100 operations per second cluster-wide, no automated backups, and deprovisioning after 60 days of total inactivity. The data model is chosen so that normal traffic stays orders of magnitude below every one of those limits, and the one that could bite — storage growth — has an explicit bound (a new snapshot only every few ranked games, or on a rank change, per player per queue) and a stated pruning story.

**A database that stores `gameName`, `tagLine`, `puuid`, and a rank history is squarely personal data, and the existing privacy-deletion route must reach it.** `POST /api/privacy/delete` today evicts a PUUID's cached data. The moment this store exists, "delete everything associated with this PUUID" has to include the snapshots and the remembered-player record, or the route silently stops doing what it claims.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend combined), unless a more specific subsystem is named.
- **Riot_ID**: A player identifier consisting of a `gameName` and a `tagLine` separated by `#`.
- **PUUID**: The Riot-issued globally unique player identifier returned by Account-V1.
- **Lookup_Session**: One run of the lookup orchestrator (`backend/src/orchestrator/index.ts`) for one submitted Riot_ID, as it exists today.
- **Cache_Store**: The existing in-memory, TTL-evicting persistence layer (`backend/src/cache/index.ts`). Unchanged by this spec.
- **Persistent_Store**: The new storage layer introduced by this spec. Survives process restarts and redeploys and does not evict entries by TTL. Concretely, a MongoDB Atlas M0 cluster; abstractly, whatever satisfies the store interfaces defined in design.md.
- **Database_Client**: The single long-lived MongoDB driver connection (`MongoClient`) owned by the composition root, shared by every store implementation for the life of the process — mirroring how `backend/src/index.ts` already builds exactly one clock, one Cache_Store, and one Rate_Limit_Manager for the whole process.
- **Rank_Snapshot**: One recorded observation of a player's ranked standing for one queue at one moment: `{ puuid, queueType, tier, division, leaguePoints, observedAt }`, captured during a Lookup_Session.
- **Rank_History**: The ordered sequence of Rank_Snapshots the Persistent_Store holds for a given PUUID and queue, oldest first.
- **Min_Games_Between_Snapshots**: The smallest increase in a player's ranked `gamesPlayed` (League-V4 `wins + losses`) that, on its own, makes a new Rank_Snapshot worth keeping — 3. A rank change or a game-count reset records regardless of this.
- **RankHistoryStore**: The storage-agnostic interface for recording and reading Rank_Snapshots, defined in design.md.
- **Looked_Up_Player**: This site's memory of one player it has successfully produced a report for: `{ puuid, gameName, tagLine, profileIconId, region, lastLookedUpAt }`.
- **LookedUpPlayerStore**: The storage-agnostic interface for remembering Looked_Up_Players and querying them by name prefix, defined in design.md. Its query method is *specified here* but *consumed by* `specs/autofill-search/`.
- **Write_Hook**: A call the lookup orchestrator makes to a store after a successful Lookup_Session, issued as a side effect and never awaited on the request path.
- **Solo_Queue_Type**: The raw League-V4 `queueType` string `RANKED_SOLO_5x5` — the value that appears as a key in `ProfileStats.rankedByQueue` for ranked solo/duo (see `backend/src/orchestrator/mapping.ts`, which retains Riot's raw `queueType`).

## Requirements

### Requirement 1: The Persistent Store Connection

**User Story:** As an operator, I want the database connection to be established once, configured from the environment, and to fail loudly at startup only when it is genuinely required, so that a misconfiguration is obvious and a local run without a database is still possible.

#### Acceptance Criteria

1. THE System SHALL create exactly one Database_Client for the process, in the composition root (`backend/src/index.ts`), alongside the existing single clock, Cache_Store, and Rate_Limit_Manager.
2. THE Database_Client SHALL read its connection string from a single environment variable (`MONGODB_URI`) and SHALL NOT read it from anywhere else, mirroring how the Riot API key is read exactly once.
3. WHEN `MONGODB_URI` is unset, THE System SHALL start normally with the Persistent_Store disabled, every store method behaving as a no-op that returns empty results, so that local development and the existing test suite need no database.
4. WHEN `MONGODB_URI` is set but a connection cannot be established at startup, THE System SHALL log the failure without the connection string's credentials and SHALL continue starting with the Persistent_Store in its disabled state, rather than crashing the process.
5. THE Database_Client SHALL connect over TLS with SCRAM authentication (Atlas's default) and SHALL bound its connection pool well below the M0 500-connection ceiling (a pool size in the low tens is sufficient for a single instance).
6. WHEN the process shuts down, THE System SHALL close the Database_Client.
7. THE System SHALL create every index the store implementations depend on at startup, idempotently, so that a fresh cluster is usable without a manual provisioning step.

### Requirement 2: Recording Rank Snapshots

**User Story:** As a visitor, I want a player's ranked solo/duo standing recorded each time they're looked up, so that a rank-over-time graph can be built from those observations.

#### Acceptance Criteria

1. WHEN a Lookup_Session completes successfully AND the resulting report has a `rankedByQueue` entry for the Solo_Queue_Type, THE System SHALL record a Rank_Snapshot for that PUUID and queue via a Write_Hook.
2. THE System SHALL keep a new Rank_Snapshot only when, relative to the most recent Rank_Snapshot already kept for that PUUID and queue, ANY of the following holds: there is no prior snapshot; the `tier` or `division` differs; the `gamesPlayed` count is lower than the prior one (a season or MMR reset); or at least `Min_Games_Between_Snapshots` more ranked games have been played (`gamesPlayed` delta ≥ `Min_Games_Between_Snapshots`). Otherwise the lookup SHALL add no snapshot and SHALL NOT overwrite the previous one. `Min_Games_Between_Snapshots` is 3.
3. A Rank_Snapshot SHALL carry `puuid`, `queueType`, `tier`, `division`, `leaguePoints`, `gamesPlayed` (the player's League-V4 `wins + losses` for that queue at observation time), and `observedAt` (the Lookup_Session's completion time, from the injected clock).
4. WHEN the report has no `rankedByQueue` entry for the Solo_Queue_Type (an unranked player), THE System SHALL record no Rank_Snapshot for that lookup and SHALL treat this as a normal outcome, not an error.
5. THE `RankHistoryStore` SHALL expose a read method returning a PUUID's Rank_History for a given queue, ordered oldest to newest by `observedAt`.
6. THE recording path SHALL be storage-agnostic: the orchestrator SHALL depend only on the `RankHistoryStore` interface, never on the MongoDB driver directly.
7. This spec SHALL NOT render the graph, add the `rankHistory` field to the Profile_Report payload, or change any frontend file; those belong to `specs/profile-sidebar/` (its Requirement 10), which consumes the read method from criterion 5.

### Requirement 3: Remembering Looked-Up Players

**User Story:** As a visitor typing a Riot ID, I want the site to suggest players it has seen before, which is only possible if every successful lookup is remembered.

#### Acceptance Criteria

1. WHEN a Lookup_Session completes successfully, THE System SHALL upsert a Looked_Up_Player record for that PUUID via a Write_Hook, keyed by PUUID.
2. A Looked_Up_Player record SHALL carry `puuid`, `gameName`, `tagLine`, `profileIconId` (nullable, matching the Profile_Report), `region` (the resolved platform), and `lastLookedUpAt` (the Lookup_Session's completion time).
3. WHEN a player already has a Looked_Up_Player record, the upsert SHALL update `gameName`, `tagLine`, `profileIconId`, `region`, and `lastLookedUpAt` to the latest values, so a rename or icon change is reflected and the record does not fork.
4. A lookup that ends in `not_found`, an error, or the Requirement 11.3 stale-cache fallback SHALL NOT create or update a Looked_Up_Player record, so the store holds only players a full report was genuinely produced for.
5. THE `LookedUpPlayerStore` SHALL expose a prefix-search method: given a case-insensitive `gameName` prefix and a result limit, it returns matching Looked_Up_Players ordered by `lastLookedUpAt` descending. This method is defined here and consumed by `specs/autofill-search/`; this spec adds no endpoint and no frontend for it.
6. THE recording and query paths SHALL depend only on the `LookedUpPlayerStore` interface, never on the MongoDB driver directly.

### Requirement 4: The Write Hooks Never Join the Critical Path

**User Story:** As a visitor, I want my lookup to be exactly as fast and as reliable as it is today, whether or not the database is healthy.

#### Acceptance Criteria

1. THE System SHALL issue every Write_Hook as an unawaited side effect of a successful Lookup_Session, such that the `LookupResult` is returned to the caller without waiting for any store write to complete.
2. WHEN a Write_Hook's underlying store operation rejects, times out, or throws, THE System SHALL swallow the failure after logging it, and SHALL NOT propagate it to the lookup result, the HTTP response, or an unhandled promise rejection.
3. WHEN the Persistent_Store is in its disabled state (Requirement 1.3/1.4), every Write_Hook SHALL be a no-op with no logged error.
4. THE budget/timeout behaviour of a Lookup_Session (`profile-sidebar`-independent, defined in the orchestrator spec) SHALL be unaffected by the presence, latency, or failure of any store.
5. THE Write_Hooks SHALL NOT issue any additional Riot API call; they operate only on data the Lookup_Session already resolved.

### Requirement 5: Privacy Deletion Reaches the Persistent Store

**User Story:** As a data subject, I want "delete my data" to actually delete all of it, including anything the new database holds.

#### Acceptance Criteria

1. WHEN `POST /api/privacy/delete` is invoked for a PUUID, THE System SHALL delete that PUUID's Rank_Snapshots and its Looked_Up_Player record from the Persistent_Store, in addition to the Cache_Store eviction it performs today.
2. THE deletion SHALL be idempotent and SHALL NOT error for a PUUID with nothing stored, matching the route's existing contract (`found: false`, HTTP 200).
3. WHEN the Persistent_Store is disabled or unreachable, the route SHALL still perform its Cache_Store eviction and SHALL report success for that part, rather than failing the whole request.
4. THE deletion confirmation's `found` flag SHALL be `true` when removal occurred in *any* store, Persistent_Store included, so the response never reports `found: false` after actually deleting Persistent_Store rows. It SHALL NOT expose a per-store or total row count — `POST /api/privacy/delete` deliberately keeps its body to `{ found, deletedAt }` (see `backend/src/api/privacy.ts` decision 1) so an unauthenticated caller cannot probe how much data is held for a PUUID.
5. As with the Cache_Store today, deletion need not be *durable*: a later lookup of the same player lawfully re-creates a Looked_Up_Player record and may record a new Rank_Snapshot. Requirement 5 governs what is held at the time of the request.

### Requirement 6: Fitting Inside the M0 Tier

**User Story:** As an operator on the free tier, I want the data model to stay far below every M0 ceiling under realistic traffic, and I want an explicit plan for the one limit that could eventually bite.

#### Acceptance Criteria

1. THE `rank_snapshots` collection SHALL be bounded in growth by Requirement 2.2 (a new document only every `Min_Games_Between_Snapshots` ranked games, or on a rank change, per PUUID per queue), and design.md SHALL state the resulting storage estimate against the 512 MB ceiling.
2. THE System SHALL apply Requirement 2.2 with a read-then-write in `RankHistoryStore.record` (read the latest kept snapshot for the `(puuid, queueType)`, decide, then insert), served by the `(puuid, queueType, observedAt)` index. There is NO unique index: the keep/skip rule is a `gamesPlayed` delta, which no index can express. design.md SHALL note that two genuinely concurrent fresh lookups of the same player can therefore each insert one point, and why that is acceptable (rare — a cached lookup records nothing — and it does not distort the graph).
3. Each Write_Hook SHALL perform a small, bounded number of database operations: the rank-snapshot hook does one indexed read plus at most one insert; the checkpoint and remembered-player hooks do one upsert each. A lookup therefore costs a single-digit number of operations against the ~100 ops/sec cluster ceiling, all off the request path.
4. design.md SHALL document a Rank_Snapshot pruning strategy (retain the most recent N per PUUID/queue, or snapshots newer than a cutoff) even if the implementation is deferred, so the storage bound has a stated escape valve.
5. design.md SHALL note the M0 realities that affect operations: no automated backups (acceptable — the data is derived and its loss degrades gracefully), and deprovisioning after 60 days of inactivity (not a concern for a live site).

### Requirement 7: Configuration, Documentation, and Local Development

**User Story:** As a developer, I want to run and test the backend with no database, and to stand up the real one from the README when I need it.

#### Acceptance Criteria

1. THE new environment variables SHALL be documented in the README's backend configuration table with the same rigour as `RIOT_API_KEY` and `DDRAGON_VERSION`: name, whether required, default, and what breaks without it.
2. `MONGODB_URI` SHALL be listed as **not required**, its absence disabling the Persistent_Store, so `npm run build && npm start` works with no database exactly as today.
3. `backend/.env.example` SHALL include `MONGODB_URI` with a placeholder Atlas SRV string and a comment that it is reference-only (the project still has no `.env` loader).
4. THE README's "Known gaps" section SHALL be updated to reflect that a database now exists, what it stores, and that Redis remains deliberately absent.
5. THE README SHALL briefly describe the one-time Atlas M0 setup (create cluster, create database user, allow network access, copy the SRV URI) so the deployment is reproducible.

### Requirement 8: Testing Strategy

**User Story:** As a maintainer, I want the store logic covered without a live database in CI, and a clear seam for an opt-in integration test.

#### Acceptance Criteria

1. THE store interfaces SHALL each have an in-memory fake implementation, usable by unit tests the same way `InMemoryCacheStore` is, with an injected clock and no I/O.
2. THE deduplication rule (Requirement 2.2), the unranked no-op (Requirement 2.4), the upsert-not-fork rule (Requirement 3.3), the ordering guarantees (Requirements 2.5, 3.5), and the fire-and-forget failure isolation (Requirement 4.2) SHALL be covered by tests against the fakes and a deliberately-throwing fake.
3. Any test that talks to a real MongoDB instance SHALL be gated behind an environment variable so it is skipped by default and never runs in the standard `npm test`.
4. THE existing backend and frontend suites SHALL remain green with no database configured.
