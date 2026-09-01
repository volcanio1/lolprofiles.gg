# Implementation Plan: player-insights

## Overview

This plan removes the existing Fun Facts and Improvement Recommendations modules outright (task 1) before building anything new, so there is never a window where both the old and new logic coexist. Phase 1 (tasks 2-6) needs no new Riot API call. Phase 2 (tasks 7-8) is gated behind an explicit decision — see design.md's Rate Limiting section — and should not be started without confirming the bounding/laziness/caching strategy first.

## Tasks

- [x] 1. Remove the existing Fun Facts and Improvement Recommendations logic — **done 2026-09-01.** Backend 694 pass / 12 skip, frontend 506 pass, tsc + eslint + production build clean on both workspaces.
  - [x] 1.1 Delete `backend/src/insight/funFacts.ts` and `backend/src/insight/recommendations.ts` and their test files
    - Remove every import of `computeFunFacts`/`computeRecommendations` and the `FunFact`/`Recommendation` types
    - _Requirements: 1.1, 1.2_
    - Deleted `funFacts.ts` + its `.test.ts`/`.property.test.ts`, `recommendations.ts` + its `.test.ts`/`.property.test.ts`.

  - [x] 1.2 Remove `funFacts`/`recommendations` from `ProfileReport` and the orchestrator's `assembleReport`
    - Remove the two `computeFunFacts(matches)` / `computeRecommendations(matches, stats)` call sites in `backend/src/orchestrator/index.ts`
    - _Requirements: 1.3_
    - **`isLimitedData`/`LIMITED_DATA_MATCH_THRESHOLD` moved to `stats.ts`** (were previously defined in the now-deleted `funFacts.ts`) — `ProfileReport.limitedDataNotice` is an existing field this spec does not touch and needed a surviving home for its source of truth. `averageMatchDurationMinutesOf` already lived in `stats.ts` (re-exported by `funFacts.ts`); the orchestrator now imports both directly from `stats.ts`.
    - Fan-out: `api/lookup.test.ts`, `orchestrator/index.test.ts`, `orchestrator/index.property.test.ts`, `endToEnd.test.ts` all had fixtures/assertions referencing the removed fields.

  - [x] 1.3 Remove the old sections from `ProfileReportView.tsx` and their frontend types (`frontend/src/api/types.ts`)
    - Remove any test coverage that only exists to assert old-category behavior
    - _Requirements: 1.4, 1.5_
    - Removed `FunFact`/`Recommendation` types and the two `ProfileReport` fields; removed `isProfileReport`'s `funFacts`/`recommendations` array checks (`lookupClient.ts`) — swapped in a `rankHistory` near-miss case in `lookupClient.test.ts` so that test still exercises the narrowing function meaningfully. Removed the `.rsec-duo` JSX block and its two label maps (`FUN_FACT_LABELS`/`RECOMMENDATION_LABELS`) from `ProfileReportView.tsx`. The `limited-data-notice` test coverage was kept (it's a separate, still-live render path unrelated to the removed sections) under a renamed describe block. Fan-out: `lookupClient.test.ts`, `useLookup.test.tsx`, `pages.test.tsx`, `ProfileReportView.test.tsx`.
    - **Not cleaned up**: the now-orphaned `.fact-list`/`.reco-list`/etc. CSS classes in `styles.css` — left in place since task 6 may reuse or replace them when it adds the new sections' markup.

  - [x] 1.4 Checkpoint — confirm the build is clean with both sections gone
    - `tsc`/`eslint` pass with no dead references; the report renders (temporarily) with neither section, before task 2 adds the replacements
    - Verified via both workspaces' full `tsc --noEmit`, `eslint`, `vitest run`, AND a full production build (`npm run build`) on each — not just typecheck/lint/unit tests.

- [x] 2. Add the two new Match-V5 fields (Requirement 14) — **done 2026-09-01.** Backend 694 pass / 12 skip, tsc + eslint + `npm run build` clean.
  - [x] 2.1 Add the fourteen ping fields and `neutralMinionsKilled` to `MatchParticipantDto` (`backend/src/riotApiClient/index.ts`)
    - _Requirements: 14.1, 14.2_
    - Added all fourteen ping fields. **`neutralMinionsKilled` already existed on the DTO** (added earlier, unrelated to this spec, for `csOf()`'s combined CS calculation) — no DTO change needed for it.

  - [x] 2.2 Add all fifteen field names to `matchProjection.ts`'s `PARTICIPANT_KEYS`
    - Confirm no additional Riot API call is introduced — these fields are already present in the `MatchDto` this codebase fetches per match
    - _Requirements: 14.3_
    - Added the fourteen ping keys. **`neutralMinionsKilled` was already in `PARTICIPANT_KEYS`** — already retained through the cache/store projection.

  - [x] 2.3 Thread the same fields onto `stats.ts`'s `MatchParticipant` and `orchestrator/mapping.ts`'s `toMatchParticipant`
    - Confirm `match-detail-tabs`, `item-timeline`, and `clash-scouting` — the existing consumers of these types — are unaffected by the additive fields
    - _Requirements: 14.4_
    - **This was the real gap**: despite already being on the DTO and the projection, `neutralMinionsKilled` had never been threaded onto `stats.ts`'s all-ten-participant `MatchParticipant` type or `toMatchParticipant` — it was read only internally by `csOf()` to build the combined `cs` total, never exposed per-participant. Added both `neutralMinionsKilled` and all fourteen ping fields as flat `MatchParticipant` fields (matching the DTO's flat shape, and the existing style of `turretKills`/`dragonKills`/etc.), populated via `finiteOrZero` in `toMatchParticipant`. Confirmed via a full `tsc --noEmit` that `match-detail-tabs`, `item-timeline`, and `clash-scouting` — none of which construct a `MatchParticipant` object literal directly — are unaffected; two test fixtures that DO construct literals (`premades.test.ts`'s factory, `mapping.test.ts`'s exact-shape assertion) needed the new fields added.

- [x] 3. Implement `backend/src/insight/funFactsV2.ts` — **done 2026-09-01.** Backend 715 pass / 12 skip, tsc + eslint + build clean.
  - [x] 3.1 Implement `nemesisOf` (Requirement 2)
    - Group by Lane_Opponent championName, apply `NEMESIS_MIN_GAMES`, select lowest win rate with the declared tie-break order
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
    - Win-rate comparison uses integer cross-multiplication of the exact win/games fractions, not the rounded display percent (two champions can round to the same whole percent while differing in the exact fraction) — same style `clash-scouting`'s `compareBanCandidates` already uses.

  - [x] 3.2 Implement `longestGameOf` (Requirement 3)
    - Tie-break to the most recent match
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
    - Implemented as an order-independent fold (best-so-far by `(durationSeconds, startTimestamp)` descending), so the result never depends on input array order.

  - [x] 3.3 Implement `favoriteItemsOf` and the `BOOT_ITEM_IDS` exclusion list (Requirement 4)
    - Document the boot-list drift caveat inline, per design.md's Data Models section
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
    - Boot list covers the classic boot line (8 ids, stable across many seasons); explicitly does NOT cover Season 14+ boot-upgrade enchants, whose exact ids were not independently verified — documented inline, same honesty class as the README's stat-shard/ARAM-Mayhem-augment caveats.

  - [x] 3.4 Implement `mostUsedPingOf` and `PING_FIELD_ORDER` (Requirement 5)
    - _Requirements: 5.1, 5.2, 5.3_
    - Also added `PING_FIELD_LABELS` (Requirement 5.4's human-readable labels) here rather than in a frontend-only module — it's a fixed, backend-owned mapping with no Static_Data_Provider dependency, so there was no reason to duplicate it client-side.

  - [x] 3.5 Implement `computeFunFactsV2` assembling the four categories in fixed order
    - _Requirements: 2, 3, 4, 5_
    - **Deviation from design.md's sketched `FunFactV2` shape**: added an optional `favoriteItems?: readonly FavoriteItem[]` field, populated only on the `favoriteItems` category. design.md's interface sketch was `{category, text}` only, but Requirement 4.6 requires the FRONTEND to resolve item ids to icons/names via the Static_Data_Provider — a frontend that only received prose `text` would have no item ids to resolve. `text` remains a readable fallback; `favoriteItems` is the structured data the frontend actually renders icons from.

  - [x] 3.8 (added 2026-09-01, user request: "let fun facts work on all data we have") Extend `computeFunFactsV2` to also read `lanelessMatches` (ARAM / ARAM Mayhem), not only Summoner's Rift
    - New optional second parameter, defaults to `[]` so the task 5 orchestrator call site and every existing test needed no change beyond passing it through. Each `LanelessMatch` is adapted to the `IncludedMatch` shape (`role: ''`, `opponent: undefined`) and folded in with `matches` before any category runs. Needs no per-category queueType filtering: Nemesis already excludes any match with no `opponent`, so the adapted Laneless_Matches are automatically excluded from Nemesis by that same pre-existing rule — no new exclusion logic had to be written. `longestGameOf`/`favoriteItemsOf`/`mostUsedPingOf` read the full merged set, since duration/item builds/pings are meaningful in every queue. Performance Feedback is untouched (still `recentRankedWindowOf(matches)` only — a Laneless_Match is never a Ranked_Match). 5 new tests in `funFactsV2.test.ts`. Backend 764 pass / 12 skip, tsc + eslint + build clean.

  - [x] 3.9 (added 2026-09-01, user request: "add average gold diff at 10 to fun facts, average KDA") Add `averageKda` and `averageGoldDiffAt10` Fun Fact categories
    - `averageKdaFactOf` reuses `stats.ts#averageKdaOf` over the same merged `matches ∪ lanelessMatches` window every other category here reads; `undefined` only for a genuinely empty window (in practice this category fires whenever any other one could). `averageGoldDiffAt10Of` takes a third optional `earlyGame: readonly EarlyGameAggregate[] = []` parameter and averages only the non-`null` `goldDiffAt10` entries — it reuses whatever `player-insights` Phase 2 already computed for Performance Feedback rather than fetching or computing anything new, so it inherits that computation's own Ranked-only, `EARLY_GAME_MATCH_LIMIT`-bounded scope (narrower than every other Fun Fact, since that's the nature of the underlying data, not a new restriction). Fixed category order extended to nemesis, longestGame, favoriteItems, mostUsedPing, averageKda, averageGoldDiffAt10. 7 new tests in `funFactsV2.test.ts`; property test 3.6/3.7's category allowlist and length bound updated (5, not 4 — `averageGoldDiffAt10` never fires in that property since it never generates `earlyGame` data). Backend 769 pass / 12 skip, frontend 517 pass, tsc + eslint + build clean both workspaces.

  - [x]* 3.6 Write property test for Fun Facts purity and category cardinality
    - **Property 1**
    - **Validates: Requirements 1.5, 2, 3, 4, 5**

  - [x]* 3.7 Write property test for Nemesis's total order
    - **Property 2**
    - **Validates: Requirement 2**
    - `funFactsV2.test.ts` (18 example tests) + `funFactsV2.property.test.ts` (3 property tests, 200 runs each, plus a pinned name-tie-break example).

- [x] 4. Implement `backend/src/insight/performanceFeedback.ts` — **done 2026-09-01.** Backend 736 pass / 12 skip, tsc + eslint + build clean.
  - [x] 4.1 Implement `recentRankedWindowOf` (Requirement 6) — filter to Ranked_Matches, then cap to the most recent `PERFORMANCE_FEEDBACK_WINDOW` (30) by `startTimestamp`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
    - Filters before capping (decision 1) — a player who mostly plays normals still gets a full 30-RANKED-game window as long as they have that many anywhere in their Included_Match history, not 30-most-recent-games-of-any-type.

  - [x] 4.2 Implement `isSupportMajority` and wire it into `csPerMinuteFeedbackOf`/`damageShareFeedbackOf` (Requirement 8)
    - Role determination reads the RANKED window only, never the full match window
    - _Requirements: 8.1, 8.2, 8.3_
    - Reuses `stats.ts`'s `mostPlayedRoleOf` unchanged — it already returns the display-normalized `'Support'` string (the `UTILITY`→`Support` rename happens upstream in `orchestrator/mapping.ts`), so no second normalization step was needed.

  - [x] 4.3 Implement `csPerMinuteFeedbackOf` (Requirement 9)
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 4.4 Implement `damageShareFeedbackOf` (Requirement 10)
    - Exclude matches without a Full_Lobby from the average rather than zeroing them
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_
    - **Interpretation choice**: compares the mean of the player's own per-match damage against the mean of their teammates' per-match damage (both means over the same contributing matches), not a mean of per-match ratios — chosen because Requirement 10.5 asks the feedback text to state exactly those two numbers, so the trigger compares the same numbers the text shows.

  - [x] 4.5 Implement `killParticipationFeedbackOf` (Requirement 11)
    - Exclude `'N/A'` kill-participation rows
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 4.6 Implement `jungleObjectivesFeedbackOf` (Requirement 12)
    - Locate the enemy jungler by opposing `teamId` + `teamPosition === 'JUNGLE'`; exclude matches with no identifiable enemy jungler
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_
    - Reads the Full_Lobby self row's raw `teamPosition` (not `IncludedMatch.role`, which is display-normalized) per Requirement 12.1's literal wording. Combined score = `neutralMinionsKilled + turretKills + dragonKills + baronKills`.

  - [x] 4.7 Implement `computePerformanceFeedback` assembling the four Phase-1 categories in fixed order
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x]* 4.8 Write property test for Performance Feedback triggering and Support suppression
    - **Property 3**
    - **Validates: Requirements 7, 8, 9, 10, 11, 12**

  - [x]* 4.9 Write property test for the ranked-only data source
    - **Property 4**
    - **Validates: Requirement 6**
    - `performanceFeedback.test.ts` (19 example tests) + `performanceFeedback.property.test.ts` (2 properties, 200 runs each — Property 4 corrupts every out-of-window match's performance fields while leaving `queueType`/`startTimestamp` untouched, so window membership is provably unaffected by the corruption and any change in output would prove a filtering leak).

- [x] 5. Wire both modules into the orchestrator — **done 2026-09-01.** Backend 737 pass / 12 skip, tsc + eslint + build clean.
  - [x] 5.1 Replace the removed `funFacts`/`recommendations` assembly with `computeFunFactsV2(matches)` / `computePerformanceFeedback(recentRankedWindowOf(matches))` in `backend/src/orchestrator/index.ts`
    - _Requirements: 6.1, 6.5_
    - `ProfileReport.funFacts`/`.performanceFeedback` re-added with their new `FunFactV2[]`/`PerformanceFeedback[]` types. Both the fresh-path and the stale-cache fallback go through the same `assembleReport` method, so both are covered by this one change. Fan-out: `api/lookup.test.ts`'s sample fixture needed the two fields added back.

  - [x]* 5.2 Write an integration test asserting `ProfileReport.funFacts`/`performanceFeedback` populate end to end from a realistic mixed-queue, mixed-role fixture
    - Added to `orchestrator/index.test.ts` (real `runLookup` → real `mapping.ts` → real `funFactsV2`/`performanceFeedback`, only the Riot client faked). A hand-built 3-match, 10-participant-per-match fixture (2-1 record vs. Zed in lane, low CS/damage/kill-participation for the analyzed player, matching items every game, one ping field used) exercises Nemesis, longest game, favorite items, most-used ping, CS/min, damage share, and kill participation all in one pass — confirming the real `toIncludedMatch`/`toMatchParticipant` mapping produces data these two modules can actually trigger on, not just that the pure functions work in isolation against hand-built `IncludedMatch` fixtures (which was already covered by tasks 3/4's own tests).

- [x] 6. Implement the frontend — **done 2026-09-01.** Frontend 516 pass, tsc + eslint + production build clean.
  - [x] 6.1 Add `FunFactV2`/`PerformanceFeedback` type mirrors to `frontend/src/api/types.ts`
    - _Requirements: 13_
    - Also added `FavoriteItem` and `PerformanceFeedbackCategory`; restored the two `Array.isArray` checks in `lookupClient.ts`'s `isProfileReport` narrowing (matching the pre-task-1 convention). Fan-out: `lookupClient.test.ts`, `useLookup.test.tsx`, `pages.test.tsx`, `ProfileReportView.test.tsx` fixtures all needed the two fields added back.

  - [x] 6.2 Render the new Fun Facts section in `ProfileReportView.tsx`
    - Resolve favorite-item ids through the existing Static_Data_Provider/`ItemBuildRow` machinery
    - Add `frontend/src/domain/pings.ts` (or similar) for the ping-field-to-label map (Requirement 5.4)
    - _Requirements: 13.1, 13.5_
    - New `FunFactsPanel.tsx`. **No `domain/pings.ts` needed** — task 3.5 already put `PING_FIELD_LABELS` backend-side and bakes the human-readable label straight into the `text` prose (`"Most-used ping: On My Way, used 12 times."`), so there was nothing left for the frontend to map. Favorite items render as icon chips (`CdnImage` + `provider.itemIconUrl`/`itemDisplayName`, same primitives `ItemBuildRow`/`RosterMemberCard` already use) alongside the prose text.

  - [x] 6.3 Render the new Performance Feedback section
    - Distinct empty states for "nothing stood out" (Requirement 13.3) vs. "needs ranked games" (Requirement 13.4)
    - _Requirements: 13.2, 13.3, 13.4_
    - New `PerformanceFeedbackPanel.tsx`. **`hasRankedMatches` is derived in `ProfileReportView.tsx`** from `report.recentMatches.some(m => m.queueType === 'ranked solo/duo' || m.queueType === 'ranked flex')` — `performanceFeedback: []` alone can't distinguish "no ranked games" from "ranked games, nothing triggered", so the frontend needed its own signal; `recentMatches` was the only field already carrying `queueType` per match.

  - [x]* 6.4 Write frontend tests for both sections' populated and empty states, using `data-testid`s consistent with the rest of the page
    - `FunFactsPanel.test.tsx` (4 tests), `PerformanceFeedbackPanel.test.tsx` (3 tests), plus 3 new cases in `ProfileReportView.test.tsx` covering both distinct empty states end to end.

- [x] 7. Checkpoint — Phase 1 complete — **done 2026-09-01.** Backend 737 pass / 12 skip, frontend 516 pass, tsc + eslint + production build clean on both workspaces.
  - Ensure all tests pass; confirm no additional Riot API call was introduced anywhere in Phase 1 (spot-check against a live lookup's call count before/after)
    - Confirmed structurally rather than via a live network spot-check: `funFactsV2.ts` and `performanceFeedback.ts` import ONLY from `./stats` (grep-verified — neither file references `riotApiClient` at all), and both are invoked synchronously against the already-fetched `matches` array inside `assembleReport`, with no `client.get*` call added anywhere near either call site. This is a stronger guarantee than a live spot-check (which a cache hit could make misleading) and costs no rate-limited Riot budget to establish.
  - Resolve design.md's Open Questions 1 and 2 (damage-share/jungle-objective/KP thresholds) if not already confirmed, before calling Phase 1 done
    - **Confirmed as implemented** (80% / 80% / 50% respectively) — the user was shown these as this session's own interpretation choices (not user-specified, unlike CS/min's 8.5) after task 4 and again after task 6, and asked to proceed without requesting a change. Treated as accepted; revisit if real usage suggests they're miscalibrated.

- [x] 8. Phase 2 — lane-phase deaths and gold/CS diff at 10 — **done 2026-09-01.** Backend 759 pass / 12 skip, frontend 516 pass, tsc + eslint + production build clean on both workspaces.
  - [x] 8.1 Decide and document the bounding/laziness/caching strategy (design.md's three options)
    - _Requirements: 15.1, 16.1_
    - User confirmed **"Bounded + cached"** via `AskUserQuestion`. Implemented as `EARLY_GAME_MATCH_LIMIT = 10` (`orchestrator/index.ts`): only the 10 most recent matches within the Recent_Ranked_Window get a timeline fetch, eagerly as part of every fresh-path lookup (never lazy), each derived per-match/per-puuid aggregate cached indefinitely under the new `earlyGameSlice` cache endpoint (`orchestrator/earlyGame.ts`) so a repeat lookup issues zero further timeline calls for a match already seen. The raw 0.3-1MB timeline itself is never cached, matching `item-timeline`'s precedent.

  - [x] 8.2 Extend the Match_Timeline parser to extract `CHAMPION_KILL` events attributable to the analyzed player, classified lane-phase vs. post-lane-phase
    - _Requirements: 15.2_
    - `riotApiClient/index.ts`'s `TimelineEventDto` union extended with `CHAMPION_KILL`; `insight/earlyGame.ts`'s `lanePhaseDeathCountOf(events, participantId)` (cutoff `LANE_PHASE_CUTOFF_MS = 15min`).

  - [x] 8.3 Extend the Match_Timeline parser to extract the analyzed player's and their Lane_Opponent's gold/CS at the frame nearest 10 minutes
    - _Requirements: 16.2_
    - `MatchTimelineDto.info.frames[].participantFrames` added to the DTO; `insight/earlyGame.ts`'s `goldCsAtOf(frames, participantId, targetMs = EARLY_GAME_SNAPSHOT_MS)` picks the frame with minimum `|timestamp - targetMs|`, `undefined` if no frame reaches the target or the nearest frame lacks data for the participant.

  - [x] 8.4 Implement `lanePhaseDeathsFeedbackOf` and `earlyGameDeficitFeedbackOf`, following the same "excluded, never zeroed, on missing data" shape as every other category
    - _Requirements: 15.3, 15.4, 16.3, 16.4_
    - `insight/performanceFeedback.ts`. `LANE_PHASE_DEATH_BENCHMARK = 2` (average lane-phase deaths above this triggers); `EARLY_GAME_GOLD_DEFICIT_THRESHOLD = 300` gold, triggered on the gold diff only (design.md Open Question 3 — CS is reported in the text when available, not a second trigger condition). Both average only over `earlyGame` entries whose `matchId` is in the caller's `rankedMatches` set and whose relevant field is non-`null`.

  - [x] 8.5 Wire the two Phase-2 categories into `computePerformanceFeedback`'s fixed category order and the frontend rendering
    - `computePerformanceFeedback(rankedMatches, earlyGame = [])` — new optional second parameter, defaults to `[]` so every Phase 1 call site is unaffected. `orchestrator/index.ts`'s new `computeEarlyGameAggregates` (fresh path only, never the stale-cache fallback) re-reads each candidate match's already-cached raw `MatchDto` (zero new Match-V5 detail calls) and calls `EarlyGameProvider.getAggregate` per match, bounded/gated by `EARLY_GAME_MATCH_LIMIT` and the existing 15s budget gate. Frontend: `PerformanceFeedbackCategory` and `FEEDBACK_LABELS` extended with `lanePhaseDeaths`/`earlyGameDeficit` in `frontend/src/api/types.ts` and `PerformanceFeedbackPanel.tsx`.

  - [x]* 8.6 Write property tests for both Phase-2 categories, mirroring Property 3's shape
    - `insight/performanceFeedback.property.test.ts`'s new Property 5: consistency against the real per-category functions across a generated `earlyGame` array, immunity to corrupting/dropping out-of-window `earlyGame` entries, and "never fires on an empty `earlyGame` array."

  - [x] 8.7 Checkpoint — Phase 2 complete
    - Confirm the fetch-volume increase measured against a live lookup matches what was decided in task 8.1
    - Confirmed via `endToEnd.test.ts` over the real assembled stack (not just unit-level): a first lookup with 5 ranked matches in the fixture issues exactly 5 new Match-Timeline calls (one per candidate, well under `EARLY_GAME_MATCH_LIMIT = 10`); the "repeat lookup" test (Requirement 10.5) confirms a second lookup of the same player adds only the one Enrichment_Call (Summoner-V4) that is deliberately never cached — zero further timeline calls, proving the indefinite `earlyGameSlice` cache is actually hit on a real repeat lookup, not just in `orchestrator/earlyGame.test.ts`'s isolated unit tests.
