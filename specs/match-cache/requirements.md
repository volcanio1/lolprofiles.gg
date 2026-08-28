# Requirements Document

## Introduction

A completed League match never changes. `backend/src/cache/index.ts` already exploits this: `matchDetail` entries are cached with `ttlMs: 'infinite'` and are never re-fetched for the life of the process. Within one running backend, a match is pulled from Riot exactly once.

The problem is *"for the life of the process."* That cache is an in-memory map. Every deploy, crash, or restart empties it, and the next lookup of any player re-fetches all of their recent match details from scratch — the single largest source of Riot API calls this backend makes. A cold lookup with `MATCH_HISTORY_COUNT` matches is roughly `4 + N` calls; four of those are metadata and `N` are match details. After a restart, every lookup pays the full `N` again for data that has not changed since the last time the site saw it.

There is a second, subtler waste on the warm path. When a visitor uses the Refresh button (`specs/autofill-search/` Requirement 10) or a stale `profile_reports` snapshot forces a live lookup, the orchestrator fetches the *current* match-ID list and then fetches every detail in it — even though, for a returning player, most of those matches were already fetched minutes or hours ago and only a handful are new. The in-memory cache absorbs this *if the process has not restarted since*; nothing absorbs it otherwise.

This spec adds a persistent tier for match details, on the same MongoDB Atlas M0 cluster `specs/database/` introduced. It is deliberately narrow:

- **It stores a trimmed match, not Riot's raw JSON.** Riot's `GET /lol/match/v5/matches/{matchId}` response is 50–120 KB — the bulk of it (`challenges`, `missions`, per-participant damage and ping breakdowns) is data this codebase already never reads. `backend/src/riotApiClient`'s `MatchDto` type declares roughly forty fields; everything else in the payload is dead weight. Projecting the response down to that shape at fetch time makes each stored match 4–6 KB and, as a bonus, shrinks the in-memory cache by the same factor.
- **One stored match serves every player in it.** `toIncludedMatch(match, puuid)` in `backend/src/orchestrator/mapping.ts` derives every perspective-relative fact — which participant is the analyzed player, which is the lane opponent, the matchup summary — from a raw `MatchDto` plus a PUUID, at read time. So the store is keyed by `matchId` alone, and a match fetched for one player is reused for the next player who was in that game.
- **It changes no output.** How matches are rendered, the `RECENT_MATCH_TRANSPORT_LIMIT`, the build-path timeline (`timelineSlice`, a separate concern), and every frontend file are untouched. This spec only changes where a match detail comes from on a cache miss.

Three properties shape the work.

**The write path stays fire-and-forget, exactly as `specs/database/` established.** Storing matches is a side effect of having fetched them, never a step in producing a report. A slow or failing store must not delay or fail a lookup.

**Unlike `specs/database/`, this spec puts a database *read* on the critical path** — the orchestrator must consult the store before deciding to call Riot, or the store buys nothing. That read is therefore bounded and fail-safe: a slow or erroring store read is treated as a miss and the lookup falls through to Riot, so the worst case is "as slow as today," never slower.

**Stored matches are personal data about ten people each, and `POST /api/privacy/delete` must reach them** — the same obligation `specs/database/` accepted for its collections, and the same rule the in-memory `matchDetail` cache already follows (a PUUID's deletion evicts every cached match they participated in).

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend combined), unless a more specific subsystem is named.
- **PUUID**: The Riot-issued globally unique player identifier returned by Account-V1.
- **Lookup_Session**: One run of the lookup orchestrator (`backend/src/orchestrator/index.ts`) for one submitted Riot ID.
- **Cache_Store**: The existing in-memory, TTL-evicting persistence layer (`backend/src/cache/index.ts`). Its `matchDetail` entries use `ttlMs: 'infinite'`.
- **Persistent_Store**: The MongoDB Atlas M0 storage layer introduced by `specs/database/`. This spec adds one collection to it.
- **Database_Client**: The single long-lived `MongoClient` owned by the composition root (`specs/database/` Requirement 1). Reused here; no second connection.
- **Match_Detail**: One match's data as this codebase uses it — the shape declared by `MatchDto` / `MatchParticipantDto` in `backend/src/riotApiClient`: `metadata` (`matchId`, participant PUUIDs) and `info` (`queueId`, `gameMode?`, `gameStartTimestamp`, `gameDuration`, and a trimmed participant row per player).
- **Raw_Match_Response**: The full JSON Riot returns from `GET /lol/match/v5/matches/{matchId}` — everything the current code parses via `response.json()` and then only partially reads.
- **Match_Projection**: The pure function that reduces a Raw_Match_Response to a Match_Detail, dropping every field no downstream consumer reads.
- **Stored_Match**: A Match_Detail persisted in the Persistent_Store: `{ matchId, match, region, storedAt }`, keyed by `matchId`.
- **MatchStore**: The storage-agnostic interface for reading and writing Stored_Matches, defined in design.md.
- **Match_History_Window**: The list of match IDs a Lookup_Session obtains from Match-V5's match-ids endpoint and then resolves to details (`backend/src/orchestrator/index.ts`, capped at `MATCH_HISTORY_COUNT`).
- **Write_Hook**: A call the orchestrator makes to a store as an unawaited side effect, never on the request's return path (`specs/database/` Requirement 4).
- **Disabled_State**: The state in which `MONGODB_URI` is unset or unreachable and every Persistent_Store method is a no-op (`specs/database/` Requirement 1.3/1.4).

## Requirements

### Requirement 1: The Match Store

**User Story:** As an operator, I want match details to survive a restart, so that a deploy does not re-cost every match on the next lookup of every player.

#### Acceptance Criteria

1. THE System SHALL introduce a `MatchStore` interface with, at minimum: a batch read `getMany(matchIds)` returning the Stored_Matches that exist, a batch write `putMany(matches)`, and `deleteByPuuid(puuid)` returning a count.
2. THE `MatchStore` SHALL be storage-agnostic: the orchestrator SHALL depend only on the interface, never on the MongoDB driver directly.
3. THE MongoDB implementation SHALL use the existing Database_Client; this spec SHALL NOT open a second connection.
4. WHEN the Persistent_Store is in the Disabled_State, THE `MatchStore` SHALL be a no-op: `getMany` returns nothing, `putMany` writes nothing, `deleteByPuuid` returns 0, with no logged error — so a run with no `MONGODB_URI` behaves exactly as today.
5. THE `MatchStore` SHALL have an in-memory fake implementation for tests, mirroring the other store fakes.

### Requirement 2: The Stored Shape Is the Trimmed Match, Not the Raw Response

**User Story:** As an operator on a 512 MB tier, I want each stored match small enough that the collection stays well inside the ceiling under realistic traffic.

#### Acceptance Criteria

1. THE System SHALL define a Match_Projection: a pure function from a Raw_Match_Response to a Match_Detail that retains exactly the fields the `MatchDto` / `MatchParticipantDto` interfaces declare and drops all others.
2. `backend/src/riotApiClient`'s `getMatchById` SHALL apply the Match_Projection before returning, so that **both** the Cache_Store and the `MatchStore` hold the trimmed shape and no caller ever sees the untrimmed payload.
3. THE Match_Projection SHALL be lossless with respect to every downstream consumer: `toIncludedMatch`, `toLanelessMatch`, `toMatchParticipant`, `opponentRowOf`, `computeRecentMatches`, and the match-performance rating SHALL produce byte-identical output before and after the projection is introduced.
4. A Stored_Match SHALL carry the projected `match`, its `matchId` (as the document key), the `region` it was fetched from, and `storedAt` (epoch ms from the injected clock).
5. design.md SHALL state the resulting per-document size estimate and the collection's storage estimate against the 512 MB M0 ceiling, net of the collections `specs/database/` and `specs/autofill-search/` already occupy.

### Requirement 3: Reading the Store Before Calling Riot

**User Story:** As a visitor, I want a lookup after a restart to reuse everything the site already knows, so it is as fast as a warm lookup, not a cold one.

#### Acceptance Criteria

1. WHEN a Lookup_Session resolves its Match_History_Window, THE System SHALL, for every match ID not already satisfied by a non-stale Cache_Store entry, consult the `MatchStore` via a single `getMany` before issuing any Match-V5 detail call.
2. FOR each match ID the `MatchStore` returns, THE System SHALL use the Stored_Match directly, SHALL populate the Cache_Store with it (so a same-process repeat is instant), and SHALL NOT issue a Match-V5 detail call for it.
3. FOR each match ID neither cache nor store satisfies, THE System SHALL fetch it from Riot exactly as it does today, through the existing `cacheOrFetch` path and the existing concurrency bound (`MATCH_DETAIL_CONCURRENCY`).
4. THE `MatchStore` read SHALL be bounded and fail-safe: a read that rejects, throws, or exceeds a short internal timeout SHALL be treated as returning nothing, so the Lookup_Session falls through to Riot and is never slower than today because of the store.
5. THE `MatchStore` read SHALL count as at most one database operation per Lookup_Session, against the ~100 ops/sec M0 ceiling.
6. THE Requirement 11.3 stale-cache fallback (`buildFallbackReport`) SHALL also consult the `MatchStore` for match details it cannot find in the Cache_Store, so a fallback report assembled after a restart is as complete as one assembled before it.

### Requirement 4: Writing Fetched Matches

**User Story:** As an operator, I want every match the site fetches to be remembered, so it is never fetched twice.

#### Acceptance Criteria

1. WHEN a Lookup_Session fetches one or more Match_Details from Riot, THE System SHALL persist them to the `MatchStore` via a Write_Hook — a single `putMany` issued as an unawaited side effect.
2. THE write SHALL be keyed by `matchId` and SHALL be an upsert, so a concurrent lookup that fetched the same match does not fault and re-writing an identical match is harmless.
3. THE write SHALL occur regardless of the Lookup_Session's overall outcome — a lookup that fetched twenty match details and then failed at a later stage SHALL still persist those twenty, because a completed match is valid immutable data independent of why it was being fetched.
4. WHEN a `putMany` rejects, throws, or times out, THE System SHALL swallow the failure after logging it, exactly as `specs/database/` Requirement 4.2 requires of its Write_Hooks — never a failed lookup, a changed HTTP response, or an unhandled rejection.
5. THE write SHALL be at most one database operation per Lookup_Session (one bulk upsert), against the ~100 ops/sec ceiling.
6. WHEN the Persistent_Store is in the Disabled_State, the write SHALL be a silent no-op.
7. THE Write_Hook SHALL NOT issue any Riot API call; it operates only on data the Lookup_Session already fetched.

### Requirement 5: Incremental Refresh Is the Consequence

**User Story:** As a visitor pressing Refresh on a player I looked up yesterday, I want it to cost only the matches that are new since then.

#### Acceptance Criteria

1. GIVEN a returning player whose recent matches are mostly already in the `MatchStore`, WHEN a live Lookup_Session runs for them (a typed lookup, a Refresh, or a stale-snapshot fall-through), THE System SHALL issue Match-V5 detail calls only for the match IDs neither the Cache_Store nor the `MatchStore` already holds.
2. This behaviour SHALL fall out of Requirements 3 and 4 with no dedicated "diff the match list" logic; the match-ids call itself is still made (it is the source of truth for *which* matches to show) and is still governed by its existing 10-minute Cache_Store TTL.
3. The `profile_reports` snapshot (`specs/autofill-search/` Requirement 8) SHALL be unaffected: a fresh snapshot still renders a suggestion pick with zero Riot calls; the `MatchStore` additionally reduces the cost of the paths a snapshot does not cover (typed lookups, Refresh, stale or absent snapshots, and cross-player reuse).

### Requirement 6: Privacy Deletion Reaches Stored Matches

**User Story:** As a data subject, I want "delete my data" to remove me from the match records the site has stored, not just from its cache.

#### Acceptance Criteria

1. WHEN `POST /api/privacy/delete` is invoked for a PUUID, THE System SHALL delete from the `MatchStore` every Stored_Match in which that PUUID appears as a participant, in addition to the Cache_Store eviction and the `specs/database/` / `specs/autofill-search/` collection deletions it already performs.
2. THE deletion SHALL be *eviction* (removing the whole Stored_Match document), not in-place redaction of the one participant row — matching the Cache_Store's own decision (`backend/src/cache/index.ts`, task 5.4: a redacted match detail permanently empties every other participant's report, whereas an evicted one is simply re-fetched whole on the next lookup that needs it).
3. THE deletion SHALL be best-effort: a `MatchStore` failure SHALL NOT fail the request whose Cache_Store eviction succeeded (`specs/database/` Requirement 5.3), and SHALL fold into the existing `found` flag without adding a per-collection count to the response body (`specs/database/` Requirement 5.4).
4. As with every other store, deletion need not be durable: a later lookup that re-fetches an evicted match lawfully re-stores it, because the match is public data about a game that happened. Requirement 6 governs what is held at the time of the request.

### Requirement 7: Fitting Inside the M0 Tier

**User Story:** As an operator on the free tier, I want the `match_details` collection to have a stated storage bound and never a correctness dependence on that bound.

#### Acceptance Criteria

1. THE `match_details` collection SHALL carry a TTL index on `storedAt` with a retention period long enough that a returning player's history is still cached (design.md SHALL propose a value; 120–180 days is the expected range) and short enough that the collection's steady-state size stays within the M0 budget from Requirement 2.5.
2. THE TTL SHALL be a *storage bound only*, never a correctness mechanism: a completed match is immutable, so an expired-and-re-fetched match is byte-identical, and the read path (Requirement 3) SHALL apply no age check of its own — a Stored_Match of any age is usable.
3. Each Lookup_Session SHALL cost the `MatchStore` at most one read (`getMany`) plus one write (`putMany`), i.e. at most two operations, against the ~100 ops/sec ceiling.
4. design.md SHALL document a fallback if the TTL proves insufficient (shorten it, or add a hard document cap with an LRU-style `lastAccessedAt` field), even if unimplemented, so the storage bound has a stated escape valve.
5. design.md SHALL note that the `match_details` collection has no automated backup (acceptable — every document is re-fetchable from Riot and its loss degrades to "one cold lookup").

### Requirement 8: Configuration and Documentation

**User Story:** As a developer, I want the README to explain that match details are now persisted, alongside the other collections.

#### Acceptance Criteria

1. THE README's Database section SHALL gain a `match_details` row in its collections table: what is written, when, what it holds, and what reads it.
2. THE README SHALL state that match details are stored **trimmed, not raw**, with the approximate per-document size and the collection's TTL.
3. THE README's Caching section SHALL be updated so the `matchDetail | Indefinite` row notes that indefinite retention now spans restarts via `match_details`, not just the process lifetime.
4. THE README's "Known gaps" / rate-limit notes SHALL be updated to reflect that a restart no longer cold-caches every match.
5. No new environment variable SHALL be introduced; `MONGODB_URI` unset continues to disable the whole Persistent_Store, `match_details` included.

### Requirement 9: Testing Strategy

**User Story:** As a maintainer, I want the read/write path and the projection covered without a live database.

#### Acceptance Criteria

1. THE Match_Projection SHALL have a unit test proving it retains every field the `MatchDto` / `MatchParticipantDto` interfaces declare and that `toIncludedMatch` / `computeRecentMatches` output is unchanged across it, using a realistic Raw_Match_Response fixture that includes the fields being dropped.
2. THE `MatchStore` in-memory fake and the no-op SHALL be covered: `getMany` returns only existing ids, `putMany` upserts by `matchId`, `deleteByPuuid` removes docs the PUUID is a participant in and returns the count, no-op returns empty/0.
3. THE orchestrator's match-detail path SHALL be tested: a store hit issues no Match-V5 detail call and populates the Cache_Store; a store miss fetches from Riot and writes back; a store read that throws falls through to Riot and never fails the lookup; a `putMany` that throws is logged and swallowed.
4. THE incremental-refresh behaviour (Requirement 5.1) SHALL be tested: given a match list that is partly in the store, only the absent ids are fetched from Riot.
5. `POST /api/privacy/delete` SHALL be tested to evict the PUUID's Stored_Matches alongside the other collections, and to still succeed when only the `MatchStore` deletion throws.
6. Any test that talks to a real MongoDB SHALL be gated behind `MONGODB_TEST_URI` and skipped by default (extend `backend/src/db/mongo.integration.test.ts`).
7. THE existing backend and frontend suites SHALL remain green with no database configured.
