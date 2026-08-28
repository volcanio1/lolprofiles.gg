# Implementation Plan: match-cache

## Overview

Depends on `specs/database/` (the `MongoClient`, `ensureIndexes`, the store pattern, the composition-root wiring) — all landed. Independent of `specs/autofill-search/` but sits naturally after it, since it reuses the same `POST /api/privacy/delete` plumbing and the same `storeWriteFailed` logger seam.

A persistent tier under the in-memory `matchDetail` cache: matches survive restarts, a Refresh only fetches new games, and one stored match serves every player in it. No change to rendering, transport limits, the timeline, or any frontend file.

## Tasks

- [x] 1. The trimmed shape + projection
  - [x] 1.1 `backend/src/riotApiClient/matchProjection.ts` — `projectMatchDto(raw): MatchDto` + `projectParticipant` / `projectPerks` / `projectStyle`. Pure, **total** over any input (null/junk → well-formed sparse `MatchDto`, never throws). Participant fields copied from a `PARTICIPANT_KEYS` list matching the interface exactly; optionals (`gameMode`, `perks`) only set when present. `MatchDto` types imported type-only — no runtime cycle. Re-exported from `riotApiClient/index.ts`.
  - [x] 1.2 `getMatchById` awaits `send<unknown>` and returns `{ kind: 'ok', data: projectMatchDto(result.data) }` on a 200, passing every non-ok result through unchanged. Both the Cache_Store `set` and the future `MatchStore` `putMany` therefore receive the trimmed shape.
  - [x] 1.3 **grep audit clean.** `grep -rn "\.challenges|\.missions|\.teams|gameCreation|mapId|platformId|gameVersion|totalDamageTaken|spell1Casts|summonerName|\.info\[|participant\[" src ../frontend/src` (non-test): only two hits — `orchestrator/mapping.ts:375` is a comment stating the code *deliberately does not* read `info.teams[].objectives` (it sums kills from participant rows instead), and `frontend/src/components/MatchRow.tsx:66` is `participant[marker]` on the already-derived frontend `MatchParticipant` type, not the raw `MatchDto`. No consumer reads an undeclared field.
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 1.4 `matchProjection.test.ts` (14): a fixture participant with every declared field + `challenges`/`missions`/`spell1Casts`/`totalDamageTaken`/`summonerName`/… and a match with `teams`/`gameCreation`/`mapId`/`dataVersion` — asserts they're dropped, keys are exactly the declared set, a full `perks` page round-trips; asserts `toIncludedMatch` / `toLanelessMatch` / `computeRecentMatches` are `toEqual` across raw-vs-projected; totality (`null`/`undefined`/`'garbage'`/`42`/`[]`/malformed → no throw), non-string participant filtering, idempotence. Plus one `getMatchById` wiring test in `index.test.ts`. Full backend suite 617 pass / 9 skip; tsc + eslint clean.
    - _Requirements: 9.1_

- [x] 2. `MatchStore` module
  - [x] 2.1 `backend/src/db/matchStore.ts`: `StoredMatch` (`{ matchId, match, region, storedAt }`), `MatchStore` (`getMany` → `Map<string, StoredMatch>`, `putMany`, `deleteByPuuid`). `MATCH_STORE_READ_TIMEOUT_MS = 1500` exported. Also added `MATCH_DETAILS_COLLECTION` + `MATCH_DETAIL_TTL_SECONDS` (150 d) to `collections.ts` (the store needs the name to compile; `ensureIndexes` + wiring stay in task 3).
  - [x] 2.2 `InMemoryMatchStore` (+ `createInMemoryMatchStore`) — `Map<string, StoredMatch>`, returns/stores copies; `deleteByPuuid` scans `match.metadata.participants`.
  - [x] 2.3 `createNoopMatchStore()` — empty `Map` / no-op / 0.
  - [x] 2.4 `MongoMatchStore(db, { scheduleTimeout?, readTimeoutMs? })` — `_id` = matchId; `getMany` = `find({ _id: { $in } }).maxTimeMS(1500)` **raced against an injected-scheduler deadline** (`Promise.race`), either failure path → empty Map, **never rejects** (Requirement 3.4); `putMany` = one unordered `bulkWrite` of `updateOne` upserts; `deleteByPuuid` = `deleteMany({ 'match.metadata.participants': puuid })`. `storedAt` BSON `Date` at rest, epoch ms across the interface. `MatchDto` / `TimeoutScheduler` imported type-only from `../riotApiClient`.
    - _Requirements: 1.1, 1.2, 1.3, 3.4, 3.5, 4.2, 4.5, 6.2_
  - [x] 2.5 `matchStore.test.ts` (6) — `getMany` subset + empty-list + copies, `putMany` upsert-not-fork, `deleteByPuuid` participant match + count + idempotence, no-op empties. Full backend suite 623 pass / 9 skip; tsc + eslint clean.
    - _Requirements: 9.2_

- [x] 3. Collection, indexes, wiring
  - [x] 3.1 `MATCH_DETAILS_COLLECTION` + `MATCH_DETAIL_TTL_SECONDS` (150 d) in `collections.ts` (done in task 2); re-exported from `client.ts`.
  - [x] 3.2 `ensureIndexes`: `{ storedAt: 1 }` `ttl_storedAt` `expireAfterSeconds`, and `{ 'match.metadata.participants': 1 }` `participants` (multikey). Verified `ensureIndexes` still runs clean against `mongo:7` (integration `beforeAll`).
  - [x] 3.3 `matchStore` threaded: `backend/src/index.ts` (`databaseClient.enabled ? new MongoMatchStore : createNoopMatchStore`), `LookupOrchestratorOptions.matchStore?` (interface only — constructor field + use is task 4), `ApiDependencies.matchStore?`, `createApiRouter` → `createPrivacyDeleteHandler`, `PrivacyRouteDependencies.matchStore?` + default. **The privacy `Promise.all` already gains `matchStore.deleteByPuuid(puuid).catch(() => 0)` folded into `found`** — task 6 is now just the test. All optional params, existing suites untouched (623 pass / 9 skip + 9 integration); tsc + eslint clean.
    - _Requirements: 1.3, 1.4, 6.1, 6.3, 7.1, 7.2_

- [x] 4. Orchestrator: read before Riot, write after
  - [x] 4.1 `matchStore` constructor field → `createNoopMatchStore()` default (option was added in task 3).
  - [x] 4.2 `fetchMatchDetails` — pre-loop over the truncated match-id list calling `readCached` (matchDetail TTL is `'infinite'`, so a present entry is always a usable hit); `matchStore.getMany(cacheMissIds).catch(() => new Map())` for the rest.
    - _Requirements: 3.1, 3.4, 3.5_
  - [x] 4.3 The fan-out `map` normalises to `{ value: MatchDto } | { failure }`: a `stored` hit → `cache.set(key, hit.match, 'infinite').catch(() => {})` + `{ value }`, no `getMatchById`; a miss → existing `cacheOrFetch`; a non-`fromCache` success is pushed to `fetchedFromRiot`. Classification loop unchanged in behaviour.
    - _Requirements: 3.2, 3.3_
  - [x] 4.4 After the fan-out: `void (async () => matchStore.putMany(fetchedFromRiot.map(m => ({ matchId: m.metadata.matchId, match: m, region, storedAt: now() }))))().catch(reason => logger.storeWriteFailed({ reason }))` — unawaited, one bulk write, only Riot-fetched matches, fired from inside `fetchMatchDetails` before any later stage can fail (Requirement 4.3).
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 4.7_
  - [x] 4.5 `index.test.ts` "MatchStore" describe (5): store hit ⇒ no `getMatchById` for that id + cache seeded + stored data used; miss ⇒ Riot + `putMany` writes only m2/m3 with `storedAt === now()`, m1 untouched; throwing `getMany` ⇒ all 3 fetched from Riot, lookup succeeds, no `storeWriteFailed`; throwing `putMany` ⇒ `storeWriteFailed` logged, lookup succeeds; cache-holds-m1 + store-holds-m2 ⇒ only m3 fetched (Requirement 5.1). `HarnessOptions.matchStore?` added. Full backend suite 628 pass / 9 skip; tsc + eslint clean; the 53 existing orchestrator tests unchanged (noop default).
    - _Requirements: 9.3, 9.4_

- [x] 5. `buildFallbackReport` store read
  - [x] 5.1 `buildFallbackReport` collects cache hits into a `Map` and the misses into `storeMissIds`, then `matchStore.getMany(storeMissIds).catch(() => new Map())`; the assembly loop reads `cacheEntries.get(id) ?? stored.get(id)?.match`. A match neither source has is excluded exactly as today; no Riot call added.
    - _Requirements: 3.6_
  - [x] 5.2 `index.test.ts` (Requirement 11.3 fallback describe): a snapshot with account/region/league/matchIds cached but **no cached match details**, both matches in the `MatchStore`, league refresh forced to fail → the fallback report renders both matches (`['Lux','Sett']`), `partialDataWarning: true`, and `callsAt('matchDetail')` is empty. Orchestrator 59 pass; full backend suite 629 pass / 9 skip; tsc + eslint clean.

- [x] 6. Privacy deletion
  - [x] 6.1 Done in task 3 — `PrivacyRouteDependencies.matchStore?` + noop default; `matchStore.deleteByPuuid(puuid).catch(() => 0)` in the `Promise.all`, folded into `found`, no count in the body.
    - _Requirements: 6.1, 6.3_
  - [x] 6.2 `privacy.test.ts` (2): a delete evicts the whole `NA1_1` doc the PUUID participated in while keeping the bystander-only `NA1_2`; a `matchStore.deleteByPuuid` rejection alone still yields `200 { found: true }` with nothing logged. `HarnessStores.matchStore?` added. Full backend suite 631 pass / 9 skip; tsc + eslint clean.

- [x] 7. Integration test
  - [x] 7.1 `mongo.integration.test.ts` extended (+3 = 12 total): `ttl_storedAt` (`expireAfterSeconds === MATCH_DETAIL_TTL_SECONDS`) + `participants` indexes exist; `putMany` upsert-not-fork + `getMany` round trip (only stored ids, latest `storedAt`) + `deleteByPuuid` by participant (evicts the victim's doc, keeps the bystander-only one); `getMany` with an immediate-firing injected scheduler resolves an empty `Map` rather than rejecting. **Verified green against `mongo:7` (12/12).** Backend suite 631 pass / 12 skip; tsc + eslint clean.
    - _Requirements: 9.6_

- [x] 8. Documentation
  - [x] 8.1 README Database table: new `match_details` row (written per lookup that fetched matches, bulk upsert keyed by `matchId`; holds trimmed `MatchDto` + region + storedAt, ~5 KB; read by the pipeline + fallback; one doc serves all 10 players). fire-and-forget paragraph + privacy line now say "four collections" and note eviction-not-redaction.
  - [x] 8.2 README: trimmed-not-raw (~5 KB vs 50–120 KB), the 150-day TTL as a storage bound only, the ~58k-match / 350 MB estimate, and the "critical-path-but-bounded" read caveat; Caching table `matchDetail` row rewritten to note cross-restart persistence + trimming; Known-gaps rate-limit + no-backups bullets updated.
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 9. Verification
  - [x] 9.1 `test:backend` 631 pass / 12 skip + `test:frontend` 448 pass, no `MONGODB_URI`; `tsc` + `eslint` clean on both workspaces.
  - [x] 9.2 `mongo:7` container: `mongo.integration.test.ts` 12/12 green with `MONGODB_TEST_URI`.
  - [x] 9.3 **Live against the real Atlas M0** (`backend/.env`). Cold lookup of "Hide on bush" (30 recent matches) took 6.2 s and grew `match_details` from 1 → 31. **Restarted the backend** (in-memory cache wiped). Re-lookup of the same player: 3.2 s, still 30 recent matches, `match_details` **unchanged at 31** — every match detail served from the store, zero Match-V5 detail calls. `POST /api/privacy/delete` for that PUUID took `match_details` 31 → 1 (evicted all 30 participant docs, kept the one game they weren't in). Cross-player reuse is covered by the task-4.5 unit test. All test rows cleaned up (`match_details` → 0; also cleared `looked_up_players` / `profile_reports` / `rank_snapshots` including some pre-existing test lookups from earlier sessions).

**Spec status: tasks 1–9 complete. Not committed.** Backend build rebuilt + restarted (job `b621ztxaq`, Mongo-connected). Only optional tasks 10.x remain.

## Optional (skipped by default)

- [ ] * 10.1 `lastAccessedAt` bumped in `getMany` + an LRU sweep, replacing the flat-age escape valve
- [ ] * 10.2 A `matchStore.getMany` metric / log line (hit rate) to tune the TTL from real data
- [ ] * 10.3 Property test: `projectMatchDto` is idempotent (`project(project(x)) === project(x)`) and total over arbitrary junk input
