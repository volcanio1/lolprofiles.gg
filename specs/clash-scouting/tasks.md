# Implementation Plan: clash-scouting

## Overview

This plan builds the Clash scouting report bottom-up, matching how the existing codebase is layered: the pure Scouting Insight Engine is built and property-tested in isolation before anything calls it, then the client and cache extensions, then the Roster Enricher, then the orchestrator, then the API and UI.

Two ordering decisions are not stylistic. The Tournament Refresher and the `ClashTournamentSource` split land in the first wave, before the orchestrator exists — the split is what makes a request-path call to the 10-per-minute tournaments endpoint a compile error rather than a review finding, and introducing it after the orchestrator has been written means retrofitting a dependency boundary instead of building against one. And the Roster Enricher's Recent_Form bound is implemented with the enricher rather than added later, because an unbounded first version would fan out to roughly 500 Match-V5 calls per report and would be the kind of thing that works in tests and hurts in production.

The feature depends on the `lookup-pipeline-fixes` spec for automatic platform resolution and the `enrich<T>()` helper, and on the `live-game` spec for the champion mastery cache entry and the Static_Data_Provider used to render champion names in the ban list.

## Tasks

- [ ] 1. Build the pure engine and the tournament boundary
  - [ ] 1.1 Implement the Scouting Insight Engine
    - Pure `computeScoutingInsights(report)` returning ban recommendations, position mismatches and stack cohesion, with the 5-recommendation cap as a named constant
    - Implement the ban order as the declared total order: recent wins descending, then mastery points descending, then recent games descending, then champion id ascending — the final key is what makes the order total rather than merely a sort
    - Skip position-mismatch flagging for members declared UNSELECTED or FILL, and for members with an empty Recent_Form
    - Take no client, no clock and no I/O, so a further Riot call is not expressible
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ]* 1.2 Write property test for scouting insights
    - **Property 4: Scouting insights are pure and follow their defined orders exactly**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
    - Draw champion ids and mastery values from small ranges to force ties, and pin at least one case tied through to the champion-id tie-break with `fc.assert`'s `examples`, so the last two order keys cannot go unexercised

  - [ ] 1.3 Introduce the `ClashTournamentSource` boundary
    - Define `ClashTournamentSource` as an interface separate from `RiotApiClient`, holding `getClashTournaments` alone
    - Ensure the Scouting Orchestrator's dependency type does not include it, so a request-path call fails to compile
    - _Requirements: 4.1_

  - [ ] 1.4 Implement the Tournament Refresher
    - Refresh the Tournament_Schedule on the injected scheduler at no more than once per interval, writing into the Cache_Store rather than holding its own state
    - Default the interval to 5 minutes; retain the schedule entry for 1 hour
    - _Requirements: 4.1, 4.2, 5.4_

- [ ] 2. Extend the Riot API Client and Cache Store
  - [ ] 2.1 Add the Clash-V1 and mastery client methods
    - `getClashPlayersByPuuid`, `getClashTeam`, `getClashTournamentsByTeam`, and `getChampionMasteryTop`, each reserving a rate-limit slot, applying the 10s timeout, honouring the 429 retry policy, and mapping onto the existing `RiotApiResult` variants
    - Keep `getClashTournaments` on `ClashTournamentSource` only; do not add it here
    - _Requirements: 1.2, 1.4, 1.6, 2.3, 4.5_

  - [ ] 2.2 Add the Clash cache entry types
    - `clashPlayers` keyed on `{ puuid, platform }` at 5 minutes, `clashTeam` keyed on `{ teamId, platform }` at 5 minutes, and `tournamentSchedule` keyed on `{ platform }` at 1 hour
    - Reuse the existing `championMasteryTop`, `account`, `league`, `matchIds` and `matchDetail` retentions unchanged
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 2.3 Write property test for deletion coverage of the Clash entry types
    - **Property 5: Deletion removes the subject from every Clash entry**
    - **Validates: Requirement 5.6**
    - Generate cache states in which the PUUID appears as the keyed player of a registration, as a roster member of a cached team, and both

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement the Roster Enricher
  - [ ] 4.1 Implement `enrichAll`
    - Dispatch each member's account, league and top-mastery calls concurrently, each wrapped in the `enrich<T>() => T | null` helper from `lookup-pipeline-fixes`
    - Retrieve Recent_Form bounded at 10 matches per member, excluding individually-failed match retrievals and continuing, exactly as `backend/src/orchestrator/index.ts` already does when assembling a Profile Report
    - Return exactly one card per roster member, in roster order, with absent fields where a call failed
    - Derive each member's Observed_Role from their Recent_Form, leaving it null when the window is empty
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 4.2 Write property test for roster enrichment isolation
    - **Property 3: Roster enrichment failure degrades a field, never a member or a report**
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7**

- [ ] 5. Implement the Scouting Orchestrator
  - [ ] 5.1 Implement `scout`
    - Resolve the Riot ID to a PUUID and Resolved_Platform via the Region_Resolver; ask the visitor for no region
    - `cacheOrFetch` the player's Clash registrations; return `not_registered` for an empty array and for a teams-endpoint 404 on a referenced team id
    - Return `multiple_teams` when the player holds more than one registration and no `teamId` was supplied
    - Read the Tournament_Schedule from cache only; on a miss or a stale entry set `tournament: null` and continue rather than blocking
    - Assemble the report and run the Scouting Insight Engine over it
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.3, 4.4, 4.5_

  - [ ]* 5.2 Write property test for the not-registered state
    - **Property 1: No active Clash registration is a state and never an error**
    - **Validates: Requirement 1.3**

  - [ ]* 5.3 Write property test for the tournament endpoint boundary
    - **Property 2: The tournaments endpoint is never called on a request path**
    - **Validates: Requirements 4.1, 4.3, 4.4**
    - Hand the orchestrator a `ClashTournamentSource` fake that fails the test on any invocation, and generate request sequences across every Tournament_Schedule cache state including absent and stale

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement the API layer
  - [ ] 7.1 Implement `GET /api/clash/scout`
    - Accept `gameName`, `tagLine` and an optional `teamId`, validate the Riot ID through the existing validator, and return `200` for `report`, `multiple_teams` and `not_registered` alike
    - Map error outcomes through the error table in `backend/src/api/errors.ts`; add no new error codes beyond those inherited from region resolution
    - _Requirements: 1.1, 1.3, 1.5_

  - [ ]* 7.2 Write unit tests for the route's outcome mapping
    - Cover `report`, `multiple_teams`, `not_registered`, a validation rejection, and each retriable Riot failure class
    - _Requirements: 1.3, 1.5, 1.6_

- [ ] 8. Implement the frontend
  - [ ] 8.1 Implement the scouting search and team selector
    - Accept a Riot ID alone, render the not-registered state as a state rather than an error, and render a team picker when the player holds more than one registration
    - _Requirements: 1.1, 1.3, 1.5_

  - [ ] 8.2 Implement the roster display
    - Render five Roster_Cards with declared position, captain marker, rank, champion pool and recent form, with absent enrichment fields rendered blank rather than as zeros, and unranked members rendered as unranked
    - Resolve champion names and images through the Static_Data_Provider defined in the `visual-assets` spec
    - _Requirements: 2.5, 2.7_

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

- [ ] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Integration and wiring
  - [ ] 10.1 Wire the Tournament Refresher into the composition root
    - Start the refresher with the real scheduler and clock at application start, and stop it on shutdown
    - Confirm the Scouting Orchestrator is constructed without a `ClashTournamentSource` reference
    - _Requirements: 4.1, 4.2_

  - [ ]* 10.2 Write integration test for a full scouting report
    - Five-member roster against a mocked Riot API containing one member whose League-V4 call fails, one whose Recent_Form has two individually-failing matches, one declared FILL, and two members appearing together in the same matches
    - Assert `200`, five cards in roster order, a ban list of at most 5 in the declared order, exactly one position mismatch, and the expected stack cohesion
    - _Requirements: 2.5, 2.6, 3.2, 3.3, 3.4, 3.5, 3.7_

  - [ ] 10.3 Update the README
    - Document the `GET /api/clash/scout` endpoint, the new cache entry types and their TTLs, the background Tournament Refresher and its interval, and the fact that Riot exposes no bracket so a report is addressed by naming any player on the team
    - _Requirements: 4.1, 4.2, 5.1_

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
