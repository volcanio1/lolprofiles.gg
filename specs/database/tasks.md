# Implementation Plan: database

## Overview

This plan is ordered so that nothing touches the request path until the storage layer exists and is tested in isolation, and so that the backend keeps building and testing green at every step with no database configured.

The one genuine constraint: **the write hooks must never be awaited on the lookup path, and a store failure must never escape as a rejection.** That is enforced structurally (an unawaited `void Promise.allSettled(...)` whose only continuation logs) and asserted by a test that injects a throwing store and listens for unhandled rejections. Task 4 does not merge until that test passes.

The one upstream change outside `backend/src/db/`: `RankedQueueStanding` gains a `leaguePoints` field (Open Question 1). It is purely additive and the value is already in hand in `rankedByQueueOf`.

Redis is out of scope by decision — not mentioned again in this plan.

## Tasks

- [x] 1. Store interfaces and in-memory fakes (no I/O, no driver)
  - [x] 1.1 Define `RankHistoryStore` + `RankSnapshot` in `backend/src/db/rankHistoryStore.ts`; implement `InMemoryRankHistoryStore` and `createNoopRankHistoryStore`
    - Done. Dedup key is `puuid + ' ' + queueType + ' ' + snapshotDay`; `snapshotDayOf(observedAt)` = `new Date(observedAt).toISOString().slice(0,10)` (UTC), exported for reuse by the Mongo impl's `snapshotDay` field. Same-key `record` is a no-op (first observation of the day stands); `history` sorts ascending by `observedAt` and returns copies; `deleteByPuuid` returns the count.
    - The `now` option is accepted (parity + future use) but currently unused — no clock is needed since `observedAt` is supplied by the caller.
    - _Requirements: 2.2, 2.3, 2.5, 5.1, 8.1_
  - [x] 1.2 Define `LookedUpPlayerStore` + `LookedUpPlayer` in `backend/src/db/lookedUpPlayerStore.ts`; implement `InMemoryLookedUpPlayerStore` and `createNoopLookedUpPlayerStore`
    - Done. `Map` keyed by puuid ⇒ `remember` is an upsert by construction. `searchByNamePrefix` trims + lowercases the prefix, returns `[]` for a blank prefix or non-positive limit, `startsWith`-matches lowercased `gameName`, sorts `lastLookedUpAt` desc, slices to `limit`, returns copies. In-memory `startsWith` is inherently literal; the regex-escape obligation lands on `MongoLookedUpPlayerStore` (task 2.3) and is asserted by a metacharacter test here.
    - _Requirements: 3.1, 3.3, 3.5, 5.1, 8.1_
  - [x] 1.3 Unit tests — `backend/src/db/rankHistoryStore.test.ts` (12) + `lookedUpPlayerStore.test.ts` (14), all green; full backend suite 516 passing, tsc + eslint clean
    - Covered: `snapshotDayOf` UTC-midnight roll; same-day dedup keeps first value; next-UTC-day adds a second; per-queue and per-PUUID dedup independence; `history` ordering + emptiness + copy-safety; `deleteByPuuid` count + idempotence; upsert-not-fork with field refresh; prefix anchoring / case-insensitivity / recency ordering / limit / blank-prefix / regex-metacharacter-is-literal; both no-op stores.
    - A deliberately-throwing fake is deferred to task 4.3 (orchestrator failure-isolation), which is where it is actually exercised.
    - _Requirements: 8.2_

- [x] 2. MongoDB connection and index provisioning — **done. `mongodb` unit + real-container integration tests green; `npm test` 522 pass / 6 skip; tsc + eslint clean.**
  - [x] 2.1 Added `mongodb: ^6.21.0` (not `^7` — that needs Node ≥ 20.19; project runs on Node 18. Revisit if the runtime moves up.)
  - [x] 2.2 `createDatabaseClient({ uri, logger? })` in `backend/src/db/client.ts` (async)
    - Disabled sentinel for unset/blank URI (silent) and for any startup failure (one credential-stripped log line via `redactMongoUri`). `new MongoClient(...)` is inside the try — a malformed URI throws there, not on `connect()`.
    - `db()` on a disabled handle throws a "check `enabled`" error; the composition root (task 6) branches on `enabled` to build the no-op stores.
    - `maxPoolSize: 20`, `serverSelectionTimeoutMS: 8_000`. TLS/SCRAM left to the SRV string (so a plain-`mongodb://` integration target works). `ensureIndexes` exported for the integration test.
    - Collection names in import-free `backend/src/db/collections.ts` so pure in-memory tests don't load the driver.
    - `client.test.ts` (6): redaction; unset ⇒ disabled+silent; blank ⇒ disabled; malformed ⇒ disabled + 1 log; no credential leak.
    - _Requirements: 1.1-1.5, 1.7, 6.2_
  - [x] 2.3 `MongoRankHistoryStore` (in `rankHistoryStore.ts`), `MongoLookedUpPlayerStore` (in `lookedUpPlayerStore.ts`), each from a `Db`
    - `record`: `updateOne(dedupKey, { $setOnInsert: doc }, { upsert: true })`; a concurrent-race `E11000` is swallowed (`isDuplicateKeyError`), anything else rethrows
    - `history`: `find().sort({ observedAt: 1 })`, `Date.getTime()` at the boundary
    - `remember`: `_id` **is** the puuid; `$set` mutable fields + `gameNameLower`; `upsert: true`
    - `searchByNamePrefix`: `{ gameNameLower: { $regex: '^' + escapeRegExp(prefix) } }`, `.sort({ lastLookedUpAt: -1 }).limit(...)`; blank prefix / non-positive limit ⇒ `[]`
    - `deleteByPuuid`: `deleteMany` / `deleteOne` ⇒ `deletedCount ?? 0`
    - _Requirements: 2.1-2.5, 3.1-3.5, 5.1, 6.2, 6.3_
  - [x] 2.4 `backend/src/db/mongo.integration.test.ts` — `describe.skipIf(!MONGODB_TEST_URI)`, 6 tests, unique per-run db name, `dropDatabase()` teardown
    - **Verified green against a real `mongo:7` container**: unique-index dedup, UTC-day rollover ordering, both `deleteByPuuid`, upsert-not-fork, regex-metacharacter-literal prefix scan
    - _Requirements: 8.3_

- [ ] 3. Surface `leaguePoints` on the ranked standing (upstream, additive)
  - [x] 3.1 **Approved by the user 2026-08-28.** `leaguePoints: number` added to `RankedQueueSummary` in `backend/src/insight/stats.ts`, set from `entry.leaguePoints` in `rankedByQueueOf`; frontend mirror `frontend/src/api/types.ts` matched. Fixtures fixed in `stats.test.ts`, `api/lookup.test.ts`, `orchestrator/index.test.ts` + `.property.test.ts`, `endToEnd.test.ts`, `ProfileReportView.test.tsx`, `pages.test.tsx`. No UI change. **Live-verified**: a real lookup of a ranked player returns `leaguePoints` in the payload.
    - _Requirements: 2.3; design.md Open Question 1 (resolved: yes)_

- [x] 4. Wire the write hooks into the lookup orchestrator
  - [x] 4.1 `rankHistoryStore` / `lookedUpPlayerStore` optional on `LookupOrchestratorOptions`, stored on the instance with `?? createNoop…()` defaults (landed with 4.2 so the fields are read).
    - _Requirements: 2.6, 3.6, 4.3_
  - [x] 4.2 `recordLookupSideEffects(report)` added, called **unawaited** from the single fresh `assembleReport` success in `runPipeline` (not the `failures.length > 0` fallback branch, not `runLookup`'s budget-expiry branch)
    - `void Promise.allSettled([...]).then(log rejections)` via new `LookupLogger.storeWriteFailed` (default `console.warn`)
    - New `SOLO_QUEUE_TYPE = 'RANKED_SOLO_5x5'` constant. Records a snapshot only when that standing is present and not `'Unranked'`; always calls `remember`. `this.now()` used once.
    - **Each store call wrapped in a `guard()`** that converts a *synchronous* throw into a rejected promise — a store method that throws (not just rejects) must not escape onto the request path (Requirement 4.2). Found + fixed via the throwing-store test.
    - _Requirements: 2.1, 2.4, 3.1, 3.2, 4.1, 4.2, 4.5_
  - [x] 4.3 `orchestrator/index.test.ts` +7 tests (49 total, green): solo standing ⇒ both stores called with mapped `tier/division/leaguePoints/observedAt`; unranked ⇒ `remember` only; `not_found` / `error` / Requirement-11.3 stale-cache fallback (seeded stale snapshot, aged clock, failed league refresh) ⇒ neither store; throwing stores (reject *and* sync-throw) ⇒ lookup still succeeds, `storeWriteFailed` logged, `unhandledRejection` listener stays empty; a store that never resolves ⇒ `runLookup` returns without waiting.
    - _Requirements: 3.4, 4.1, 4.2, 4.4_

- [x] 5. Extend privacy deletion to the Persistent_Store
  - [x] 5.1 `POST /api/privacy/delete` (in `backend/src/api/privacy.ts`, not `app.ts`) now runs `cache.deleteByPuuid` + `rankHistoryStore.deleteByPuuid` + `lookedUpPlayerStore.deleteByPuuid` in `Promise.all`, the two store calls each `.catch(() => 0)`
    - `found` = removal from **any** store. **No `persistentRowsRemoved` field** — that contradicts privacy.ts decision 1 (don't tell an unauthenticated caller how much data we hold). Requirement 5.4 is met by folding into the boolean `found`. Recorded as new decision 4 in privacy.ts; **requirements.md 5.4 + design.md updated to match.**
    - Stores are optional on `ApiDependencies` + `PrivacyRouteDependencies`, defaulting to the no-op stores (existing API tests untouched).
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x] 5.2 `privacy.test.ts` +4 tests (17 total, green): both collections cleared + `found: true` with an empty cache; a throwing `rankHistoryStore` ⇒ still 200, `found: true`, no defect logged, cache + player half still done; nothing anywhere ⇒ `found: false` 200; body still exactly `{ found, deletedAt }`
    - _Requirements: 5.2, 5.3_

- [x] 6. Composition root
  - [x] 6.1 `backend/src/index.ts` rewritten as `async function main()` (CommonJS ⇒ no top-level await) with a `.catch` that logs + exits 1
    - `await createDatabaseClient({ uri: config.mongodbUri })`; `enabled` ⇒ `new MongoRankHistoryStore/MongoLookedUpPlayerStore(client.db())`, else the no-op stores
    - Both stores passed into `createLookupOrchestrator` (accepted, inert until 4.2) and `createApp` (privacy route uses them now)
    - `SIGTERM`/`SIGINT` ⇒ `server.close()` then `databaseClient.close()` then exit (Requirement 1.6)
    - `mongodbUri?: string` added to `AppConfig` + `loadConfig` (trimmed, optional, blank ⇒ undefined, no shape validation)
    - **Smoke-tested live**: with the Atlas URI in `.env` the server logs "Persistent store connected", `/health` 200s, `POST /api/privacy/delete` hits Mongo and returns `{ found: false, deletedAt }`. With a bad URI it logs the disabled-fallback line and still starts + serves.
    - _Requirements: 1.1, 1.2, 1.6, 7.2_
  - [x] 6.2 `config/index.test.ts` +2 tests: `MONGODB_URI` set ⇒ trimmed; unset/blank ⇒ `undefined`. Full backend suite 528 passing / 6 skipped, tsc + eslint clean.
    - _Requirements: 7.2, 8.4_

- [x] 7. Documentation
  - [x] 7.1 README: `MONGODB_URI` row added to the backend env table; new **## Database** section (the two collections, what's written when, fire-and-forget guarantee, Redis-absent rationale, one-time Atlas M0 setup steps); `/api/privacy/delete` API entry updated. Also corrected two now-stale notes: the Getting-started section (`.env` *is* loaded via `dotenv`) and the "no `.env` loading" Known gap (now "`npm run dev` is broken").
    - _Requirements: 7.1, 7.5_
  - [x] 7.2 README "Known gaps": DB deletion isn't durable, no M0 backups, `0.0.0.0/0` allow-list, autocomplete endpoint shares the unauthenticated posture; Redis-absent stated in the Database section.
    - _Requirements: 6.5, 7.4_
  - [x] 7.3 `backend/.env.example`: `MONGODB_URI` block added — commented-out, placeholder SRV string, points at the README Database section.
    - _Requirements: 7.3_

- [x] 8. Full verification
  - [x] 8.1 `npm test`: backend **535 pass / 6 skip**, frontend **370 pass**. tsc (both) + eslint clean. Suite is green with no `MONGODB_URI`.
  - [x] 8.2 **Live against the real Atlas M0 cluster:**
    - Lookup of `Thebausffs#COOL` (Master I) ⇒ exactly one `rank_snapshots` doc: `RANKED_SOLO_5x5`, `tier: MASTER`, `division: I`, `leaguePoints: 1182`, `snapshotDay: "2026-08-28"`, correct `observedAt`. The player's FLEX + PREMADE entries were **not** recorded (solo-only, Requirement 2.1).
    - `looked_up_players` upserted on every successful lookup (incl. ones that returned unranked).
    - `POST /api/privacy/delete` with that PUUID ⇒ `{ found: true }`, snapshot gone, one `looked_up_players` row removed.
    - Startup log `Persistent store connected`; the 3 indexes auto-created on the fresh cluster.
    - Dedup / UTC-day rollover / regex prefix scan proven by the `mongo:7`-container integration tests (task 2.4) rather than re-proven against Atlas.
    - **All test data cleared from the cluster afterward; indexes left intact.**
  - [x] 8.3 Bad/blank `MONGODB_URI` ⇒ server logs the one-line disabled-fallback message and still starts + serves `/health` and `/api/*`; no store error on an unset URI (unit-covered by `client.test.ts` + `config` tests).
  - _Requirements: 8.4, live 1.3 / 1.4 / 2.1 / 3.1 / 5.1_

## Optional (skipped by default)

- [ ] * 9.1 Property test for `RankHistoryStore` dedup: any interleaving of `record` calls across a set of days yields exactly one entry per distinct `(puuid, queueType, day)`, and `history` is always sorted
- [ ] * 9.2 Property test for `searchByNamePrefix`: for random player sets and prefixes, every returned row's `gameNameLower` starts with the prefix, results are `lastLookedUpAt`-descending, and length ≤ `limit`
- [ ] * 9.3 Implement the pruning sweep (retain most-recent 60 per `(puuid, queueType)`) as a capped delete after insert in `MongoRankHistoryStore.record`

## Addendum (2026-09-02): games-based snapshot cadence (Requirement 2.2 revision)

- [x] 10. Replace the one-per-UTC-day dedup with a games-since-last rule
  - [x] 10.1 `RankSnapshot` gains `gamesPlayed` (League-V4 `wins + losses`). New exported `MIN_GAMES_BETWEEN_SNAPSHOTS = 3` and pure `shouldRecordSnapshot(previous, next)` (records when: no prior, tier/division change, lower count, or ≥3-game delta). `snapshotDayOf` / `dedupKey` removed.
  - [x] 10.2 `InMemoryRankHistoryStore` now keeps a per-`(puuid, queueType)` append-only list and consults the last entry via `shouldRecordSnapshot`. `MongoRankHistoryStore.record` is a `findOne(sort observedAt:-1)` + conditional `insertOne` — no unique index. `ensureIndexes` drops `uniq_puuid_queue_day` (best-effort) and keeps only `puuid_queue_observedAt`.
  - [x] 10.3 Orchestrator: `recordLookupSideEffects(report, soloGamesPlayed)` — count read from the league entries (`toLeagueEntries`), passed into the snapshot.
  - [x] 10.4 Frontend: `RankSnapshot` type + graph axis label ("recorded over time"), empty-state copy, aria-label updated. `specs/profile-sidebar/` Requirement 10.2/10.5 revised.
  - [x] 10.5 Tests: `shouldRecordSnapshot` table + `InMemoryRankHistoryStore` keep/skip cases; `mongo.integration.test.ts` rewritten to games-based; orchestrator snapshot-shape assertion gains `gamesPlayed`. Full backend (811 pass) + frontend (551 pass) suites green, tsc + eslint clean both sides.
    - _Requirements: 2.2 (revised), 2.3, 6.1, 6.2, 6.3_
