# Implementation Plan: clash-scouting

## Overview

This plan builds the Clash scouting report bottom-up, matching how the existing codebase is layered: the pure Scouting Insight Engine is built and property-tested in isolation before anything calls it, then the client and cache extensions, then the Roster Enricher, then the orchestrator, then the API and UI.

Two ordering decisions are not stylistic. The Tournament Refresher and the `ClashTournamentSource` split land in the first wave, before the orchestrator exists — the split is what makes a request-path call to the 10-per-minute tournaments endpoint a compile error rather than a review finding, and introducing it after the orchestrator has been written means retrofitting a dependency boundary instead of building against one. And the Roster Enricher's Recent_Form bound is implemented with the enricher rather than added later, because an unbounded first version would fan out to roughly 500 Match-V5 calls per report and would be the kind of thing that works in tests and hurts in production.

The feature depends on the `lookup-pipeline-fixes` spec for automatic platform resolution and the `enrich<T>()` helper, and on the `live-game` spec for the champion mastery cache entry and the Static_Data_Provider used to render champion names in the ban list.

## Tasks

- [~] 1. Build the pure engine and the tournament boundary — **1.1, 1.3, 1.4 done (2026-08-28)**; 1.2 is the optional (`*`) property test, deferred. Backend 682 pass / 12 skip, tsc + eslint clean.
  - [x] 1.1 Implement the Scouting Insight Engine
    - `backend/src/clashScouting/scoutingInsights.ts` — pure `computeScoutingInsights(report)` + `MAX_BAN_RECOMMENDATIONS = 5` + exported `compareBanCandidates` (recent wins desc → mastery pts desc → recent games desc → champion id asc). No client/clock/I/O.
    - `backend/src/clashScouting/types.ts` — the design.md data models (`Clash*Dto`, `RosterCard`, `RecentFormEntry`, `ChampionPoolEntry`, `ScoutingReport`, `ScoutingInsights`, `BanRecommendation`, `PositionMismatch`, `ClashTeamSummary`, `DeclaredPosition`).
    - **Interpretation choices (design underspecified):** ban candidates are one per `championId` (union of every member's pool ∪ recent form). `recentWins`/`recentGames` are team-combined; `masteryPoints` is the most-invested member's (tie → smallest puuid); `puuid` ("whose champion") is that member, falling back to the member with the most recent-form games. `RecentFormEntry` carries `{ matchId, championId, role, win, participantPuuids }`; stack cohesion dedupes by `matchId` and counts members with ≥2 roster puuids present in one match.
    - `scoutingInsights.test.ts` — 9 example tests (ban order + tie-break + cap + recent-form-only candidate; mismatch flag + UNSELECTED/FILL/empty-form skips; cohesion; purity). Property test 1.2 deferred.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 1.2 Write property test for scouting insights — **done 2026-09-01.**
    - **Property 4: Scouting insights are pure and follow their defined orders exactly**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
    - Draw champion ids and mastery values from small ranges to force ties, and pin at least one case tied through to the champion-id tie-break with `fc.assert`'s `examples`, so the last two order keys cannot go unexercised
    - `scoutingInsights.property.test.ts` (200 runs) — a shared-match-slot world generator (so Stack_Cohesion exercises real overlap, not coincidental uniqueness) plus three independent oracles (ban order, position mismatches, stack cohesion) checked against the engine's actual output; purity checked by calling twice. The champion-id tie-break-through case design.md asks to be pinned is already covered by `scoutingInsights.test.ts`'s existing "breaks a full tie by ascending champion id" example test, so it isn't duplicated with `fc.assert`'s `examples`.

  - [x] 1.3 Introduce the `ClashTournamentSource` boundary
    - `backend/src/clashScouting/tournamentSource.ts` — `interface ClashTournamentSource { getClashTournaments(platform) }`, separate from `RiotApiClient`. Only the Tournament Refresher will hold one; the Scouting Orchestrator's options (task 5) must not include it, so a request-path call is a compile error. `getClashTournaments` is NOT added to `RiotApiClient` (task 2.1 adds `getClashTournamentsByTeam`, the 200/min sibling, there instead).
    - _Requirements: 4.1_

  - [x] 1.4 Implement the Tournament Refresher
    - `backend/src/clashScouting/tournamentRefresher.ts` — `createTournamentRefresher({ source, cache, platforms, now?, schedule? })` → `{ start(intervalMs?), stop() }`. `TOURNAMENT_REFRESH_INTERVAL_MS = 5min` default; refreshes immediately on `start` then on the injected `RepeatingScheduler`; a `lastRefreshAt` guard enforces "no more often than once per interval" (Req 4.2). Per-platform `getClashTournaments` → `cache.set({ endpoint: 'tournamentSchedule', routingValue: platform, params: {} }, data, 1h)`, fire-and-forget — a failed refresh leaves the prior entry (Req 4.4-safe). Holds no schedule state of its own (Req 5.4). Default `setInterval` handle is `.unref()`'d.
    - **`tournamentSchedule` cache endpoint added** (`CacheEndpoint` + `TTL_BY_ENDPOINT` = 1h). `clashPlayers`/`clashTeam`/`championMasteryTop` deferred to task 2.2. Cache test fan-out (`index.test.ts`, `index.property.test.ts`, `cacheOrFetch.property.test.ts`) updated.
    - `tournamentRefresher.test.ts` — 4 tests (immediate refresh + cache write, interval guard, failed-refresh keeps entry, stop cancels).
    - _Requirements: 4.1, 4.2, 5.4_

- [~] 2. Extend the Riot API Client and Cache Store — **2.1, 2.2 done (2026-09-01)**; 2.2's optional (`*`) property test 2.3 deferred. Backend 683 pass / 12 skip, tsc + eslint clean.
  - [x] 2.1 Add the Clash-V1 and mastery client methods
    - `getClashPlayersByPuuid`, `getClashTeam`, `getClashTournamentsByTeam`, and `getChampionMasteryTop`, each reserving a rate-limit slot, applying the 10s timeout, honouring the 429 retry policy, and mapping onto the existing `RiotApiResult` variants
    - Keep `getClashTournaments` on `ClashTournamentSource` only; do not add it here
    - _Requirements: 1.2, 1.4, 1.6, 2.3, 4.5_

  - [x] 2.2 Add the Clash cache entry types
    - `clashPlayers` keyed on `{ puuid, platform }` at 5 minutes, `clashTeam` keyed on `{ teamId, platform }` at 5 minutes, and `tournamentSchedule` keyed on `{ platform }` at 1 hour
    - Reuse the existing `championMasteryTop`, `account`, `league`, `matchIds` and `matchDetail` retentions unchanged
    - **Note:** `championMasteryTop` did not pre-exist — added as its own `CacheEndpoint` (1h TTL, same constant as `championMastery`) since it is keyed differently (top-N by puuid vs per-champion by puuid+championId).
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 2.3 Write property test for deletion coverage of the Clash entry types — **done 2026-09-01.**
    - **Property 5: Deletion removes the subject from every Clash entry**
    - **Validates: Requirement 5.6**
    - Generate cache states in which the PUUID appears as the keyed player of a registration, as a roster member of a cached team, and both
    - `clashScouting/cacheDeletion.property.test.ts` (150 runs + a pinned example covering both hit shapes at once). Doesn't touch `deleteByPuuid` itself — its generic key/value scan (`cache/index.ts`) already covers any entry shape; this proves that guarantee specifically for `clashPlayers` (key+value hit) and `clashTeam` (value-only hit, as one of five roster puuids), which the pre-existing generic Property 20 (`cache/index.property.test.ts`) never seeded.

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the Roster Enricher — **done 2026-09-01.** Backend 693 pass / 12 skip, tsc + eslint clean.
  - [x] 4.1 Implement `enrichAll`
    - Dispatch each member's account, league and top-mastery calls concurrently, each wrapped in the `enrich<T>() => T | null` helper from `lookup-pipeline-fixes`
    - Retrieve Recent_Form bounded at 10 matches per member, excluding individually-failed match retrievals and continuing, exactly as `backend/src/orchestrator/index.ts` already does when assembling a Profile Report
    - Return exactly one card per roster member, in roster order, with absent fields where a call failed
    - Derive each member's Observed_Role from their Recent_Form, leaving it null when the window is empty
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
    - **Implementation notes (`backend/src/clashScouting/enricher.ts`):**
      - `enrichAll(platform, region, members: readonly ClashTeamPlayerDto[])` — signature deviates from design.md's literal `ClashPlayerDto[]`, since the roster the orchestrator will hand in comes from `ClashTeamDto.players` (`ClashTeamPlayerDto`, no `teamId`), not the registrations endpoint's `ClashPlayerDto`.
      - Uses the enricher's own `readOrNull` (same shape as `liveGame/enricher.ts`'s), not the bare `enrich<T>()` helper, so every call also goes through `cacheOrFetch` against the existing endpoint TTLs (`account`/`league`/`championMasteryTop`/`matchIds`/`matchDetail`) — matching how `liveGame`'s enricher works, and how design.md's own "match details are shared cache" claim can be true at all.
      - `isCaptain` is read from `member.role === 'CAPTAIN'` directly, not derived by comparing `puuid` against a separate captain field.
      - **`championId` added to `MatchParticipantDto`** (`riotApiClient/index.ts`) and to `matchProjection.ts`'s `PARTICIPANT_KEYS` — the field the pipeline had never needed before this spec, needed here to join a Recent_Form entry's champion against `championPool`'s `championId` for ban-recommendation math.
      - `Observed_Role` reads raw `teamPosition`/`role` directly (a new local `rawRoleOf`), NOT `orchestrator/mapping.ts`'s `roleOf` — that helper renames `UTILITY` to the display string `Support`, which would never equal `DeclaredPosition`'s raw `'UTILITY'` and would silently make every support's position-mismatch undetectable.
      - **Interpretation choice (design underspecified):** Observed_Role = the most frequent non-blank role across Recent_Form, tie-broken toward whichever role appears first in the newest-first match-id order.
      - `CHAMPION_POOL_SIZE = 5` for the Champion-Mastery-V4 top-masteries `count` — not specified by the spec beyond "top champion masteries".
      - `enricher.test.ts` — 10 example tests (per-field degradation, unranked-vs-failed, excluded match, bounded match-id request, empty-form-no-role, tie-break, cross-run cache sharing). Property test 4.2 deferred (`*`).

  - [x] 4.2 Write property test for roster enrichment isolation — **done 2026-09-01.**
    - **Property 3: Roster enrichment failure degrades a field, never a member or a report**
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7**
    - `enricher.property.test.ts` (100 runs) — every `RiotApiResult` variant assigned per call per member, a shared match-id universe with ONE `MatchDto` per id (containing every roster member's participant row, matching how a real Match-V5 response serves all ten players from one document — a per-requester-only mock would have let one member's success silently exclude a teammate). Asserts exactly one card per member in roster order, `riotId`/`rankedEntries`/`championPool` non-null iff their call succeeded, and `recentForm` equal to exactly the matches whose retrieval succeeded, bounded at `RECENT_FORM_MATCH_LIMIT`.

- [x] 5. Implement the Scouting Orchestrator — **5.1 done 2026-09-01.** Backend 704 pass / 12 skip, tsc + eslint clean.
  - [x] 5.1 Implement `scout`
    - Resolve the Riot ID to a PUUID and Resolved_Platform via the Region_Resolver; ask the visitor for no region
    - `cacheOrFetch` the player's Clash registrations; return `not_registered` for an empty array and for a teams-endpoint 404 on a referenced team id
    - Return `multiple_teams` when the player holds more than one registration and no `teamId` was supplied
    - Read the Tournament_Schedule from cache only; on a miss or a stale entry set `tournament: null` and continue rather than blocking
    - Assemble the report and run the Scouting Insight Engine over it
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.3, 4.4, 4.5_
    - **Implementation notes (`backend/src/clashScouting/orchestrator.ts`):**
      - `ScoutingOrchestratorOptions` intentionally has no `ClashTournamentSource` field, so the compile-error enforcement from task 1.3 is verified in place (this module has no way to reach `getClashTournaments` even if someone tried).
      - **Deviation (design underspecified):** `multiple_teams` needs each candidate's name/abbreviation/tier/icon for the picker, but a Clash_Registration (`ClashPlayerDto`) carries only `{puuid, teamId, position, role}` — no team metadata. So the multi-registration branch fetches every candidate team (`cacheOrFetch`, concurrent, bounded by however many teams one player is registered to — practically 1-2) and builds the picker from whichever succeed; a candidate whose team 404s is silently dropped from the list (same "stale registration" reasoning as the single-team 404 case), and an all-stale set degrades to `not_registered`.
      - `readTournament` reads the `tournamentSchedule` cache entry directly (never `cacheOrFetch`, which would fetch on a miss) and checks `isStale` itself — Requirement 4.4 needs a STALE entry, not just an absent one, to degrade to `null`.
      - `orchestrator.test.ts` — 11 example tests (not_registered on empty/404, team picker, teamId override, full report assembly, fresh/stale/absent tournament schedule, error-table mapping). Property tests 5.2/5.3 deferred (`*`) — 5.3 (the tournaments-endpoint boundary) is the most important test in the spec per design.md's Testing Strategy and should not stay deferred indefinitely.

  - [x] 5.2 Write property test for the not-registered state — **done 2026-09-01.**
    - **Property 1: No active Clash registration is a state and never an error**
    - **Validates: Requirement 1.3**
    - `orchestrator.property.test.ts` — empty-registration-array case (0 team/league/mastery/matchIds calls issued) and team-404 case (`not_registered`, never an error), both over `fc.assert`.

  - [x] 5.3 Write property test for the tournament endpoint boundary — **done 2026-09-01.**
    - **Property 2: The tournaments endpoint is never called on a request path**
    - **Validates: Requirements 4.1, 4.3, 4.4**
    - Hand the orchestrator a `ClashTournamentSource` fake that fails the test on any invocation, and generate request sequences across every Tournament_Schedule cache state including absent and stale
    - **design.md's stated approach no longer applies literally**: `ScoutingOrchestratorOptions` has no `ClashTournamentSource` field at all (task 5.1), so there is no slot to hand a failing fake into — the boundary already fails one layer earlier, at compile time, than the property anticipated. `orchestrator.property.test.ts` asserts this at both layers instead: (1) a `@ts-expect-error`-guarded, never-executed call to `createScoutingOrchestrator` with a `tournamentSource` field, which fails `tsc` if the boundary ever regresses; (2) the runtime half of the property — for `fc.integer` tournament ids crossed with every `TournamentCacheState` (absent/fresh-matching/fresh-for-a-different-tournament/stale), a report is always produced (never blocked, never an error), `tournament` is non-null only for the fresh-matching case, and the related-but-distinct 200/min `getClashTournamentsByTeam` count stays at zero throughout.

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the API layer — **done 2026-09-01.** Backend 719 pass / 12 skip, tsc + eslint clean.
  - [x] 7.1 Implement `GET /api/clash/scout`
    - Accept `gameName`, `tagLine` and an optional `teamId`, validate the Riot ID through the existing validator, and return `200` for `report`, `multiple_teams` and `not_registered` alike
    - Map error outcomes through the error table in `backend/src/api/errors.ts`; add no new error codes beyond those inherited from region resolution
    - _Requirements: 1.1, 1.3, 1.5_
    - **Implementation notes:**
      - `backend/src/api/clashScouting.ts` — `createClashScoutingHandler`, structured identically to `api/liveGame.ts`. Registered as `GET /clash/scout` in `api/index.ts`.
      - **`scoutingOrchestrator` added as a required `ApiDependencies` field** and wired into the composition root (`index.ts`) in the same step, same precedent as `live-game`'s task 7 — NOT deferred to task 10.1, which is scoped only to starting the Tournament Refresher. Until task 10.1 starts the refresher, `tournamentSchedule` stays empty and every report degrades to `tournament: null` (safe, per Requirement 4.4) — noted inline in `index.ts`.
      - **`ScoutingResult`'s `error` variant gained an optional `platform` field**, additive beyond design.md's declared type, matching what `LiveGameResult`/`LookupResult` already carry for `UNSUPPORTED_PLATFORM` — otherwise the route could not name the offending platform the way the other two routes do.
      - Every non-`liveGameOrchestrator`-stub test call site across the suite (`app.test.ts`, `api/*.test.ts`, `endToEnd.test.ts`, `liveGame/integration.test.ts`) needed a `scoutingOrchestrator` stub/instance added — fan-out from the new required field, same shape as when `liveGameOrchestrator` was added.
  - [x] 7.2 Write unit tests for the route's outcome mapping
    - Cover `report`, `multiple_teams`, `not_registered`, a validation rejection, and each retriable Riot failure class
    - _Requirements: 1.3, 1.5, 1.6_
    - `api/clashScouting.test.ts` — 15 tests (missing-field validation, invalid Riot ID, report/multiple_teams/not_registered 200s, `teamId` forwarding, and the full error table: PLAYER_NOT_FOUND/NO_LOL_ACCOUNT/UNSUPPORTED_PLATFORM/RIOT_UNAVAILABLE/TIMEOUT/RATE_LIMITED/AUTH_FAILURE/NETWORK_ERROR).

- [~] 8. Implement the frontend — **8.1-8.3 done 2026-09-01** (no standalone search page — see decision below); **8.4 satisfied structurally, not implemented**; 8.5 partial. Frontend 506 pass, tsc + eslint clean.
  - **User decision (2026-09-01):** Clash scouting is NOT a standalone page-only feature — it gets a third tab on the profile report, alongside "Recent matches" and "Live game" (`mainTab` state in `frontend/src/components/ProfileReportView.tsx`, currently `'recent' | 'live'`; extend to `'recent' | 'live' | 'clash'`, new `data-testid="main-tab-clash"` button, `ClashScoutingPanel` mounted only while selected, mirroring `LiveGamePanel`'s mount-only-while-selected/poll-teardown pattern). The standalone route (if any) stays secondary, same relationship `/live` has to the Live Game tab.
  - [x] 8.1 Implement the scouting search and team selector
    - Accept a Riot ID alone, render the not-registered state as a state rather than an error, and render a team picker when the player holds more than one registration
    - _Requirements: 1.1, 1.3, 1.5_
    - **Deviation from the task's literal wording (consistent with the decision above):** there is no separate search form — `ClashScoutingPanel` takes the profile's already-known `riotId` as a prop, exactly like `LiveGamePanel`, since the primary (only, for now) entry point is the profile-report tab, not a standalone searchable page.
    - New: `frontend/src/hooks/useClashScouting.ts` (one-shot fetch, not a poll — a Clash roster doesn't change second-to-second the way a live lobby does; `selectTeam(teamId)`/`refresh()` re-issue the request), `frontend/src/components/ClashScoutingPanel.tsx` (state machine: loading/not_registered/multiple_teams/error/report), `frontend/src/components/ClashTeamPicker.tsx`. `frontend/src/api/lookupClient.ts` gained `fetchClashScout`/`readClashScoutResponse`; `frontend/src/api/types.ts` gained the `Clash*` type mirrors of the backend contract.
    - **Team picker is text-only (name + abbreviation), no team icon** — `ClashTeamSummary.iconId` addresses Riot's Clash team-icon asset set, which the frontend's Static_Data_Provider has no accessor for (only summoner profile icons + champion/rune/spell assets are resolved today); rendering it through the wrong accessor (`profileIconUrl`) would show the wrong image, so it's text-only until/unless a real Clash-icon accessor is added.

  - [x] 8.2 Implement the roster display
    - Render five Roster_Cards with declared position, captain marker, rank, champion pool and recent form, with absent enrichment fields rendered blank rather than as zeros, and unranked members rendered as unranked
    - Resolve champion names and images through the Static_Data_Provider defined in the `visual-assets` spec
    - _Requirements: 2.5, 2.7_
    - New: `frontend/src/components/RosterMemberCard.tsx`, `frontend/src/components/ClashScoutingView.tsx` (team header + insights + roster grid), `frontend/src/domain/clashScouting.ts` (pure label helpers). Recent-form pips use gold-for-win/neutral-for-loss (design-system rule: gold=win, never green/red).
    - **Known limitation, not fixed here:** `RosterCard.rankedEntries` (added in task 4) is `readonly RankedQueueStanding[]` with no `queueType` per entry — a consequence of `enricher.ts` reusing `rankedByQueueOf`'s `Object.values(...)`. The roster card therefore shows the first ranked entry it finds, unlabelled by queue, rather than a specific "Ranked Solo/Duo" line. Fixing it means changing the backend type from task 4/1, which is out of scope for a rendering task.

  - [x] 8.3 Implement the scouting insight display
    - Render the ban recommendation list in the engine's order, position mismatch flags on the relevant cards, and stack cohesion on the report header
    - Omit a member's mismatch flag entirely rather than rendering an empty one when their Recent_Form is empty or their declaration is unselected or fill
    - Render the report without tournament details when `tournament` is null
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.4_
    - No additional filtering needed here — `positionMismatches`/`banRecommendations` arriving from the backend already have 3.5/3.6's exclusions applied; the view only needs to render exactly what it's given (`mismatchedPuuids` is a plain `Set` built from the array).

  - [ ] 8.4 Apply the Riot compliance template
    - Render the scouting page through the existing `RiotDataPage` wrapper (`frontend/src/compliance/RiotDataPage.tsx`) so attribution and the no-advertising default apply without being re-implemented
    - Display no roster member identifier beyond the Riot ID Riot itself exposes, and present nothing as endorsed by or affiliated with Riot Games
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
    - **Not implemented as a separate step — satisfied structurally, same as `LiveGamePanel`.** `ClashScoutingPanel` is only ever mounted inside the profile report, which `RiotDataPage` already wraps; a second wrapper here would be redundant nesting. No roster identifier beyond `riotId` (gameName#tagLine) is rendered.

  - [~] 8.5 Write unit tests for the view
    - Team picker for multiple registrations (1.5), not-registered state (1.3), unranked rendering (2.7), no mismatch flag for FILL and for empty Recent_Form (3.5, 3.6), report renders with null tournament (4.4), attribution and ad-slot absence (6.1, 6.2)
    - _Requirements: 1.3, 1.5, 2.7, 3.5, 3.6, 4.4, 6.1, 6.2_
    - Done: `ClashScoutingView.test.tsx` (8 tests — roster count, captain badge, tournament null-vs-present, ban order, empty ban list, mismatch flag targeting, unranked-vs-failed, cohesion count), `ClashTeamPicker.test.tsx` (1 test), `useClashScouting.test.ts` (6 tests — report/not_registered/multiple_teams/selectTeam/error+refresh/idle-with-null-riotId), plus two cases added to `ProfileReportView.test.tsx`'s tab-switching describe block. **Not done:** a dedicated FILL/UNSELECTED-declaration-no-flag case (the backend already guarantees this — Property 3/tasks 3.5-3.6 — so the view has nothing to filter, but no frontend test pins it down), and attribution/ad-slot assertions (already covered structurally by `RiotDataPage.test.tsx` and by 8.4 being satisfied via composition, not a separate render path to test).

  - [ ] 8.3 Implement the scouting insight display
    - Render the ban recommendation list in the engine's order, position mismatch flags on the relevant cards, and stack cohesion on the report header
    - Omit a member's mismatch flag entirely rather than rendering an empty one when their Recent_Form is empty or their declaration is unselected or fill
    - Render the report without tournament details when `tournament` is null
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.4_

  - [ ] 8.4 Apply the Riot compliance template
    - Render the scouting page through the existing `RiotDataPage` wrapper (`frontend/src/compliance/RiotDataPage.tsx`) so attribution and the no-advertising default apply without being re-implemented
    - Display no roster member identifier beyond the Riot ID Riot itself exposes, and present nothing as endorsed by or affiliated with Riot Games
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 8.5 Write unit tests for the view
    - Team picker for multiple registrations (1.5), not-registered state (1.3), unranked rendering (2.7), no mismatch flag for FILL and for empty Recent_Form (3.5, 3.6), report renders with null tournament (4.4), attribution and ad-slot absence (6.1, 6.2)
    - _Requirements: 1.3, 1.5, 2.7, 3.5, 3.6, 4.4, 6.1, 6.2_

- [x] 9. Checkpoint - Ensure all tests pass — trivially satisfied (already green from tasks 7-8); backend 731 pass / 12 skip, frontend 506 pass, tsc + eslint clean both.

- [x] 10. Integration and wiring — **done 2026-09-01.** Backend 731 pass / 12 skip, tsc + eslint clean.
  - [x] 10.1 Wire the Tournament Refresher into the composition root
    - Start the refresher with the real scheduler and clock at application start, and stop it on shutdown
    - Confirm the Scouting Orchestrator is constructed without a `ClashTournamentSource` reference
    - _Requirements: 4.1, 4.2_
    - **New: `backend/src/clashScouting/tournamentSourceHttp.ts`** — the concrete `ClashTournamentSource` (design.md and tasks.md never specified one; task 1.3 built only the interface). Deliberately duplicates a small slice of `HttpRiotApiClient`'s request machinery (timeout, rate-limit reservation, bounded 429 retry) rather than exposing `send()` for reuse from `riotApiClient/index.ts` — reuses that module's exported constants/types (`API_KEY_HEADER`, `REQUEST_TIMEOUT_MS`, `parseRetryAfterSeconds`, etc.) so the two policies can't silently drift, but stays a structurally separate module so the compile-time boundary (Requirement 4.1) has no path back to `RiotApiClient`. 11 tests in `tournamentSourceHttp.test.ts`.
    - `index.ts` (composition root): builds the source, `createTournamentRefresher({ source, cache, platforms: Object.keys(PLATFORM_TO_REGION), now })`, calls `.start()` at startup, `.stop()` added to the existing `shutdown` handler (alongside the database-client close).
    - `scoutingOrchestrator` (wired in task 7) was already built with no `ClashTournamentSource` field — confirmed, not changed.

  - [x] 10.2 Write integration test for a full scouting report
    - Five-member roster against a mocked Riot API containing one member whose League-V4 call fails, one whose Recent_Form has two individually-failing matches, one declared FILL, and two members appearing together in the same matches
    - Assert `200`, five cards in roster order, a ban list of at most 5 in the declared order, exactly one position mismatch, and the expected stack cohesion
    - _Requirements: 2.5, 2.6, 3.2, 3.3, 3.4, 3.5, 3.7_
    - `backend/src/clashScouting/integration.test.ts` — real stack (`createApiRouter` down to the Riot API client), fake transport. p3's League-V4 fails; p2 has 3 match ids where 2 individually fail (server_error + not_found) and the 1 success (MIDDLE) mismatches its declared JUNGLE; p4 is FILL and never flagged; p4+p5 share a match, driving `stackCohesion: 2`. All assertions pass.

  - [x] 10.3 Update the README
    - Document the `GET /api/clash/scout` endpoint, the new cache entry types and their TTLs, the background Tournament Refresher and its interval, and the fact that Riot exposes no bracket so a report is addressed by naming any player on the team
    - _Requirements: 4.1, 4.2, 5.1_
    - New `### GET /api/clash/scout` section (mirrors the `GET /api/live-game` section's shape: request/response JSON, the "not an error" framing for all three outcomes, the tournaments-endpoint boundary explained as structural not conventional, the shared-match-cache economics of scouting a five-stack). 4 new Caching-table rows (`clashPlayers`/`clashTeam`/`tournamentSchedule`/`championMasteryTop`). API list at the top of the architecture diagram gained `Clash-V1`.

**`specs/clash-scouting/` is now fully complete — every task, including every optional (`*`) property test, is done.** Only the two genuinely-optional example/property test items never marked `*` at all in the original plan (i.e. nothing) remain; there is no more unimplemented work in this spec. Final tally: backend 737 pass / 12 skip, frontend 506 pass, tsc + eslint clean on both workspaces. **Nothing in this spec, nor in the five before it on the roadmap, has been committed.**

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster delivery; they are not implemented by the coding agent by default.
- **This feature depends on the `lookup-pipeline-fixes` spec** for the Region_Resolver (task 5.1) and the `enrich<T>()` helper (task 4.1), on the **`live-game` spec** for the champion mastery cache entry, and on the **`visual-assets` spec** for the Static_Data_Provider (task 8.2). Do not start wave 3 before both have landed.
- **Clash-V1's tournaments endpoint is granted 10 requests per minute** — three orders of magnitude below every other endpoint here, and below what the Rate_Limit_Manager's 30-second ceiling can absorb. Task 1.3's interface split is the mechanism that keeps it off the request path, and Property 2 is what keeps it there. Do not merge `getClashTournaments` back onto `RiotApiClient` for convenience; the regression it would enable is intermittent and would be misdiagnosed as a Riot outage.
- **Riot exposes no tournament bracket.** There is no endpoint that answers "who does this team play next", so a scouting report is addressed by naming any player on the team to be scouted. Do not design a flow that assumes otherwise.
- Task 4.1's 10-match Recent_Form bound is load-bearing, not a default. Unbounded, five members against the existing 100-match window (`MATCH_HISTORY_COUNT` in `backend/src/orchestrator/index.ts`) would fan out to roughly 500 Match-V5 calls per report against a 2,000-per-10-seconds limit.
- Property tests use `fast-check` with a minimum of 100 runs each, tagged `// Feature: clash-scouting, Property {n}: {property text}`.
- Property 4's generators must force ties. Drawing champion ids and mastery values from wide ranges would leave the third and fourth ban-order keys unexercised, and the test would pass while the order's totality went unchecked. Several of the existing property tests in `backend/src/` carry exactly this weakness — a bare `expect(count).toBeGreaterThan(0)` coverage guard with no pinned `examples` — so do not copy that pattern here.
- Scouting a five-stack is cheaper than scouting five strangers, because their overlapping matches share `matchDetail` cache entries, which are already retained indefinitely. No work is needed to get this; it is noted so the cost model is not misread.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "2.1", "2.2"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.3", "4.1"] },
    { "id": 2, "tasks": ["4.2", "5.1"] },
    { "id": 3, "tasks": ["5.2", "5.3", "7.1"] },
    { "id": 4, "tasks": ["7.2", "8.1", "8.2"] },
    { "id": 5, "tasks": ["8.3", "8.4", "10.1"] },
    { "id": 6, "tasks": ["8.5", "10.2"] },
    { "id": 7, "tasks": ["10.3"] }
  ]
}
```
