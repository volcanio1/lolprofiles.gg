# Implementation Plan: live-game

## Overview

This plan builds the Live Game feature bottom-up, matching how the existing codebase is layered: pure components first and property-tested in isolation, then the I/O components that consume them, then orchestration, then the API layer, then the UI. The Lobby Insight Engine and the Game_Clock derivation are pure and land before anything that calls them; the Participant Enricher and the Live Game Orchestrator are the integration points.

Three things shape the ordering. The feature depends on automatic platform resolution from the `lookup-pipeline-fixes` spec — a live game request takes a Riot ID and no region — so that spec's Region_Resolver must land first. The Static_Data_Provider is a hard prerequisite for rendering rather than a polish item: without it the lobby displays numeric champion IDs, so it is built in the first wave alongside the pure logic. And the cache work comes before the orchestrator, because the 30-second active-game TTL and the rule that negative results are never cached are both properties of `cacheOrFetch` usage rather than of the orchestrator, and testing them afterwards would mean testing them through two layers.

## Tasks

- [ ] 1. Build the pure components and static data
  - [ ] 1.1 Implement the Lobby Insight Engine
    - Pure `computeLobbyInsights(lobby)` returning off-champion PUUIDs, one-trick PUUIDs and the rank spread, with the 10,000 and 200,000 mastery thresholds as named constants
    - Return a null rank spread when fewer than two participants hold a ranked entry in the game's queue
    - Take no client, no clock and no I/O, so a further Riot call is not expressible
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 1.2 Write property test for lobby insights
    - **Property 4: Lobby insights are pure and match their defined conditions exactly**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**
    - Bias the mastery arbitraries toward the thresholds and pin both boundaries and their off-by-one neighbours with `fc.assert`'s `examples`, so the test cannot pass without exercising them

  - [ ] 1.3 Implement the Game_Clock derivation
    - Pure `elapsedMs(gameStartTime, now)` clamped at zero, and a Pre_Game predicate for an absent or zero start timestamp
    - _Requirements: 4.1, 4.2, 4.4_

  - [ ]* 1.4 Write property test for the game clock
    - **Property 3: Game clock is derived and never negative**
    - **Validates: Requirements 4.1, 4.2, 4.4**

  - [ ] 1.5 Extend the Static Data Provider
    - Build the numeric-champion-id to Champion_Key reverse index from `champion.json`'s existing `key` field; Spectator-V5 reports champions numerically while Match-V5 reports a key
    - Add summoner-spell and rune name and icon resolution
    - Keep every accessor total in the provider's existing sense — a URL or `null`, a name or the raw identifier — and inherit its version pinning, retention and Rate_Limit_Manager exclusion unchanged
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 2. Extend the Riot API Client and Cache Store
  - [ ] 2.1 Add the three new client methods
    - `getActiveGameByPuuid`, `getAccountByPuuid`, and `getChampionMastery`, each reserving a rate-limit slot, applying the 10s timeout, honouring the 429 retry policy, and mapping onto the existing `RiotApiResult` variants
    - _Requirements: 1.1, 1.4, 2.1, 2.2, 2.3_

  - [ ] 2.2 Add the `activeGame` and `championMastery` cache entry types
    - `activeGame` keyed on `{ puuid, platform }` with a 30-second TTL; `championMastery` keyed on `{ puuid, platform, championId }` with a 1-hour TTL
    - Leave the existing `account` and `league` retentions untouched — enrichment must not inherit the live TTL
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 2.3 Write property test for deletion coverage of the new entry types
    - **Property 5: Deletion removes the subject from every cached lobby**
    - **Validates: Requirements 6.5, 6.6**
    - Generate cache states in which the PUUID appears as the keyed player, as a participant inside another player's cached lobby, and both

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement the Participant Enricher
  - [ ] 4.1 Implement `enrichAll`
    - Dispatch each participant's three enrichment calls concurrently, each wrapped in the `enrich<T>() => T | null` helper from `lookup-pipeline-fixes`, so the enricher has no failure mode of its own
    - Return exactly one card per input participant, in input order, with absent fields where a call failed
    - Skip every enrichment call for participants flagged as bots
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 4.2 Write property test for enrichment isolation
    - **Property 2: Enrichment failure degrades a field, never a card or a lobby**
    - **Validates: Requirements 2.4, 2.5, 2.6**

- [ ] 5. Implement the Live Game Orchestrator
  - [ ] 5.1 Implement `getLiveGame`
    - Resolve the Riot ID to a PUUID and Resolved_Platform via the Region_Resolver; ask the visitor for no region
    - `cacheOrFetch` the active game against the 30-second entry; short-circuit a `not_found` to `not_in_game` **without** writing a negative cache entry
    - Assemble the lobby, derive `matchId` as `{platformId}_{gameId}`, and run the Lobby Insight Engine over it
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 5.3, 6.2_

  - [ ]* 5.2 Write property test for the not-in-game state
    - **Property 1: Not-in-game is a state and never an error**
    - **Validates: Requirements 1.2, 6.2**

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement the API layer
  - [ ] 7.1 Implement `GET /api/live-game`
    - Accept `gameName` and `tagLine` query parameters, validate them through the existing Riot ID Validator, and return `200` for both `in_game` and `not_in_game`
    - Map error outcomes through the error table in `backend/src/api/errors.ts`; add no new error codes beyond those inherited from region resolution
    - _Requirements: 1.2, 1.3, 1.5_

  - [ ]* 7.2 Write unit tests for the route's outcome mapping
    - Cover `in_game`, `not_in_game`, a validation rejection, and each retriable Riot failure class
    - _Requirements: 1.2, 1.3, 1.4_

- [ ] 8. Implement the frontend
  - [ ] 8.1 Implement the Live Game view and Participant Cards
    - Render the ten cards with champion, spells, runes and team, resolved through the Static_Data_Provider, with absent enrichment fields rendered blank rather than as zeros
    - Render bot participants and unranked participants distinctly from failed enrichment
    - _Requirements: 1.3, 2.4, 2.5, 2.6, 7.1, 7.5_

  - [ ] 8.2 Implement the lobby insight display
    - Surface off-champion and one-trick flags on the relevant cards and the rank spread on the lobby header; omit the spread entirely when it is null
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [ ] 8.3 Implement the local game clock
    - Tick from `gameStartTime` without issuing a request; render Pre_Game when the timestamp is absent or zero; never render a negative value
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ] 8.4 Implement polling and the game-ended state
    - Re-request no more often than every 30 seconds while mounted, stop on unmount, and switch to a game-ended state when a previously displayed lobby returns not-in-game
    - Offer a link to the finished match, and display "results not yet available" rather than an error when Match-V5 has not yet published it
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ] 8.5 Apply the Riot compliance template
    - Render the live game page through the existing `RiotDataPage` wrapper (`frontend/src/compliance/RiotDataPage.tsx`) so attribution and the no-advertising default apply without being re-implemented
    - Display no participant identifier beyond the Riot ID Riot itself exposes
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 8.6 Write unit tests for the view
    - Pre_Game rendering (4.2), bot and unranked rendering (2.5, 2.6), game-ended state and match link (5.2, 5.3), not-yet-published message (5.4), static data fallback (7.5), attribution and ad-slot absence (8.1, 8.2), poll stops on unmount (5.5)
    - _Requirements: 2.5, 2.6, 4.2, 5.2, 5.3, 5.4, 5.5, 7.5, 8.1, 8.2_

- [ ] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Integration
  - [ ]* 10.1 Write integration test for a mixed lobby
    - Full assembly against a mocked Riot API with one bot, one unranked participant, one participant whose League-V4 call fails, one one-trick and one off-champion; assert `200`, ten cards in order, and the expected insight set
    - _Requirements: 1.3, 2.4, 2.5, 2.6, 3.2, 3.3, 3.4_

  - [ ] 10.2 Update the README
    - Document the `GET /api/live-game` endpoint, the pinned Data Dragon version and how to bump it, and the new cache entry types with their TTLs
    - _Requirements: 6.1, 6.4, 7.3_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

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
