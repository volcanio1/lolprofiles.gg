# Implementation Plan: item-timeline

## Overview

This plan is shaped by one piece of genuine uncertainty and one hard constraint.

The uncertainty is `ITEM_UNDO`'s field semantics. Which of `beforeId` and `afterId` carries the item being reversed, for an undone purchase versus an undone sell, is not verified anywhere in this specification, and the reducer's correctness depends on it entirely. Task 1.1 confirms it against real data before a line of the reducer is written, because a reducer built on a guess passes its own tests and produces plausible wrong builds — the exact failure this feature exists to avoid.

The constraint is that the raw Match_Timeline must never be retained. That is enforced structurally rather than by discipline: no `timeline` cache entry type is added, so there is nothing for a caller to reach for. Task 3.1 adds only the Timeline_Slice entry, and Property 5 asserts that nothing resembling a frame array ever reaches the cache.

The reducer is pure and is built and property-tested in isolation before any I/O touches it, following how the rest of the codebase is layered. Everything downstream of it — the orchestrator, the route, the view — is plumbing of a shape already built several times in this project.

## Tasks

- [ ] 1. Confirm the event contract
  - [ ] 1.1 Verify Match-V5 timeline semantics against real data
    - Retrieve a real timeline for a known recent match and record the `ITEM_UNDO` field polarity: which of `beforeId` / `afterId` carries the reversed item, for an undone purchase and for an undone sell
    - Confirm `info.participants` carries the Participant_Slot to PUUID mapping, and confirm whether `metadata.participants` ordering agrees with it
    - Record the observed response size for a short game and a long game, to check the 1–5 MB assumption the retention design rests on
    - Write the findings into design.md, replacing the "not verified" note on the reducer with the observed semantics
    - _Requirements: 2.2, 2.5_

- [ ] 2. Build the reducer and reconciler
  - [ ] 2.1 Implement `replayShopEvents`
    - Pure fold over events for one Participant_Slot in ascending timestamp order, taking the slot as a parameter so extracting a second participant later needs no change to the logic
    - Append on purchase; leave the build path untouched on sell and on destroy while removing from the inventory; on undo, reverse the corresponding prior action so the result equals what would have obtained had it never occurred
    - Ignore every event type other than the four Shop_Events, and every event belonging to another slot
    - Take no client, no clock and no I/O
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 7.1, 7.2_

  - [ ]* 2.2 Write property test for undo equivalence
    - **Property 1: Undo is equivalent to the action never having occurred**
    - **Validates: Requirement 2.2**
    - State it as an equivalence between two replays rather than as an assertion about undo mechanics, so it holds regardless of the field polarity confirmed in 1.1
    - Generate multiple undos, undos of sells as well as purchases, and consecutive undos

  - [ ]* 2.3 Write property test for build path ordering and completeness
    - **Property 3: The build path is ordered, complete, and free of undone acquisitions**
    - **Validates: Requirements 2.1, 2.3, 2.4, 2.7**
    - Generate undos interleaved with intervening events rather than only trailing undos, which is the easy case a hand-written example set would contain

  - [ ]* 2.4 Write property test for participant isolation
    - **Property 4: Only the analyzed participant's events affect the result**
    - **Validates: Requirements 2.5, 2.6, 7.1**

  - [ ] 2.5 Implement `reconcile`
    - Compare the replay's end-state inventory against the `ItemBuild` captured by the `visual-assets` feature, as multisets, reporting the difference in both directions
    - Do not repair, suppress, or discard an unreconciled result
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [ ]* 2.6 Write property test for the cross-endpoint oracle
    - **Property 2: Replay reconstructs the reported final build**
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - Generate *pairs* — a synthetic event stream and the Final_Build it implies — and ensure the streams contain sells, destroys and undos, not purchases alone

- [ ] 3. Extend the client and cache
  - [ ] 3.1 Add the `timelineSlice` cache entry type
    - Key on `{ matchId, puuid }` with indefinite retention, matching the immutability argument already applied to match details
    - Add **no** cache entry type for the raw timeline, so there is nothing for a caller to reach for
    - _Requirements: 5.3, 5.4, 5.1_

  - [ ] 3.2 Add `getMatchTimeline` to the Riot API Client
    - Regional-routed, reserving a rate-limit slot, applying the 10s timeout, honouring the 429 retry policy, mapping onto the existing `RiotApiResult` variants
    - Type frames as carrying `timestamp` and `events` only; do not model `participantFrames`, which is out of scope and would invite use
    - _Requirements: 1.2, 1.3, 7.2_

  - [ ] 3.3 Implement the parse concurrency gate
    - Bound the number of timeline responses being parsed at once, so transient parse memory does not grow with request volume
    - Make the permit source injectable so the bound is testable without real concurrency
    - _Requirements: 1.4_

  - [ ]* 3.4 Write property test for retention and deletion
    - **Property 5: The raw timeline is never retained, and the slice is deletable**
    - **Validates: Requirements 5.1, 5.2, 5.6**

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement the Build Path Orchestrator
  - [ ] 5.1 Implement `getBuildPath`
    - Derive the platform from the match id prefix and the region through `PLATFORM_TO_REGION` from the `lookup-pipeline-fixes` spec; issue no Region_Resolver call
    - Resolve the Riot ID to a PUUID through the existing cached account path
    - `cacheOrFetch` the Timeline_Slice; a hit must issue no Riot call at all
    - On a miss: take a parse-gate permit, fetch, find the Participant_Slot from the timeline's own `info.participants`, replay, reconcile against the cached match detail, **discard the raw response**, write the slice
    - Return `unavailable` for a missing timeline and for a participant absent from the mapping; never a partial or empty build path
    - _Requirements: 1.1, 1.2, 1.5, 2.5, 5.2, 5.5, 6.2_

  - [ ] 5.2 Implement the unreconciled logging path
    - Record the match identifier and the difference in both directions when a replay does not reconcile, so unhandled item behaviors can be identified from real data rather than guessed at now
    - _Requirements: 4.4_

- [ ] 6. Implement the API layer
  - [ ] 6.1 Implement `GET /api/match/:matchId/build-path`
    - Accept `gameName` and `tagLine` query parameters, validate through the existing Riot ID Validator, and return `200` for both `build_path` and `unavailable`
    - Map error outcomes through the error table in `backend/src/api/errors.ts`; add no new error codes
    - _Requirements: 1.1, 1.5, 6.1_

  - [ ]* 6.2 Write unit tests for the route and orchestrator outcomes
    - Region derived from a match id prefix including lowercase and unknown platforms (1.2); timeline 404 yields `unavailable` and the row still renders (1.5, 6.1); participant absent yields `unavailable` rather than an empty path (6.2); each retriable Riot failure class
    - _Requirements: 1.2, 1.5, 6.1, 6.2_

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement the frontend
  - [ ] 8.1 Implement `BuildPathView`
    - Render each acquisition as an item image with its match-relative time, resolving images and names through the `visual-assets` Static_Data_Provider
    - Classify Component_Items using the item metadata that provider already holds; introduce no second classification source
    - Default to the completed-items view with a toggle revealing the full path including components
    - Render times as `M:SS` from match start, never as a wall-clock timestamp
    - Give every item image a non-empty text alternative, and render an unknown item id with a placeholder and the raw identifier
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.7, 6.3_

  - [ ] 8.2 Wire the Build Path tab
    - Replace the not-yet-available placeholder that `match-detail-tabs` ships in that tab (its Requirement 5.2)
    - Fetch on **tab selection**, not on row expansion — expanding a row and viewing General or Runes must stay request-free, per `match-detail-tabs` Requirement 2.7
    - Never fetch as part of the report load, and never block the report on it
    - Render the loading state, the "build path unavailable" state, and Requirement 4.3's unreconciled caveat **inside the tab**, leaving the match row, its Final_Builds, and the other two tabs intact
    - Leave the lane opponent's Final_Build display untouched, and render no build path for them
    - _Requirements: 1.1, 3.5, 3.6, 3.8, 3.9, 3.10, 4.3, 6.1, 6.4, 7.3_

  - [ ] 8.3 Apply the Riot compliance template
    - Render the expanded view through the existing `RiotDataPage` wrapper (`frontend/src/compliance/RiotDataPage.tsx`) so attribution and the no-advertising default apply without being re-implemented
    - Serve item images unmodified from Riot's distribution, consistent with the asset policy already in force
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 8.4 Write unit tests for the view
    - Completed-items default and component toggle (3.3), `M:SS` rendering (3.4), unknown item placeholder (6.3), unreconciled caveat shown and path still displayed (4.3, 4.5), no build path for the opponent whose Final_Build is unchanged (3.5, 3.6), report never blocked on a build path (6.4), attribution and ad-slot absence (8.1, 8.2)
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 4.3, 4.5, 6.3, 6.4, 8.1, 8.2_

- [ ] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Real-data validation and documentation
  - [ ] 10.1 Measure the reconciliation rate against real matches
    - Replay a sample of real matches across several queue types and record what fraction reconcile
    - Investigate the disagreements and record the item behaviors responsible; extend the reducer only for behaviors actually observed, never for speculated ones
    - _Requirements: 4.1, 4.4_

  - [ ] 10.2 Update the README
    - Document `GET /api/match/:matchId/build-path`, the `timelineSlice` cache entry and its indefinite retention, the parse concurrency bound, and the rule that raw timelines are parsed and discarded rather than cached
    - Record that build paths are retrieved for the analyzed player only and that the lane opponent shows a final build
    - _Requirements: 5.1, 5.4, 1.4, 7.3_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster delivery; they are not implemented by the coding agent by default.
- **This feature depends on the `visual-assets` spec** for the Static_Data_Provider, the item metadata that classifies components, and the `ItemBuild` capture that Reconciliation compares against; and on the **`lookup-pipeline-fixes` spec** for `PLATFORM_TO_REGION`. Both have landed.
- **It also depends on the `match-detail-tabs` spec**, which owns the surface this feature renders into: the Build Path tab of the per-match Detail_Panel, shipped as an explicit not-yet-available placeholder for this feature to replace. Wave 8 cannot land before that tab exists. Nothing earlier in this plan — retrieval, replay, reconciliation, retention — depends on it, so waves 1 through 7 can proceed in parallel with `match-detail-tabs`.
- **Task 1.1 is first and is not optional.** `ITEM_UNDO`'s field polarity is unverified, and task 2.1 encodes it. A reducer built on a guess passes its own tests while producing plausible wrong builds, which is precisely the failure mode this feature is meant to eliminate.
- **Never cache the raw timeline.** A response is 1–5 MB and `InMemoryCacheStore` is an unbounded `Map` with no eviction, so retaining timelines the way match details are retained grows memory without bound. Task 3.1 deliberately adds no cache entry type for them, which makes the rule structural rather than something to remember.
- **A build path is not a filtered list of purchases.** Undone purchases emit no compensating sell, so filtering produces a build containing items the player never owned — and it looks entirely plausible. The replay must be a fold with undo applied as a reversal.
- Sells and destroys remove from the inventory but **not** from the build path. A component absorbed into a completed item is destroyed, and a starting item sold at the first back was still bought; removing either would erase real history.
- **Do not automatically repair an unreconciled build path.** Requirement 4.5 forbids it and task 10.1 is why: the disagreements are the only honest source of information about item behaviors this design does not yet model. Item transforms and in-place upgrades are the suspected causes, but they are suspicions, and encoding a fix for them before task 10.1 would be encoding a guess.
- Property tests use `fast-check` with a minimum of 100 runs each, tagged `// Feature: item-timeline, Property {n}: {property text}`.
- Property 3's generators must interleave undos rather than only trailing them, and Property 2's must include sells and destroys rather than purchases alone. Several existing property tests in `backend/src/` guard coverage with a bare `expect(count).toBeGreaterThan(0)` and no pinned `examples`; do not copy that pattern.
- The rate limit is not a constraint here — 2,000 per 10 seconds against one call per expanded match, fetched once ever. The cost is transient parse memory, which the Rate_Limit_Manager does not model, which is why task 3.3 exists as a separate gate.
- Extracting the lane opponent's build path later requires calling `replayShopEvents` a second time with a different Participant_Slot and retaining a second slice. The reducer is parameterised for this deliberately (Requirement 7.1); nothing in it would need to change.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "3.2", "3.3"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.4"] },
    { "id": 3, "tasks": ["2.6", "5.1"] },
    { "id": 4, "tasks": ["5.2", "6.1"] },
    { "id": 5, "tasks": ["6.2", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3"] },
    { "id": 7, "tasks": ["8.4", "10.1"] },
    { "id": 8, "tasks": ["10.2"] }
  ]
}
```
