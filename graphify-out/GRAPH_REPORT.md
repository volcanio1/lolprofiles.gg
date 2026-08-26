# Graph Report - lolprofiles.gg  (2026-08-26)

## Corpus Check
- 93 files · ~108,355 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1010 nodes · 1965 edges · 68 communities (57 shown, 11 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.81)
- Token cost: 113,354 input · 21,422 output

## Community Hubs (Navigation)
- React App Shell & Riot Compliance UI
- Recent Matches & Champion Recommendations
- Fun Facts Insight Engine
- Backend Package Manifest
- Frontend TypeScript Config
- Riot API HTTP Client & Retry
- CORS Middleware & API Errors
- Orchestrator Property Tests
- Backend TypeScript Config
- Frontend ESLint Config
- Recommendation Property Tests
- Cache Property Tests
- useLookup Hook & Lookup State
- Profile Report View Formatting
- Backend ESLint Config
- Frontend Lookup API Client
- API Error Taxonomy
- Lookup Logging & Stages
- Rate Limit Property Tests
- Frontend API Type Contracts
- Orchestrator Result Types
- Rate Limit Header Parsing
- Riot API Specs & Rate Limit Design
- Lookup Orchestrator Budget Gate
- Riot Client Endpoints & Routing
- Profile Report Spec Properties
- Express App & End-to-End Tests
- Match Mapping & Queue Types
- Region Routing Table
- Root Workspace Scripts
- Riot Client Property Tests
- Frontend Dev Dependencies
- In-Memory Cache Store & Privacy Tests
- Cache Key Construction
- Cache Fault Injection Tests
- Cache Store Interface & cacheOrFetch
- Riot ID Validator
- cacheOrFetch Property Tests
- Rate Limit Manager Implementation
- Cache-First Orchestration Design
- Cache TTL Policy Design
- Lookup Route Tests
- Server Composition Root
- Known Gaps & Open Items
- Lookup Request Parsing
- API Endpoints & Riot ID Spec
- Architecture Overview & Ad Policy
- React Runtime Dependencies
- Frontend Build Scripts
- PUUID Deletion & Privacy
- Testing Strategy & Task Plan
- Error Handling Findings
- Region Mapping Parity Guard
- PUUID Cache Eviction
- Frontend Package Identity
- Rate Limit Manager Interface
- React Hooks ESLint Plugin
- jsdom Test Environment
- React Testing Library
- Node Type Definitions
- TypeScript Toolchain
- TypeScript ESLint Parser
- Vite Bundler
- Vite React Plugin
- Vitest Runner

## God Nodes (most connected - your core abstractions)
1. `CacheStore` - 20 edges
2. `createInMemoryCacheStore()` - 20 edges
3. `compilerOptions` - 18 edges
4. `compilerOptions` - 18 edges
5. `CacheKey` - 17 edges
6. `InMemoryCacheStore` - 17 edges
7. `createApiRouter()` - 16 edges
8. `DefaultLookupOrchestrator` - 16 edges
9. `IncludedMatch` - 15 edges
10. `parseLookupRequest()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `lolprofiles.gg Two-Workspace Architecture` --references--> `Cache-First Orchestration`  [INFERRED]
  README.md → specs/lolprofiles-gg/design.md
- `lolprofiles.gg Two-Workspace Architecture` --references--> `Centralized Rate Limiting`  [INFERRED]
  README.md → specs/lolprofiles-gg/design.md
- `Open Items Carried Forward` --references--> `No .env Loading`  [INFERRED]
  specs/lolprofiles-gg/implementation-log.md → README.md
- `Riot ToS Compliance at the Service Layer` --implements--> `Requirement 12: Riot API ToS Compliance`  [INFERRED]
  README.md → specs/lolprofiles-gg/requirements.md
- `React SPA HTML Shell (#root)` --conceptually_related_to--> `Vite Dev Proxy Same-Origin Strategy`  [INFERRED]
  frontend/index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Lookup Session Pipeline** — specs_lolprofiles_gg_design_api_layer, specs_lolprofiles_gg_design_riot_id_validator, specs_lolprofiles_gg_design_region_router, specs_lolprofiles_gg_design_lookup_orchestrator, specs_lolprofiles_gg_design_cacheorfetch, specs_lolprofiles_gg_design_cache_store, specs_lolprofiles_gg_design_riot_api_client, specs_lolprofiles_gg_design_rate_limit_manager, specs_lolprofiles_gg_design_insight_engine, specs_lolprofiles_gg_design_profile_report [EXTRACTED 1.00]
- **PUUID Deletion Right and Its Fallout** — readme_post_api_privacy_delete, specs_lolprofiles_gg_design_deletebypuuid, specs_lolprofiles_gg_design_matchdetail_eviction_on_deletion, specs_lolprofiles_gg_implementation_log_in_place_scrubbing, specs_lolprofiles_gg_implementation_log_finding_b, specs_lolprofiles_gg_design_property_20, specs_lolprofiles_gg_requirements_requirement_12 [INFERRED 0.85]
- **Layered Riot Rate-Limit Defense** — specs_lolprofiles_gg_design_rate_limit_manager, specs_lolprofiles_gg_design_reserveslot, specs_lolprofiles_gg_design_retry_429_backoff, specs_lolprofiles_gg_implementation_log_sliding_window_rate_limiting, specs_lolprofiles_gg_design_property_7, specs_lolprofiles_gg_design_property_8, specs_lolprofiles_gg_requirements_requirement_4 [INFERRED 0.85]

## Communities (68 total, 11 thin omitted)

### Community 0 - "React App Shell & Riot Compliance UI"
Cohesion: 0.06
Nodes (44): App(), AdvertisingAgreement, advertisingPermitted(), approvedAdvertisingAgreement, RIOT_ATTRIBUTION_TEXT, RiotDataPage(), RiotDataPageProps, AD_PATTERNS (+36 more)

### Community 1 - "Recent Matches & Champion Recommendations"
Cohesion: 0.06
Nodes (57): computeRecentMatches(), RECENT_MATCH_LIMIT, RecentMatchSummary, CHAMPION_WIN_RATE_GAP_THRESHOLD, championSelectionRecommendationOf(), computeRecommendations(), MAX_RECOMMENDATIONS, METRIC_NAMES (+49 more)

### Community 2 - "Fun Facts Insight Engine"
Cohesion: 0.09
Nodes (39): averageMatchDurationMinutesOf(), championLoyaltyOf(), chronologicalOrderOf(), computeFunFacts(), isBlankName(), isLimitedData(), joinWithAnd(), LIMITED_DATA_MATCH_THRESHOLD (+31 more)

### Community 3 - "Backend Package Manifest"
Cohesion: 0.06
Nodes (35): dependencies, express, devDependencies, eslint, fast-check, supertest, @types/express, @types/node (+27 more)

### Community 4 - "Frontend TypeScript Config"
Cohesion: 0.07
Nodes (29): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module, moduleResolution (+21 more)

### Community 5 - "Riot API HTTP Client & Retry"
Cohesion: 0.13
Nodes (20): RateLimitHeaders, readHeader(), AttemptOutcome, createRiotApiClient(), DEFAULT_RETRY_AFTER_SECONDS, isAbortReason(), MAX_RETRY_ATTEMPTS, parseRetryAfterSeconds() (+12 more)

### Community 6 - "CORS Middleware & API Errors"
Cohesion: 0.14
Nodes (18): CorsOptions, createCorsMiddleware(), parseAllowedOrigins(), makeApp(), stubOrchestrator, internalError(), missingFieldError(), ApiDependencies (+10 more)

### Community 7 - "Orchestrator Property Tests"
Cohesion: 0.12
Nodes (22): canonicalRiotId(), finiteOrZero(), lastUpdatedOf(), LookupResult, accountDto(), ALLOWED_QUEUE_IDS, ClientScript, DISALLOWED_QUEUE_IDS (+14 more)

### Community 8 - "Backend TypeScript Config"
Cohesion: 0.08
Nodes (24): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noFallthroughCasesInSwitch (+16 more)

### Community 9 - "Frontend ESLint Config"
Cohesion: 0.08
Nodes (23): jsx, env, browser, es2022, extends, ignorePatterns, dist, eslint:recommended (+15 more)

### Community 10 - "Recommendation Property Tests"
Cohesion: 0.13
Nodes (22): arbChampionPairWindow, arbFreeWindow, arbSeed, arbSingleRoleWindow, arbWindow, BOUNDARY_WINDOWS, CATEGORIES, Category (+14 more)

### Community 11 - "Cache Property Tests"
Cohesion: 0.10
Nodes (20): buildStore(), cacheStateArb, CacheStateSpec, DELIMITERS, DumpRecord, endpointArb, ENDPOINTS, EXPECTED_RETENTION_MS (+12 more)

### Community 12 - "useLookup Hook & Lookup State"
Cohesion: 0.15
Nodes (14): LookupOutcome, LookupRequest, ProfileReport, ProfileReportViewProps, INITIAL_STATE, LookupState, LookupStatus, MAX_RETRIES (+6 more)

### Community 13 - "Profile Report View Formatting"
Cohesion: 0.17
Nodes (19): OpponentSummary, RankedQueueStanding, formatCsPerMinute(), formatKda(), formatKda3(), formatMatchDate(), formatTimestamp(), formatWinRate() (+11 more)

### Community 14 - "Backend ESLint Config"
Cohesion: 0.10
Nodes (19): env, es2022, node, extends, ignorePatterns, dist, eslint:recommended, node_modules (+11 more)

### Community 15 - "Frontend Lookup API Client"
Cohesion: 0.19
Nodes (12): DEFAULT_COOLDOWN_SECONDS, errorCodeForStatus(), FetchLike, isProfileReport(), LookupClientOptions, lookupProfile(), readErrorPayload(), REQUEST_TIMEOUT_MS (+4 more)

### Community 16 - "API Error Taxonomy"
Cohesion: 0.20
Nodes (17): ApiErrorBody, apiErrorFor(), ApiErrorPayload, ApiErrorResponse, HTTP_STATUS_BY_ERROR_CODE, MAX_MANUAL_RETRIES, MESSAGE_BY_ERROR_CODE, playerNotFoundError() (+9 more)

### Community 17 - "Lookup Logging & Stages"
Cohesion: 0.18
Nodes (16): FRESH_PATH_BUDGET_MS, LookupLogger, LookupStage, MATCH_HISTORY_COUNT, account(), Fakes, leagueEntry(), makeFakes() (+8 more)

### Community 18 - "Rate Limit Property Tests"
Cohesion: 0.15
Nodes (12): callArb, callsArb, configArb, limitHeaderValue(), METHODS, ReleaseOracle, ROUTING_VALUES, ScopeConfig (+4 more)

### Community 19 - "Frontend API Type Contracts"
Cohesion: 0.15
Nodes (14): ApiErrorBody, ApiErrorPayload, ChampionSummary, ErrorCode, FunFact, ProfileStats, RankedQueueSummary, NOTE: the Riot API key appears nowhere in this contract, by construction. The (+6 more)

### Community 20 - "Orchestrator Result Types"
Cohesion: 0.16
Nodes (16): FunFact, Recommendation, ProfileStats, CacheOrFetchFailure, CacheOrFetchOutcome, CacheOrFetchSuccess, ComponentAge, consoleLookupLogger (+8 more)

### Community 21 - "Rate Limit Header Parsing"
Cohesion: 0.15
Nodes (12): HeaderGetter, MAX_QUEUED_WAIT_MS, parseNonNegativeInteger(), parseRateLimitPairs(), RateLimitExceededError, RateLimitManagerOptions, RateLimitPair, RateLimitWindowSnapshot (+4 more)

### Community 22 - "Riot API Specs & Rate Limit Design"
Cohesion: 0.15
Nodes (18): Riot Account-V1, Centralized Rate Limiting, Riot League-V4, Riot Match-V5, Property 6: API Key Never in Client-Facing Output, Property 7: Rate Limit Reservation Bounds, Property 8: 429 Retry Wait and Count Bounded, Rate Limit Manager (+10 more)

### Community 23 - "Lookup Orchestrator Budget Gate"
Cohesion: 0.21
Nodes (6): isCacheOrFetchFailure(), RiotApiFailure, ageOf(), BudgetGate, DefaultLookupOrchestrator, StageFailure

### Community 24 - "Riot Client Endpoints & Routing"
Cohesion: 0.24
Nodes (5): PlatformRoutingValue, RegionalRoutingValue, baseUrl(), HttpRiotApiClient, RiotApiClient

### Community 25 - "Profile Report Spec Properties"
Cohesion: 0.20
Nodes (17): Insight Engine, lastUpdated = Oldest Refreshable Component, ProfileReport, ProfileStats, Property 10: Top-Champion Total Order, Property 11: Most-Played Role Recency Tiebreak, Property 12: Time-of-Day Reports All Tied Windows, Property 13: Win/Loss Streak Lengths (+9 more)

### Community 26 - "Express App & End-to-End Tests"
Cohesion: 0.22
Nodes (14): createApp(), makeApp(), stubOrchestrator, accountBody(), Harness, headers(), json(), leagueBody() (+6 more)

### Community 27 - "Match Mapping & Queue Types"
Cohesion: 0.28
Nodes (14): ALLOWED_QUEUE_TYPES, csOf(), finiteOrZero(), opponentOf(), QUEUE_TYPE_BY_QUEUE_ID, queueTypeForQueueId(), roleOf(), matchDto() (+6 more)

### Community 28 - "Region Routing Table"
Cohesion: 0.20
Nodes (13): DEFAULT_REGION, isValidPlatform(), platformsFor(), caseArb, EXPECTED, EXPECTED_PLATFORMS, EXPECTED_REGIONS, platformArb (+5 more)

### Community 29 - "Root Workspace Scripts"
Cohesion: 0.14
Nodes (13): name, private, scripts, build:backend, build:frontend, lint:backend, lint:frontend, test:backend (+5 more)

### Community 30 - "Riot Client Property Tests"
Cohesion: 0.15
Nodes (9): API_KEY_HEADER, apiKeyArb, Endpoint, endpointArb, okBodies, permissiveRateLimitManager, retryAfterHeaderArb, Scenario (+1 more)

### Community 31 - "Frontend Dev Dependencies"
Cohesion: 0.15
Nodes (13): devDependencies, eslint, @testing-library/jest-dom, @testing-library/user-event, @types/react, @types/react-dom, @typescript-eslint/eslint-plugin, eslint (+5 more)

### Community 32 - "In-Memory Cache Store & Privacy Tests"
Cohesion: 0.21
Nodes (8): Harness, makeHarness(), seed(), sharedMatch(), stubOrchestrator, createInMemoryCacheStore(), InMemoryCacheStore, snapshot()

### Community 33 - "Cache Key Construction"
Cohesion: 0.23
Nodes (8): buildCacheKey(), CacheEndpoint, InMemoryCacheStoreOptions, segment(), StoredRecord, matchDetailValue(), populate(), TTL_BY_ENDPOINT

### Community 34 - "Cache Fault Injection Tests"
Cohesion: 0.23
Nodes (5): CacheEntry, CacheKey, Pair, FaultInjectingCacheStore, UnavailableCacheStore

### Community 35 - "Cache Store Interface & cacheOrFetch"
Cohesion: 0.21
Nodes (6): CacheStore, isStale(), cacheOrFetch(), KEY, LEAGUE_TTL, Payload

### Community 36 - "Riot ID Validator"
Cohesion: 0.20
Nodes (8): MAX_GAME_NAME_LENGTH, MAX_TAG_LINE_LENGTH, candidateArb, partArb, structuredCandidateArb, whitespaceArb, RiotIdValidationResult, validateRiotId()

### Community 37 - "cacheOrFetch Property Tests"
Cohesion: 0.18
Nodes (8): endpointArb, ENDPOINTS, EXPECTED_RETENTION_MS, failureArb, Fetch, Payload, Prior, tokenArb

### Community 38 - "Rate Limit Manager Implementation"
Cohesion: 0.29
Nodes (5): appScopeKey(), InMemoryRateLimitManager, methodScopeKey(), pruneExpired(), requiredWait()

### Community 39 - "Cache-First Orchestration Design"
Cohesion: 0.24
Nodes (11): Cache-First Orchestration, Lookup Orchestrator, MatchHistoryWindow, Property 2: Account-Not-Found Halts Pipeline, Property 5: Match Failures and Disallowed Queues Excluded, 15s Budget Is a Race, Not a Poll, Numeric Queue-ID Allowlist, Requirement 11: Performance and Data Freshness (+3 more)

### Community 40 - "Cache TTL Policy Design"
Cohesion: 0.27
Nodes (11): CacheKey Deterministic Construction, Cache Store, Per-Endpoint Cache TTL Policy, cacheOrFetch Helper, Property 16: Cache Key Deterministic and Injective, Property 17: Cache TTL Staleness per Endpoint, Property 18: Non-Stale Entries Skip the API Client, Property 19: Cache Refresh Atomicity (+3 more)

### Community 41 - "Lookup Route Tests"
Cohesion: 0.22
Nodes (5): LookupRouteDependencies, Harness, makeHarness(), LookupInput, LookupOrchestrator

### Community 42 - "Server Composition Root"
Cohesion: 0.20
Nodes (7): app, cache, config, orchestrator, rateLimitManager, riotApiClient, RiotHttpTransport

### Community 43 - "Known Gaps & Open Items"
Cohesion: 0.33
Nodes (10): Case-Sensitive Account Cache Keys, CORS_ALLOWED_ORIGINS Exact-Origin Allowlist, Known Gaps, No .env Loading, Unauthenticated Routes Risk, Vite Dev Proxy Same-Origin Strategy, Finding C: Browser Cannot Reach Backend (No CORS, No Proxy), Open Items Carried Forward (+2 more)

### Community 44 - "Lookup Request Parsing"
Cohesion: 0.44
Nodes (8): malformedRequestError(), unsupportedRegionError(), validationError(), isJsonObject(), parseLookupRequest(), pickRegion(), readOptionalString(), isValidRegion()

### Community 45 - "API Endpoints & Riot ID Spec"
Cohesion: 0.29
Nodes (8): GET /health, POST /api/lookup, Express API Layer, Property 1: Validator Accepts Exactly Well-Formed Inputs, Riot ID Validator, PUUID, Requirement 1: Riot ID Input and Validation, Riot_ID

### Community 46 - "Architecture Overview & Ad Policy"
Cohesion: 0.33
Nodes (7): React SPA HTML Shell (#root), Chakra Petch + IBM Plex Sans Typography, lolprofiles.gg Two-Workspace Architecture, Inverted No-Advertising Policy, Riot ToS Compliance at the Service Layer, RiotDataPage Template, Insight Generation Is Pure and I/O-Free

### Community 47 - "React Runtime Dependencies"
Cohesion: 0.29
Nodes (7): dependencies, react, react-dom, react-router-dom, react, react-dom, react-router-dom

### Community 48 - "Frontend Build Scripts"
Cohesion: 0.29
Nodes (7): scripts, build, dev, lint, preview, test, typecheck

### Community 49 - "PUUID Deletion & Privacy"
Cohesion: 0.43
Nodes (7): POST /api/privacy/delete, deleteByPuuid, Evict Match Details Rather Than Redact, Property 20: Deletion Idempotent and Always Answered, In-Place PUUID Scrubbing (Superseded), Requirement 12: Riot API ToS Compliance, Task 5.4: deleteByPuuid with PUUID Scrubbing

### Community 50 - "Testing Strategy & Task Plan"
Cohesion: 0.38
Nodes (7): Project Layout, fast-check, Dual Testing Strategy, Deterministic Branch-Coverage Guards via fc examples, Everything External Is Injected, lolprofiles.gg Implementation Plan, Task Dependency Wave Graph

### Community 51 - "Error Handling Findings"
Cohesion: 0.38
Nodes (7): Requirement 9 Error Mapping Table, AUTH_FAILURE Maps to 503, Never 401/403, Finding A: Wrong-Region Lookup Reports a Bogus Outage, Finding B: Deletion Permanently Empties Future Reports, Live Verification Against the Real Riot API, PLAYER_NOT_ON_PLATFORM Error Code, Requirement 9: Error Handling

### Community 52 - "Region Mapping Parity Guard"
Cohesion: 0.53
Nodes (6): frontend/src/domain/parity.test.ts, Property 3: Region Mapping Closed and Consistent, Region Router, REGION_TO_PLATFORMS Closed Mapping, Cross-Workspace Parity Guard, Requirement 5: Regional Routing Correctness

### Community 54 - "Frontend Package Identity"
Cohesion: 0.40
Nodes (4): name, private, type, version

## Knowledge Gaps
- **290 isolated node(s):** `root`, `parser`, `ecmaVersion`, `sourceType`, `@typescript-eslint` (+285 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `IncludedMatch` connect `Recent Matches & Champion Recommendations` to `Fun Facts Insight Engine`, `Orchestrator Property Tests`, `Recommendation Property Tests`, `Orchestrator Result Types`, `Match Mapping & Queue Types`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Why does `InMemoryCacheStore` connect `In-Memory Cache Store & Privacy Tests` to `Cache Key Construction`, `Cache Fault Injection Tests`, `Cache Store Interface & cacheOrFetch`, `cacheOrFetch Property Tests`, `Orchestrator Property Tests`, `Cache Property Tests`, `Lookup Logging & Stages`, `PUUID Cache Eviction`, `Express App & End-to-End Tests`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `createInMemoryCacheStore()` connect `In-Memory Cache Store & Privacy Tests` to `Cache Key Construction`, `Cache Store Interface & cacheOrFetch`, `cacheOrFetch Property Tests`, `CORS Middleware & API Errors`, `Orchestrator Property Tests`, `Lookup Route Tests`, `Server Composition Root`, `Cache Property Tests`, `Lookup Logging & Stages`, `Express App & End-to-End Tests`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `root`, `parser`, `ecmaVersion` to the rest of the system?**
  _290 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `React App Shell & Riot Compliance UI` be split into smaller, more focused modules?**
  _Cohesion score 0.05821917808219178 - nodes in this community are weakly interconnected._
- **Should `Recent Matches & Champion Recommendations` be split into smaller, more focused modules?**
  _Cohesion score 0.06128364389233954 - nodes in this community are weakly interconnected._
- **Should `Fun Facts Insight Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.08985200845665962 - nodes in this community are weakly interconnected._