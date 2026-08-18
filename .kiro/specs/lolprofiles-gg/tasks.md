# Implementation Plan: lolprofiles.gg

## Overview

This plan implements lolprofiles.gg as a TypeScript/Node.js backend API plus a React frontend, following the design's component boundaries: Riot ID Validator, Region Router, Cache Store, Rate Limit Manager, Riot API Client, Lookup Orchestrator, Insight Engine, API layer, and frontend UI. Pure/computational components (validator, region router, cache TTL logic, rate limiter math, insight engine) are built and property-tested in isolation before being wired into the orchestrator, which is the integration point for cache-or-fetch behavior and error handling. The plan also resolves an open design gap: cached match-detail entries carry participant PUUIDs, so the deletion feature must scrub PUUIDs from cached match details rather than only excluding match details from deletion, in order to fully satisfy Requirements 12.4 and 12.5.

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Tasks

- [x] 1. Set up project scaffolding
  - [x] 1.1 Scaffold backend Node.js/TypeScript API project
    - Initialize TypeScript project with Express (or equivalent), Vitest (or Jest) test runner, and `fast-check` as a dev dependency
    - Set up `tsconfig.json`, lint/format config, and a `src/` layout with folders for `validator`, `region`, `cache`, `rateLimit`, `riotApiClient`, `orchestrator`, `insight`, `api`
    - Add an environment-based config module for the Riot API key (never hardcoded, never logged)
    - _Requirements: 4.1, 4.2_

  - [x] 1.2 Scaffold frontend React application
    - Initialize React + TypeScript SPA project with a test runner (Vitest/Jest + React Testing Library)
    - Set up a basic routing/page structure (search page, profile report page) and an API base URL config pointing at the backend
    - _Requirements: 1.1_

- [x] 2. Implement Riot ID Validator
  - [x] 2.1 Implement `validateRiotId`
    - Pure function enforcing exactly one `#`, non-empty trimmed gameName/tagLine, gameName ≤16 chars, tagLine ≤5 chars, returning typed error codes on rejection
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

  - [x]* 2.2 Write property test for Riot ID Validator
    - **Property 1: Riot ID validator accepts exactly well-formed inputs**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5**

- [x] 3. Implement Region Router
  - [x] 3.1 Implement `isValidRegion`, `platformsFor`, `resolvePlatform` and the closed `REGION_TO_PLATFORMS` mapping
    - Pure functions implementing the exact region/platform sets and fallback-to-first-platform behavior
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 3.2 Write property test for Region Router
    - **Property 3: Region-to-platform mapping is closed and consistently applied**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Cache Store
  - [x] 5.1 Implement `CacheStore` interface, `CacheKey`/`CacheEntry` types, and an in-memory implementation with deterministic key hashing and TTL/staleness logic
    - Implement `get`, `set` with per-endpoint TTL semantics (account/summoner: 1h, league: 10min, matchDetail: infinite)
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x]* 5.2 Write property test for cache key determinism
    - **Property 16: Cache key construction is deterministic and injective over its inputs**
    - **Validates: Requirements 10.1**

  - [x]* 5.3 Write property test for cache TTL staleness
    - **Property 17: Cache TTL staleness matches configured retention per endpoint type**
    - **Validates: Requirements 10.2, 10.3, 10.4**

  - [x] 5.4 Implement `deleteByPuuid` with match-detail PUUID scrubbing
    - Update the design document's Caching Strategy section: replace the note that match-detail entries are excluded from deletion with a description of scrubbing participant PUUID data from cached match details on deletion, so match details remain cached (immutable, non-PII) but no longer contain the requester's PUUID-linked participant data
    - Implement `deleteByPuuid` to (a) remove all cache entries directly keyed by the PUUID (summoner, league, matchIds) and (b) scan cached `matchDetail` entries and anonymize/scrub any participant record matching the given PUUID (e.g. redact PUUID and any PUUID-derived identifying fields) in place, without evicting the match detail entry itself
    - _Requirements: 12.4, 12.5_

  - [x]* 5.5 Write property test for deletion idempotency and scrubbing completeness
    - **Property 20: Deletion requests are idempotent and always answered**
    - **Validates: Requirements 12.4, 12.5, 12.6**

- [x] 6. Implement Rate Limit Manager
  - [x] 6.1 Implement `RateLimitManager.reserveSlot` and `recordResponseHeaders`
    - Track per-routing-value, per-method app-level and method-level windows from `X-App-Rate-Limit`/`X-App-Rate-Limit-Count` and `X-Method-Rate-Limit`/`X-Method-Rate-Limit-Count` headers; delay when required wait ≤30s, throw `RateLimitExceededError` otherwise
    - _Requirements: 4.3, 4.4, 4.5_

  - [x]* 6.2 Write property test for Rate Limit Manager
    - **Property 7: Rate limit reservation never permits exceeding the tracked window, and never blocks longer than 30 seconds**
    - **Validates: Requirements 4.3, 4.4, 4.5**

- [x] 7. Implement Riot API Client
  - [x] 7.1 Implement `RiotApiClient` methods for Account-V1, Summoner-V4, League-V4, Match-V5 (match-ids-by-puuid and match-by-id)
    - Attach API key header, apply 10s per-call timeout, route every call through `RateLimitManager.reserveSlot`, map HTTP responses to the `RiotApiResult` variants (`ok`, `not_found`, `rate_limited`, `server_error`, `auth_error`, `timeout`, `network_error`)
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 3.1, 3.2, 4.1_

  - [x] 7.2 Implement 429 retry-with-backoff logic
    - Wait `Retry-After` seconds if present, else 5 seconds; retry up to 2 attempts; report rate-limited after exhausting retries
    - _Requirements: 4.6, 4.7, 4.8_

  - [x]* 7.3 Write property test for 429 retry bounds
    - **Property 8: 429 retry wait and retry count are bounded correctly**
    - **Validates: Requirements 4.6, 4.7, 4.8**

  - [x]* 7.4 Write property test for API key non-exposure
    - **Property 6: API key is never present in any client-facing output**
    - **Validates: Requirements 4.2, 9.5**

  - [x]* 7.5 Write integration tests for endpoint wiring against a mocked Riot API
    - Verify correct endpoint URLs, routing values, and parameters for Account-V1/Summoner-V4/League-V4/Match-V5 calls, and API key header attachment
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 4.1_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement Insight Engine: Stats
  - [x] 9.1 Implement `computeStats` (ranked-by-queue with Unranked fallback, win rate, average KDA, top champions, most-played role)
    - _Requirements: 2.8, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x]* 9.2 Write property test for win rate and KDA formulas
    - **Property 9: Win rate and KDA formulas are computed correctly, including zero-denominator cases**
    - **Validates: Requirements 6.2, 6.3, 6.6, 6.7**

  - [x]* 9.3 Write property test for top-champion ranking
    - **Property 10: Top-champion ranking follows the specified total order**
    - **Validates: Requirements 6.4**

  - [x]* 9.4 Write property test for most-played role tie-break
    - **Property 11: Most-played role tie-break uses chronological recency**
    - **Validates: Requirements 6.5**

- [x] 10. Implement Insight Engine: Fun Facts
  - [x] 10.1 Implement `computeFunFacts` (time-of-day windows, win/loss streaks, champion loyalty, role preference, limited-data eligibility rules)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x]* 10.2 Write property test for time-of-day window derivation
    - **Property 12: Time-of-day window derivation reports all tied windows**
    - **Validates: Requirements 7.1**

  - [x]* 10.3 Write property test for streak computation
    - **Property 13: Win/loss streak lengths are computed correctly**
    - **Validates: Requirements 7.2**

  - [x]* 10.4 Write property test for fun fact eligibility and category uniqueness
    - **Property 14: Fun fact eligibility, category uniqueness, and limited-data exclusion hold together**
    - **Validates: Requirements 7.4, 7.5, 7.6**

- [x] 11. Implement Insight Engine: Recommendations
  - [x] 11.1 Implement `computeRecommendations` (survivability, champion selection, vision control triggers, with metric name/value attached)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x]* 11.2 Write property test for recommendation triggers
    - **Property 15: Improvement recommendation triggers match their defined conditions exactly**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement Lookup Orchestrator
  - [x] 13.1 Implement the generic `cacheOrFetch` helper
    - Return cached value when non-stale without invoking fetch; on stale/absent, fetch and only write cache on success; swallow cache-write failures without failing the caller
    - _Requirements: 10.5, 10.6, 10.7, 10.8_

  - [x]* 13.2 Write property test for cache-hit short-circuit behavior
    - **Property 18: Non-stale cache entries are served without invoking the Riot API client**
    - **Validates: Requirements 10.5**

  - [x]* 13.3 Write property test for refresh success/failure semantics
    - **Property 19: Cache refresh either fully succeeds or leaves prior state untouched**
    - **Validates: Requirements 10.6, 10.7, 10.8**

  - [x] 13.4 Implement `runLookup` pipeline
    - Wire validator output through account resolution, parallel summoner/league/match-history fetch via `cacheOrFetch`, queue-type filtering, Insight Engine invocation, and error-code mapping per the Requirement 9 error table; implement the 15s fresh-path budget fallback to last-known cache with `partialDataWarning`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 7.3, 9.3, 9.4, 9.5, 9.8, 9.9, 11.3, 11.4, 11.5_

  - [x]* 13.5 Write property test for not-found/partial-failure halting
    - **Property 2: Account-not-found halts the pipeline and leaves no partial state**
    - **Validates: Requirements 2.4, 2.7, 3.6**

  - [x]* 13.6 Write property test for match filtering and limited-data notice
    - **Property 5: Match fetch failures and disallowed queue types are excluded without halting processing**
    - **Validates: Requirements 3.3, 3.4, 3.5**

  - [x]* 13.7 Write property test for unranked-queue handling
    - **Property 4: Unranked queues never treated as failures**
    - **Validates: Requirements 2.8, 6.1**

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement API layer
  - [x] 15.1 Implement `POST /api/lookup` route
    - Validate input via Riot ID Validator, invoke `LookupOrchestrator.runLookup`, map `LookupResult` to HTTP status/body (400/404/5xx/200) with default region handling
    - _Requirements: 1.6, 2.4, 5.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 9.9, 11.4, 11.5_

  - [x] 15.2 Implement `POST /api/privacy/delete` route
    - Wire to `CacheStore.deleteByPuuid` (including PUUID scrubbing from match details) and return the `{ found, deletedAt }` confirmation
    - _Requirements: 12.5, 12.6_

  - [x]* 15.3 Write unit tests for error response content
    - Cover 404 not-found message content, timeout message, generic auth-failure message, network-error message, and rate-limit cooldown response
    - _Requirements: 9.2, 9.4, 9.5, 9.8, 9.9_

  - [x]* 15.4 Write integration test for the deletion endpoint
    - Verify found/not-found confirmation semantics and idempotent re-deletion
    - _Requirements: 12.5, 12.6_

- [x] 16. Implement frontend
  - [x] 16.1 Implement search UI with inline validation feedback
    - Riot ID input, submit handling, field-specific validation error display
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 9.1_

  - [x] 16.2 Implement region/platform selector
    - Region dropdown defaulting to `americas`, platform choices restricted to the selected region's mapping
    - _Requirements: 1.6, 1.7, 5.3_

  - [x] 16.3 Implement API client hook and loading indicator lifecycle
    - Call `/api/lookup`, set `loading = true` on dispatch and `false` in a `finally` covering success/error/timeout
    - NOTE: the client is implemented and tested, but a browser cannot yet reach the backend cross-origin — no CORS headers and no dev proxy. Resolving that belongs to 18.1; see the implementation log's Finding C.
    - _Requirements: 9.6, 9.7_

  - [x] 16.4 Implement Profile Report view
    - Render stats, fun facts, recommendations, average match duration, limited-data notice, the `partialDataWarning` staleness indication, and last-updated timestamp with "first retrieval" fallback when absent
    - _Requirements: 3.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.5, 11.3, 11.4, 11.5_

  - [x] 16.5 Implement error state displays
    - Render distinct messages for validation, not-found, Riot-unavailable (with bounded manual retry up to 3), timeout, auth-failure (generic), rate-limited (with ≥5s cooldown before retry), and network-error states
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 9.9_

  - [x] 16.6 Implement attribution banner and no-ads enforcement
    - Display the required attribution statement on every page rendering Riot data; ensure the page template excludes ad/sponsored-content slots by default, with an explicit override path reserved for an approved-agreement exception
    - _Requirements: 12.1, 12.2, 12.3_

  - [x]* 16.7 Write unit tests for frontend content and region selector
    - Region selector content per selected region (1.7), attribution text presence (12.1), absence of ad slots on Riot-data pages (12.2), approved-agreement exception path (12.3)
    - _Requirements: 1.7, 12.1, 12.2, 12.3_

- [x] 17. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Final integration and end-to-end wiring
  - [ ] 18.1 Wire the backend application entrypoint and frontend-to-backend integration
    - Assemble Cache Store, Rate Limit Manager, Riot API Client, Lookup Orchestrator, Insight Engine, and API routes into the Express app; point the frontend's API client at the backend base URL via config
    - NOTE: the backend half of this landed early at task 15, because `createApp` requires its dependencies and the build could not compile without a composition root. What remains here is the frontend-to-backend integration and end-to-end verification.
    - _Requirements: 4.2_

  - [ ]* 18.2 Write end-to-end integration tests
    - Full successful lookup path against a mocked Riot API (validation through Profile_Report rendering) and a full deletion flow (cache populate → delete → verify scrubbed/removed)
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 12.5, 12.6_

- [ ] 19. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP; they are not implemented by the coding agent by default.
- Task 5.4 also updates design.md's Caching Strategy section to reflect PUUID scrubbing of cached match details on deletion, closing the gap where Requirement 12.4/12.5 previously relied on match details being merely "non-PII once stripped of PUUID association" without a concrete scrubbing mechanism.
- Property tests use `fast-check` with a minimum of 100 runs each, tagged `// Feature: lolprofiles-gg, Property {n}: {property text}` per the design's Testing Strategy.
- External I/O (`RiotApiClient`, `CacheStore`) is faked/mocked for orchestration-level property tests (Properties 2, 6, 7, 8, 18, 19, 20) to keep them deterministic and fast.
- Performance targets (Requirements 11.1, 11.2) are explicitly out of scope for this task list per the design's Testing Strategy (load/synthetic testing against a staging environment, not a coding task for this agent).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "5.1", "6.1", "9.1", "10.1", "11.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "5.2", "5.3", "5.4", "6.2", "7.1", "9.2", "9.3", "9.4", "10.2", "10.3", "10.4", "11.2"] },
    { "id": 3, "tasks": ["5.5", "7.2", "13.1"] },
    { "id": 4, "tasks": ["7.3", "7.4", "7.5", "13.2", "13.3"] },
    { "id": 5, "tasks": ["13.4"] },
    { "id": 6, "tasks": ["13.5", "13.6", "13.7", "15.1", "15.2"] },
    { "id": 7, "tasks": ["15.3", "15.4", "16.1", "16.2", "16.3"] },
    { "id": 8, "tasks": ["16.4", "16.5", "16.6"] },
    { "id": 9, "tasks": ["16.7", "18.1"] },
    { "id": 10, "tasks": ["18.2"] }
  ]
}
```
