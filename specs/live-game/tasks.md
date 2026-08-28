# Implementation Plan: live-game

## Overview

This plan builds the Live Game feature bottom-up, matching how the existing codebase is layered: pure components first and property-tested in isolation, then the I/O components that consume them, then orchestration, then the API layer, then the UI. The Lobby Insight Engine and the Game_Clock derivation are pure and land before anything that calls them; the Participant Enricher and the Live Game Orchestrator are the integration points.

Three things shape the ordering. The feature depends on automatic platform resolution from the `lookup-pipeline-fixes` spec — a live game request takes a Riot ID and no region — so that spec's Region_Resolver must land first. The Static_Data_Provider is a hard prerequisite for rendering rather than a polish item: without it the lobby displays numeric champion IDs, so it is built in the first wave alongside the pure logic. And the cache work comes before the orchestrator, because the 30-second active-game TTL and the rule that negative results are never cached are both properties of `cacheOrFetch` usage rather than of the orchestrator, and testing them afterwards would mean testing them through two layers.

## Tasks

- [~] 1. Build the pure components and static data — **non-optional subtasks 1.1, 1.3, 1.5 done (2026-08-28)**; 1.2 + 1.4 are optional property tests, deferred. Backend 641 pass / 12 skip, frontend 459 pass, tsc + eslint clean both.
  - [x] 1.1 Implement the Lobby Insight Engine
    - `backend/src/liveGame/lobbyInsights.ts` — pure `computeLobbyInsights(lobby)` + `OFF_CHAMPION_MASTERY_THRESHOLD = 10_000` / `ONE_TRICK_MASTERY_THRESHOLD = 200_000` constants. No client, no clock, no I/O.
    - `backend/src/liveGame/types.ts` — the design.md data models (`CurrentGameInfo`/`CurrentGameParticipant`, `ParticipantCard`, `LiveGameLobby`, `LobbyInsights`), `RANKED_TIERS` + `rankedTierOrdinal`, and `RANKED_LEAGUE_QUEUE_TYPE_BY_QUEUE_ID` (420→`RANKED_SOLO_5x5`, 440→`RANKED_FLEX_SR`).
    - **Deviation from design's `ParticipantCard.rankedEntries: readonly RankedQueueStanding[]`:** used `readonly LeagueEntry[] | null` instead — `RankedQueueStanding`/`RankedQueueSummary` carry no `queueType`, so an array of them cannot satisfy Requirement 3.4's "ranked entry in the game's queue". `LeagueEntry` (reused from `insight/stats.ts`) carries `queueType`. Flag for the enricher (task 4).
    - Rank spread counts *participants* with a ranked entry in the game's queue; `null` below two, and `null` for any non-ranked `queueId`.
    - `lobbyInsights.test.ts` — 10 example tests (threshold boundaries, failed-enrichment gating, spread queue-filtering + <2 rule + non-ranked queue, purity). Property test 1.2 left for later (optional/`*`).
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 1.2 Write property test for lobby insights
    - **Property 4: Lobby insights are pure and match their defined conditions exactly**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**
    - Bias the mastery arbitraries toward the thresholds and pin both boundaries and their off-by-one neighbours with `fc.assert`'s `examples`, so the test cannot pass without exercising them

  - [x] 1.3 Implement the Game_Clock derivation
    - `frontend/src/domain/gameClock.ts` — pure `elapsedMs(gameStartTime, now)` (`max(0, …)`, 0 for Pre_Game or non-finite `now`), `isPreGame` (null/undefined/≤0/non-finite), `formatGameClock` (`M:SS` / `H:MM:SS`, never negative). `gameClock.test.ts` — 8 tests. Property test 1.4 left for later (optional/`*`).
    - _Requirements: 4.1, 4.2, 4.4_

  - [ ]* 1.4 Write property test for the game clock
    - **Property 3: Game clock is derived and never negative**
    - **Validates: Requirements 4.1, 4.2, 4.4**

  - [x] 1.5 Extend the Static Data Provider
    - `frontend/src/staticData/provider.ts` — new `StaticDataIndex.championsById` (numeric id string → Champion_Key), built in `buildStaticDataIndex` from `champion.json`'s `key` field (`/^\d+$/` guarded); new `championKeyForId(championId): string | null` accessor, gated on `usable`, prototype-safe (`hasOwnProperty`), total.
    - **Summoner-spell + rune name/icon resolution was already shipped by `match-detail-tabs`** (design.md: "whichever feature is implemented first provides them"). `summonerSpellDisplayName`/`IconUrl`, `runeDisplayName`/`IconUrl`, `runeTreeDisplayName`/`IconUrl`, `statShard*` all present. Not reimplemented.
    - `frontend/src/staticData/cache.ts` — `STORAGE_KEY` v6→v7, `isWellShapedIndex` now checks `championsById` (older entries would serve "ready" while every live-game champion renders as its numeric id for 24h).
    - Version pinning / 24h retention / Rate_Limit_Manager exclusion all inherited unchanged.
    - `provider.test.ts` — new `championKeyForId` block (4 tests: resolve, unknown/pre-load/hostile, prototype keys); 3 index literals + `cache.test.ts` fixtures updated for the new field.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [~] 2. Extend the Riot API Client and Cache Store — **2.1 + 2.2 done (2026-08-28)**; 2.3 is the optional (`*`) property test, deferred. Backend 646 pass / 12 skip, tsc + eslint clean.
  - [x] 2.1 Add the three new client methods
    - `backend/src/riotApiClient/index.ts` — `getActiveGameByPuuid(platform, puuid)` → `RiotApiResult<CurrentGameInfo>` (imports the domain type from `liveGame/types.ts`), `getAccountByPuuid(region, puuid)` → `RiotApiResult<AccountDto>`, `getChampionMastery(platform, puuid, championId)` → `RiotApiResult<ChampionMasteryDto>` (new DTO, `championId`/`championLevel`/`championPoints`). All route through the existing `send()` — rate-limit reservation, 10s timeout, 429 retry, `RiotApiResult` mapping — for free. New `RIOT_METHODS`: `spectator`, `accountByPuuid`, `championMastery`.
    - URLs: `/lol/spectator/v5/active-games/by-summoner/{puuid}` (platform), `/riot/account/v1/accounts/by-puuid/{puuid}` (regional), `/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/by-champion/{id}` (platform).
    - `index.test.ts` — 3 URL tests, extended method-id test, Spectator-V5 404→`not_found` test. Fake `RiotApiClient`s in `regionResolver/index.test.ts`, `orchestrator/index.test.ts`, `orchestrator/index.property.test.ts` gained the 3 no-op methods.
    - _Requirements: 1.1, 1.4, 2.1, 2.2, 2.3_

  - [x] 2.2 Add the `activeGame` and `championMastery` cache entry types
    - `backend/src/cache/index.ts` — `CacheEndpoint` union + `TTL_BY_ENDPOINT` gain `activeGame` (30s) and `championMastery` (1h). No key-shape enforcement needed (params are free-form `Record<string,string>`); callers key `activeGame` `{puuid, platform}` and `championMastery` `{puuid, platform, championId}`.
    - `deleteByPuuid` already scans keys **and** values recursively, so both new types — including a subject appearing as a *participant* inside another player's cached `activeGame` (Requirement 6.6) — are evicted with no code change; they count toward `removedEntryCount`. Covered by a new `index.test.ts` example (property test 2.3 deferred). `account`/`league` retentions untouched (Requirement 6.3).
    - `TTL_BY_ENDPOINT` literals + `ENDPOINTS` lists in `cache/index.{test,property.test}.ts` and `cacheOrFetch.property.test.ts` updated.
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 2.3 Write property test for deletion coverage of the new entry types
    - **Property 5: Deletion removes the subject from every cached lobby**
    - **Validates: Requirements 6.5, 6.6**
    - Generate cache states in which the PUUID appears as the keyed player, as a participant inside another player's cached lobby, and both

- [x] 3. Checkpoint - Ensure all tests pass
  - 2026-08-28: backend 646 pass / 12 skip, tsc + eslint clean. (Mongo integration tests unaffected — no DB code touched.) Frontend untouched since task 1 (459 pass).

- [~] 4. Implement the Participant Enricher — **4.1 done (2026-08-28)**; 4.2 is the optional (`*`) property test, deferred.
  - [x] 4.1 Implement `enrichAll`
    - `backend/src/liveGame/enricher.ts` — `createParticipantEnricher(client)` → `{ enrichAll(platform, region, participants) }`. Per non-bot participant, `Promise.all` of three `enrich(...)`-wrapped calls (`getAccountByPuuid` / `getLeagueEntriesByPuuid` / `getChampionMastery`). One card per participant in input order; `Promise.all` over the participants never rejects because every leaf is `enrich`-wrapped.
    - **`enrich` extracted to `backend/src/orchestrator/enrich.ts`** (was a private fn in `orchestrator/index.ts`) and re-imported there — one definition of "this call's failure is not an error", per design. Reuses `toLeagueEntries` from `orchestrator/mapping.ts` for the `LeagueEntryDto[]` → `LeagueEntry[]` (`rank`→`division`) map.
    - **Amended for Requirement 6.3/6.4 (2026-08-28):** the enricher now takes `{ client, cache, now }` and each call goes through `cacheOrFetch` against its own endpoint retention (`account` 1h / `league` 10min / `championMastery` 1h — **not** the 30s active-game TTL) via a local `readOrNull` (cacheOrFetch + discard failure → null, so the no-failure-mode contract holds). This is the sole consumer of the `championMastery` cache type from task 2.2. Following a game no longer re-fetches ten ranks every poll.
    - Bot → `baseCard` with every joined field `null`, `isBot: true`, no call issued (Req 2.5). League `[]` → `rankedEntries: []` (unranked, Req 2.6); League failure → `null`.
    - **Consequence flagged:** `enrich` collapses Champion-Mastery `not_found` (player never played the champion) to `championMasteryPoints: null`, same as a failed call — so the Lobby Insight Engine does NOT flag a never-played lock as off-champion. This matches Requirement 3.2's literal "AND at least one … mastery record exists", but if the user wants never-played flagged that's a spec change (would need mastery `not_found`→0, bypassing `enrich` for that one call).
    - `enricher.test.ts` — 6 example tests (order, full join, bot no-calls, field-level degradation, unranked-vs-failed, all-fail never rejects). Property test 4.2 deferred.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 4.2 Write property test for enrichment isolation
    - **Property 2: Enrichment failure degrades a field, never a card or a lobby**
    - **Validates: Requirements 2.4, 2.5, 2.6**

- [~] 5. Implement the Live Game Orchestrator — **5.1 done (2026-08-28)**; 5.2 is the optional (`*`) property test, deferred.
  - [x] 5.1 Implement `getLiveGame`
    - `backend/src/liveGame/orchestrator.ts` — `createLiveGameOrchestrator({ client, cache, now?, discoveryRegion?, regionResolver?, enricher? })` → `{ getLiveGame(riotId) }` returning `LiveGameResult` (`in_game` | `not_in_game` | `error`).
    - Pipeline: Account-V1 by-riot-id via `cacheOrFetch` (shares the `account` cache entry with the profile lookup) → puuid → `regionResolver.resolve(puuid)` (Requirement 1.5, no region asked) → `cacheOrFetch<CurrentGameInfo>` on the `activeGame` 30s entry → `enrichAll` → build lobby → `computeLobbyInsights`.
    - `not_found` from Spectator-V5 → `{ kind: 'not_in_game' }`; **not cached** — `cacheOrFetch` only writes on `ok`, verified by a test that a 2nd call re-queries Riot.
    - `matchId` = `` `${platformId}_${gameId}` `` (Requirement 5.3, no extra call). `gameStartTime` 0/absent → `null` (Pre_Game). `bannedChampionIds` drops Riot's `-1` (no ban).
    - Errors: `failureToError` mirrors `orchestrator/index.ts`'s `errorFor` (non-matchIds stage); account `not_found` → `PLAYER_NOT_FOUND`; resolver variants → `NO_LOL_ACCOUNT` / `UNSUPPORTED_PLATFORM` / `failureToError`. **No new `ErrorCode`.**
    - **Flag for task 7:** design's `LiveGameResult` error variant is `{ code, retriable }` with no `platform` field, but `errors.ts`'s `unsupportedPlatformError(platform)` needs the string. Task 7 must either extend the variant or have the route not echo the platform for live-game.
    - `orchestrator.test.ts` — 7 example tests (assembly + matchId + bans + insights, Pre_Game, not_in_game + no-negative-cache, 30s cache hit, PLAYER_NOT_FOUND, NO_LOL_ACCOUNT, server_error/timeout mapping). Property test 5.2 deferred.
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 5.3, 6.2_

  - [ ]* 5.2 Write property test for the not-in-game state
    - **Property 1: Not-in-game is a state and never an error**
    - **Validates: Requirements 1.2, 6.2**

- [x] 6. Checkpoint - Ensure all tests pass
  - 2026-08-28: backend 660 pass / 12 skip, tsc + eslint clean. Frontend untouched (459).

- [~] 7. Implement the API layer — **7.1 done (2026-08-28)**; 7.2 (starred) got a working subset done anyway.
  - [x] 7.1 Implement `GET /api/live-game`
    - `backend/src/api/liveGame.ts` — `createLiveGameHandler({ liveGameOrchestrator })`. `gameName`/`tagLine` query params (reuses `readQueryString` from `buildPath.ts`), recombined into `gameName#tagLine` and run through `validateRiotId` (same rules as `/api/lookup`). `200` for both `in_game` and `not_in_game`. Errors: `PLAYER_NOT_FOUND`→`playerNotFoundError`, `NO_LOL_ACCOUNT`→`noLolAccountError`, `UNSUPPORTED_PLATFORM`→`unsupportedPlatformError(result.platform)`, else `apiErrorFor` (+ `Retry-After: 5` for `RATE_LIMITED`). No new error code.
    - **`LiveGameResult` error variant extended** with an optional `platform?: string` (set only for `UNSUPPORTED_PLATFORM`) — resolves the task-5 flag; `errors.ts` needed the platform string and design's variant omitted it.
    - Wired: `liveGameOrchestrator` added to `ApiDependencies` (**required**, like `buildPathOrchestrator`); route registered in `createApiRouter`; handler + types re-exported from `api/index.ts`; composition root (`src/index.ts`) builds `createLiveGameOrchestrator({ client: riotApiClient, cache, now })`. 8 fake-`ApiDependencies` test sites updated with a `stubLiveGameOrchestrator`.
    - _Requirements: 1.2, 1.3, 1.5_

  - [x]* 7.2 Route outcome tests — `api/liveGame.test.ts`, 8 supertest cases (in_game 200, not_in_game 200, missing param 400, validation 400, PLAYER_NOT_FOUND 404 echoing the id, UNSUPPORTED_PLATFORM naming the platform, RATE_LIMITED 429 + Retry-After, RIOT_UNAVAILABLE 503).
    - Cover `in_game`, `not_in_game`, a validation rejection, and each retriable Riot failure class
    - _Requirements: 1.2, 1.3, 1.4_

- [~] 8. Implement the frontend — **8.1–8.5 done (2026-08-28)**; 8.6 (starred) got a substantial suite done anyway. Frontend 484 pass, tsc + eslint + vite build clean.
  - Wire: `api/types.ts` mirrors (`LiveGameLobby`/`LiveParticipantCard`/`LobbyInsights`/`LiveGameResponse`), `api/lookupClient.ts` `fetchLiveGame` + `readLiveGameResponse` (never rejects, `not_in_game` is a normal outcome), route `/live` in `App.tsx`.
  - [x] 8.1 `components/LiveGameView.tsx` + `components/ParticipantCard.tsx` + `domain/liveGame.ts` (pure: `queueLabel`, `rankedEntryForGame`, `formatRank`, `formatMasteryPoints`, `formatRankSpread`, `titleCaseTier`). Cards: `ChampionIcon` via `championKeyForId(id) ?? String(id)` (task 1.5), two `SummonerSpellIcon`, keystone `RuneIcon` (`perkIds[0]`). Bot → `live-card--bot` + "Bot", no rank/mastery, no call. Unranked (`rankedEntries: []`) shows "Unranked"; failed (`rankedEntries: null`) shows nothing. **Deviation:** only the keystone rune is shown, not the full rune page — the backend `ParticipantCard` carries only `perkIds` (design's shape), not `perkStyle`/`perkSubStyle`.
  - [x] 8.2 Off-champ / one-trick chips on `ParticipantCard` driven by `insights.offChampion`/`oneTricks`; rank spread on `LiveGameView` header, omitted when `null`. WR/flags stay gold, never green/red ([[design-system]]).
  - [x] 8.3 `components/GameClock.tsx` — self-ticking `setInterval(1s)`, no request (Req 4.3); `isPreGame` → "In champion select" (Req 4.2); `formatGameClock` clamps (Req 4.4). Uses `domain/gameClock.ts` from task 1.3.
  - [x] 8.4 `hooks/useLiveGame.ts` — first fetch on mount, poll via injected `schedule` (default `setInterval`, `POLL_INTERVAL_MS = 30_000`, Req 5.1), interval cleared on unmount / Riot-ID change (Req 5.5). Game-ended: a shown lobby → later `not_in_game` = `ended` status, last lobby kept (Req 5.2). A failed poll keeps the on-screen lobby. **Deviation:** the game-ended state links to `/profile?riotId=…` (Req 5.3 "link to the finished match") — this app has no standalone match page; the match surfaces in the profile's Recent Matches. The "results not yet available" copy (Req 5.4) is a static line under the link rather than a Match-V5-404-driven state.
  - [x] 8.5 `pages/LiveGamePage.tsx` wraps everything in `RiotDataPage title="Live game"` — attribution + no-ad default inherited. Only the Riot ID is shown per participant (Req 8.3).
  - [x]* 8.6 Tests: `hooks/useLiveGame.test.tsx` (8: mount, poll, game-ended, not_in_game, failed-poll-keeps-lobby, unmount stops, idle), `components/LiveGameView.test.tsx` (6: teams, Pre-Game, spread omit/show, bot, unranked-vs-failed, flags), `pages/LiveGamePage.test.tsx` (5: prompt + attribution + no ad slot, in_game, not_in_game, error+retry), `domain/liveGame.test.ts` (8), `domain/gameClock.test.ts` (8, from task 1). Not done: static-data-fallback assertion, Match-V5-404 message (no such state built).
  - **Follow-up (not in spec):** no nav link to `/live` anywhere in the UI — reachable by URL only. The masthead is just the wordmark.

- [x] 9. Checkpoint - Ensure all tests pass
  - 2026-08-28: backend 668 pass / 12 skip, frontend 484 pass, tsc + eslint clean both, vite build clean.

- [x] 10. Integration
  - [x]* 10.1 Integration test for a mixed lobby — `backend/src/liveGame/integration.test.ts`. Real stack from `createApiRouter` down (route + orchestrator + Region Resolver + Participant Enricher + Insight Engine + cache + rate limiter + Riot client) over a canned transport. 10-participant lobby: 1 bot, 1 unranked (`[]`), 1 League-V4 500 (`null`), 1 one-trick (250k mastery), 1 off-champion (5k mastery + SILVER). Asserts `200`, `matchId = NA1_987654`, bans drop `-1`, ten cards in Spectator order, `oneTricks: ['p4']`, `offChampion: ['p5']`, `rankSpread: { highest: 'DIAMOND', lowest: 'SILVER' }`.
  - [x] 10.2 README updated: new `### GET /api/live-game` section (request, both 200 bodies, enrichment/bot/poll notes); Spectator-V5 + Champion-Mastery-V4 added to the Riot APIs line and architecture diagram; two Caching-table rows (`activeGame` 30s + never-cache-not_found note, `championMastery` 1h + enrichment-reuse note). Stale test-file counts refreshed.

### Post-ship fixes (2026-08-28)
- **`puuid: null` participants** — Spectator-V5 occasionally returns a real player it will not identify (verified live against `Chespin#Spike`'s lobby: participant 1 had `puuid: null`, all-null enrichment). This made the frontend's `readLiveGameResponse` reject the whole 200 response → `RIOT_UNAVAILABLE`. Fix: `enricher.ts` `baseCard` normalises a non-string puuid to `''` and skips enrichment for it; `LiveGameView` key falls back to `${teamId}-${championId}-${index}` when puuid is blank. Tests added: `enricher.test.ts` (missing-puuid), `lookupClient.test.ts` (`readLiveGameResponse` block).
- **"Live game" tab on the profile report** — `LiveGamePanel.tsx` + a `queue-tabs` tablist on the Recent matches section (`main-tab-recent` / `main-tab-live`). Polling runs only while the Live game tab is mounted. The standalone `/live` route still exists.

- [x] 11. Final checkpoint - Ensure all tests pass
  - 2026-08-28: backend 669 pass / 12 skip (52 files), frontend 484 pass (41 files), tsc + eslint clean both, vite build clean. Mongo integration tests skip without `MONGODB_TEST_URI` (no DB code touched by this feature). **`specs/live-game/` complete** except the optional (`*`) property tests 1.2 / 1.4 / 2.3 / 4.2 / 5.2, which the plan says the agent skips by default.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster delivery; they are not implemented by the coding agent by default.
- **This feature depends on the `lookup-pipeline-fixes` spec.** Task 5.1 uses the Region_Resolver and task 4.1 uses the `enrich<T>()` helper, both introduced there. Do not start wave 3 before that spec's task 4.3 has landed.
- **This feature also depends on the `visual-assets` spec**, which defines the Static_Data_Provider, its pinned version and its retention. Task 1.5 extends that provider; it does not create one.
- Task 1.5 is not polish. Spectator-V5 returns numeric champion identifiers, so without the reverse index the lobby renders as a grid of numbers. It is a prerequisite for task 8.1, not a follow-up to it.
- **Negative results must never be cached** (task 5.1). Caching a `not_found` for 30 seconds would delay the detection of a game starting by up to a full TTL, which defeats the point of a live feature. This is asserted by Property 1 rather than left to review.
- Property tests use `fast-check` with a minimum of 100 runs each, tagged `// Feature: live-game, Property {n}: {property text}`.
- Property 4's generators must be biased toward the mastery thresholds and pin the boundaries with `examples`. A uniform generator over a large integer range would almost never produce a value near 10,000 or 200,000, and the test would pass without ever exercising the conditions it exists to check. Several of the existing property tests in `backend/src/` carry exactly this weakness — a bare `expect(count).toBeGreaterThan(0)` coverage guard with no pinned `examples` — so do not copy that pattern here.
- The enrichment fan-out is 30 calls per cold lobby against endpoints granted 20,000 requests per 10 seconds, so it consumes roughly 0.15% of the available budget. Do not add batching, sampling or deferral; there is no constraint to relieve and the complexity would be speculative.
- Recent-form enrichment per participant (match history for all ten players) is deliberately **out of scope**. It would cost up to 210 Match-V5 calls per lobby against a 2,000-per-10-seconds limit, and it is the one enrichment that would make the fan-out a real constraint. Revisit as its own spec if wanted.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.5", "2.1", "2.2"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.3", "4.1"] },
    { "id": 2, "tasks": ["4.2", "5.1"] },
    { "id": 3, "tasks": ["5.2", "7.1"] },
    { "id": 4, "tasks": ["7.2", "8.1", "8.3"] },
    { "id": 5, "tasks": ["8.2", "8.4", "8.5"] },
    { "id": 6, "tasks": ["8.6", "10.1"] },
    { "id": 7, "tasks": ["10.2"] }
  ]
}
```
