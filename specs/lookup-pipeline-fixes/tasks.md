# Implementation Plan: lookup-pipeline-fixes

## Overview

This plan replaces guessed platform routing with resolved platform routing, and demotes Summoner-V4 from a pipeline dependency to a non-blocking enrichment call. The two changes are sequenced deliberately: the Summoner-V4 404 is currently the sensor that detects a wrong-region lookup, so it cannot be demoted until automatic platform resolution has made that condition unreachable. Every task below that touches Summoner-V4 therefore depends on the resolver landing first.

The plan opens with a live verification task rather than with code. Two load-bearing assumptions in the design — the casing of the platform value Account-V1 returns, and how the endpoint behaves for a Riot account that has never played League — are flagged in design.md as unverified. Building the normalisation and error mapping before confirming them would mean writing tests that encode a guess.

Work proceeds bottom-up, matching how the existing codebase is layered: the pure reverse mapping is built and property-tested in isolation, then the resolver that consumes it, then the orchestrator wiring, then the API contract change, then the frontend. The frontend and backend halves of the response-shape change land in the same wave, because `summonerLevel` moving from `number` to `number | null` breaks the shared contract the moment either side ships alone.

## Tasks

- [ ] 1. Confirm the Riot API contract and build the reverse mapping
  - [ ] 1.1 Verify Account-V1 region-by-game-by-puuid against the live API
    - Call the endpoint for a known PUUID and record the exact response shape and the casing of the `region` field
    - Call it for a Riot account with no League of Legends play history and record the status and body
    - Write the findings into design.md's Testing Strategy section, replacing the "unverified" note with the observed behavior
    - _Requirements: 1.1, 3.4, 5.2_

  - [ ] 1.2 Implement the Platform-to-Region map
    - Derive `PLATFORM_TO_REGION` from the existing `REGION_TO_PLATFORMS` at module load rather than declaring a second literal, so the two cannot drift
    - Implement `regionForPlatform`, `isSupportedPlatform`, and `normalisePlatform` using the casing confirmed in 1.1
    - _Requirements: 3.1, 3.2, 3.4_

  - [ ]* 1.3 Write property test for the reverse mapping
    - **Property 1: Platform-to-region mapping is the exact inverse of the region-to-platform mapping**
    - **Validates: Requirements 3.1, 3.2**

- [ ] 2. Implement the Region Resolver
  - [ ] 2.1 Add `getRegionByPuuid` to the Riot API Client
    - Route against the configured Discovery_Region host, attach the API key, apply the 10s timeout, reserve a rate-limit slot, and honour the existing 429 retry policy
    - Map HTTP responses onto the existing `RiotApiResult` variants; add no new transport path
    - _Requirements: 1.1, 1.5, 1.6_

  - [ ] 2.2 Add the `accountRegion` cache endpoint
    - Extend `CacheEndpoint` with `accountRegion`, key it on `{ puuid, game }`, and give it a 24-hour TTL in the retention policy
    - _Requirements: 6.1, 6.2_

  - [ ] 2.3 Implement `RegionResolver.resolve`
    - Go through `cacheOrFetch` against `accountRegion` so a non-stale entry issues no Riot call
    - Return `resolved` / `no_lol_account` / `unsupported_platform` / `failed`, normalising the platform and reverse-mapping it through `regionForPlatform`
    - _Requirements: 1.1, 1.2, 1.3, 3.3, 5.2, 6.3_

  - [ ]* 2.4 Write property test for region resolution caching
    - **Property 4: Region resolution is cached and a cache hit issues no resolver call**
    - **Validates: Requirements 6.2, 6.3**

  - [ ]* 2.5 Write property test for deletion coverage of the new entry type
    - **Property 5: Deletion removes the region-resolution entry**
    - **Validates: Requirement 6.4**

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Wire resolution into the orchestrator
  - [ ] 4.1 Replace guessed routing with resolved routing in `runLookup`
    - Drop `region` from `LookupInput`, add the optional `platformOverride`, and insert the resolver call between account resolution and the parallel fan-out
    - Route League-V4 and Summoner-V4 with the Resolved_Platform and Match-V5 with the Derived_Region
    - Remove the `PLAYER_NOT_ON_PLATFORM` code and its Summoner-404 detection branch; add `NO_LOL_ACCOUNT` and `UNSUPPORTED_PLATFORM`
    - Do not fall back to a guessed platform when the resolver fails — surface the underlying retriable error instead
    - _Requirements: 1.2, 1.3, 1.4, 2.4, 3.3, 5.1, 5.2, 5.3, 5.4, 7.2, 7.4_

  - [ ]* 4.2 Write property test for downstream routing
    - **Property 2: Resolved platform determines all downstream routing**
    - **Validates: Requirements 1.2, 1.3, 1.4**

  - [ ] 4.3 Demote Summoner-V4 to an enrichment call
    - Add the `enrich<T>()` helper returning `T | null` with no error channel, and route the Summoner-V4 call through it
    - Make `summonerLevel` and `profileIconId` nullable on `ProfileReport`; add `resolvedPlatform` and `usedPlatformOverride`
    - Dispatch the enrichment call alongside the required set without awaiting it as a precondition for assembling the report
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 2.3, 2.4, 7.3_

  - [ ]* 4.4 Write property test for enrichment isolation
    - **Property 3: Summoner-V4 outcome never changes lookup classification**
    - **Validates: Requirements 4.1, 4.2, 4.5**

- [ ] 5. Update the API layer and frontend together
  - [ ] 5.1 Update `POST /api/lookup` request and response contracts
    - Accept `{ gameName, tagLine, platformOverride? }`; reject `region` and `platform` as unknown fields rather than silently ignoring them
    - Map `NO_LOL_ACCOUNT` and `UNSUPPORTED_PLATFORM` into the error table with their statuses, messages and `retriable: false`
    - _Requirements: 2.1, 2.4, 5.2, 5.4, 3.3_

  - [ ] 5.2 Update the frontend contract, search UI, and report view
    - Remove the region and platform selectors and their state from the search form; submit the Riot ID alone
    - Do not expose the diagnostic `platformOverride` anywhere in the default search interface
    - Mirror the nullable `summonerLevel` / `profileIconId` types and render a neutral placeholder for each absent value
    - Display `resolvedPlatform` on the report so the visitor can see which server answered
    - Add error displays for `NO_LOL_ACCOUNT` and `UNSUPPORTED_PLATFORM`; remove the `PLAYER_NOT_ON_PLATFORM` display
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 4.3, 5.2, 5.4_

  - [ ] 5.3 Update the cross-workspace parity guard
    - The frontend's copy of the region mapping is no longer used for routing, but `REGION_TO_PLATFORMS` remains load-bearing for the reverse map; update `frontend/src/domain/parity.test.ts` so it still guards the mapping and the error-code set, and so it fails if the removed `PLAYER_NOT_ON_PLATFORM` code reappears on one side only
    - _Requirements: 7.5, 5.4_

  - [ ]* 5.4 Write unit tests for the revised UI and error content
    - Absence of the region and platform selectors (2.2), placeholder rendering for null enrichment fields (4.3), `resolvedPlatform` display (2.3), `NO_LOL_ACCOUNT` and `UNSUPPORTED_PLATFORM` message content (5.2, 3.3)
    - _Requirements: 2.2, 2.3, 3.3, 4.3, 5.2_

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Integration and documentation
  - [ ]* 7.1 Write integration test for the cross-region case
    - Full lookup, against a mocked Riot API, for a player whose Resolved_Platform belongs to a different region than the historical `americas` default — the exact shape that produced Finding A — asserting a 200 and a complete report
    - Assert that a resolver failure issues no platform-routed call at all, proving the no-fallback rule
    - _Requirements: 1.2, 1.3, 5.3_

  - [ ] 7.2 Update the README and the module documentation
    - Update the README's API section for the changed `POST /api/lookup` request shape, the nullable `summonerLevel` / `profileIconId`, and the removed region selector
    - Fix the README's project-layout entry, which still points at a `.kiro/specs/` path that does not exist
    - Update the header comments in `backend/src/orchestrator/index.ts` and `backend/src/api/errors.ts` that describe region selection and `PLAYER_NOT_ON_PLATFORM`, so the code stops documenting behavior it no longer has
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster delivery; they are not implemented by the coding agent by default.
- Task 1.1 is deliberately first and is not optional. Design.md flags the platform casing and the no-League-account behavior as unverified; tasks 1.2 and 4.1 encode both, so verifying them afterwards would mean rewriting tests rather than writing them once.
- Task 4.3 must not be started before 4.1 lands. The Summoner-V4 404 is the current detector for the wrong-region condition, so demoting the call first would remove the sensor while the condition is still reachable, turning a loud error into a silently empty report.
- Tasks 5.1 and 5.2 must land together. `summonerLevel` changing from `number` to `number | null` and the removal of `region` from the request body are both breaking contract changes, and shipping either side alone breaks the running application.
- Property tests use `fast-check` with a minimum of 100 runs each, tagged `// Feature: lookup-pipeline-fixes, Property {n}: {property text}`.
- The existing region property test (`backend/src/region/index.property.test.ts`) is a precondition for this spec's Property 1: the inversion in task 1.2 is only a function because `REGION_TO_PLATFORMS`'s platform lists are pairwise disjoint, which is what that test asserts. It must keep passing; do not weaken it.
- Adding one sequential round trip to the fresh path is accepted rather than optimised away. It is bounded by the existing 10s per-call timeout, sits inside the 15s fresh-path budget, and is skipped entirely on the 24-hour cached path.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.2"] },
    { "id": 2, "tasks": ["1.3", "2.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3"] },
    { "id": 5, "tasks": ["4.4", "5.1", "5.2"] },
    { "id": 6, "tasks": ["5.3", "5.4", "7.1"] },
    { "id": 7, "tasks": ["7.2"] }
  ]
}
```
