# Requirements Document

## Introduction

lolprofiles.gg currently asks the visitor to pick a region before a lookup, and then infers the player's platform from that choice. This is wrong in two ways that only became visible after live testing against the real Riot API.

First, Account-V1's get-by-riot-id endpoint is **global**: a Riot ID resolves successfully on any Regional_Routing_Value regardless of where the player actually plays. The region selector therefore does not determine whether a lookup succeeds — it determines whether the *next* call fails. A Korean player searched under `americas` resolves a PUUID, then 404s at Summoner-V4, and the visitor is told the player is not on that platform when in fact they simply picked the wrong dropdown value. The dropdown is a guess the visitor should never have been asked to make.

Second, the application's newly granted API access changes which endpoint is the constraint. Summoner-V4 is limited to 1600 requests per minute, while Account-V1, League-V4 get-by-puuid and Champion-Mastery-V4 are limited to 20,000 requests per 10 seconds. Summoner-V4 is now the tightest limit in the lookup pipeline by an order of magnitude, and it contributes only `summonerLevel` and `profileIconId` — two cosmetic fields. It is nonetheless on the failure path: a Summoner-V4 timeout currently aborts an otherwise complete Profile_Report.

This document specifies two changes that compose. Account-V1's region-by-PUUID endpoint makes the platform an *observation* rather than a guess, which removes the visitor-facing region selector and eliminates the `PLAYER_NOT_ON_PLATFORM` error condition at its source. Because that error was detected via a Summoner-V4 404, removing it is also what frees Summoner-V4 to become a non-blocking enrichment call rather than a pipeline dependency.

These requirements change behavior the application already ships. Requirement 7 states each existing behavior being replaced in full, so this document can be read without reference to any other.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend services combined), unless a more specific subsystem is named.
- **Riot_ID**: A player identifier consisting of a gameName and a tagLine separated by `#` (e.g. `Faker#KR1`), used with Account-V1 to resolve a PUUID.
- **PUUID**: The Riot-issued globally unique player identifier returned by Account-V1, used as input to Summoner-V4, League-V4, and Match-V5 endpoints.
- **Riot_API_Client**: The backend component responsible for constructing, authenticating, and sending requests to Riot Games API endpoints.
- **Platform_Routing_Value**: A Riot API routing value scoped to a specific server region (e.g. `na1`, `euw1`, `kr`), used for Summoner-V4 and League-V4 endpoints.
- **Regional_Routing_Value**: A Riot API routing value scoped to a continental region (e.g. `americas`, `europe`, `asia`, `sea`), used for Account-V1 and Match-V5 endpoints.
- **Profile_Report**: The aggregated set of stats, fun facts, and improvement recommendations generated for a single Riot_ID lookup.
- **Lookup_Session**: A single end-to-end user request to view a Profile_Report for a given Riot_ID.
- **Cache_Store**: The persistence layer that stores Riot API responses for a bounded time-to-live to reduce redundant Riot API calls.
- **Rate_Limit_Manager**: The backend component that tracks Riot API rate-limit usage and throttles or queues outgoing requests to stay within Riot-defined limits.

This document adds:

- **Region_Resolver**: The backend component that determines a player's true Platform_Routing_Value from their PUUID by calling Account-V1's region-by-game-by-puuid endpoint, rather than deriving it from a visitor's selection.
- **Resolved_Platform**: The Platform_Routing_Value returned by the Region_Resolver for a given PUUID, which is authoritative for all subsequent platform-routed calls in that Lookup_Session.
- **Derived_Region**: The Regional_Routing_Value obtained by reverse-mapping a Resolved_Platform, used for all subsequent regional-routed calls in that Lookup_Session.
- **Platform_To_Region_Map**: The closed mapping from each supported Platform_Routing_Value to exactly one Regional_Routing_Value; the inverse of the existing `REGION_TO_PLATFORMS` mapping.
- **Discovery_Region**: The Regional_Routing_Value used to host the initial Account-V1 calls, which are global in effect and therefore may be issued against any regional host.
- **Enrichment_Call**: A Riot API call whose failure degrades the Profile_Report's completeness but never changes its success or failure classification.

## Requirements

### Requirement 1: Automatic Platform Resolution

**User Story:** As a visitor, I want the system to work out for itself which server a player is on, so that I do not have to know or guess it.

#### Acceptance Criteria

1. WHEN a PUUID is resolved by Account-V1, THE Region_Resolver SHALL call Account-V1's region-by-game-by-puuid endpoint with game `lol` and that PUUID to obtain the player's Resolved_Platform.
2. WHEN a Resolved_Platform is obtained, THE System SHALL use it as the Platform_Routing_Value for every subsequent platform-routed call in that Lookup_Session, including Summoner-V4 and League-V4.
3. WHEN a Resolved_Platform is obtained, THE System SHALL reverse-map it through the Platform_To_Region_Map to obtain a Derived_Region, and SHALL use that Derived_Region as the Regional_Routing_Value for every subsequent regional-routed call in that Lookup_Session, including Match-V5.
4. THE System SHALL NOT use any visitor-supplied region or platform value to route a call once a Resolved_Platform has been obtained.
5. THE Riot_API_Client SHALL issue the region-by-game-by-puuid call against the Discovery_Region host, and SHALL treat the returned Resolved_Platform as authoritative regardless of which regional host answered.
6. THE System SHALL apply the same 10-second per-call timeout, rate-limit reservation, and 429 retry policy to the region-by-game-by-puuid call as to every other Riot API call.

### Requirement 2: Search Without Region Selection

**User Story:** As a visitor, I want to search using only a Riot ID, so that the search box asks me for nothing I would have to look up first.

#### Acceptance Criteria

1. THE System SHALL accept a Lookup_Session request containing only a Riot_ID, with no region or platform field.
2. THE System SHALL NOT display a region selector or a platform selector on the search interface.
3. WHEN a Profile_Report is displayed, THE System SHALL display the Resolved_Platform that was used to retrieve it, so the visitor can confirm which server the data came from.
4. THE System SHALL continue to accept an optional platform override field on the lookup API for diagnostic use, and IF such an override is supplied THEN THE System SHALL use it in place of calling the Region_Resolver and SHALL mark the resulting Profile_Report as having used a manual override.
5. THE System SHALL NOT surface the override described in criterion 4 in the default search interface.

### Requirement 3: Platform-to-Region Reverse Mapping

**User Story:** As a system operator, I want the platform-to-region mapping to be closed and total, so that a platform the system does not recognise fails loudly rather than being routed to the wrong continent.

#### Acceptance Criteria

1. THE System SHALL maintain a Platform_To_Region_Map in which every Platform_Routing_Value appearing in `REGION_TO_PLATFORMS` maps to exactly the Regional_Routing_Value whose platform list contains it.
2. THE System SHALL treat the Platform_To_Region_Map and `REGION_TO_PLATFORMS` as two views of one mapping, defined such that neither can be edited independently of the other.
3. IF the Region_Resolver returns a Platform_Routing_Value that does not appear in the Platform_To_Region_Map, THEN THE System SHALL halt the Lookup_Session and display a message naming the unrecognised platform and stating that the region is not yet supported.
4. THE System SHALL normalise the platform value returned by Account-V1 to the casing used in `REGION_TO_PLATFORMS` before looking it up in the Platform_To_Region_Map.

### Requirement 4: Summoner Data Is Non-Essential

**User Story:** As a visitor, I want to see a player's stats even when one cosmetic detail could not be loaded, so that a minor outage does not cost me the whole report.

#### Acceptance Criteria

1. THE System SHALL classify the Summoner-V4 call as an Enrichment_Call.
2. IF the Summoner-V4 call fails for any reason, including timeout, rate limiting, service error, or a not-found response, THEN THE System SHALL complete the Lookup_Session and display the Profile_Report without summoner level and profile icon, and SHALL NOT display an error page.
3. WHEN a Profile_Report is displayed without summoner level or profile icon, THE System SHALL render a visually neutral placeholder in place of each absent value rather than a zero, a blank, or an error string.
4. THE System SHALL NOT block the dispatch of the League-V4 or Match-V5 calls on the completion of the Summoner-V4 call.
5. THE System SHALL NOT derive any error code, routing decision, or pipeline-halting condition from the outcome of the Summoner-V4 call.

### Requirement 5: Region Resolution Error Handling

**User Story:** As a visitor, I want a clear explanation when a Riot ID exists but has no League of Legends data, so that I understand the result rather than assuming the site is broken.

#### Acceptance Criteria

1. IF Account-V1's get-by-riot-id endpoint reports that no account exists for the submitted Riot_ID, THEN THE System SHALL display a player-not-found message and SHALL NOT call the Region_Resolver.
2. IF the Region_Resolver reports that no League of Legends region exists for a resolved PUUID, THEN THE System SHALL display a message stating that the Riot account exists but has no League of Legends play history, and SHALL NOT proceed with Summoner-V4, League-V4, or Match-V5 calls.
3. IF the Region_Resolver call fails due to timeout, rate limiting, service error, or a network error, THEN THE System SHALL halt the Lookup_Session and surface the corresponding retriable error already defined for that failure class, and SHALL NOT fall back to a guessed platform.
4. THE System SHALL NOT emit the `PLAYER_NOT_ON_PLATFORM` error code from any code path once automatic platform resolution is in effect.

### Requirement 6: Region Resolution Caching

**User Story:** As a system operator, I want a player's resolved platform to be cached, so that repeat lookups do not pay for a call whose answer almost never changes.

#### Acceptance Criteria

1. THE Cache_Store SHALL support a cache entry type for region resolution, keyed on the PUUID and the game identifier.
2. THE System SHALL retain a region-resolution entry for 24 hours, after which it SHALL be treated as stale and re-fetched.
3. WHEN a non-stale region-resolution entry exists for a PUUID, THE System SHALL use it and SHALL NOT call the Region_Resolver for that Lookup_Session.
4. WHEN a deletion request is processed for a PUUID, THE Cache_Store SHALL remove that PUUID's region-resolution entry along with every other entry in which the PUUID appears.

### Requirement 7: Behavior Replaced

**User Story:** As a maintainer, I want each existing behavior this change removes stated in full, so that the change can be reviewed without reconstructing what used to happen.

#### Acceptance Criteria

1. THE System currently defaults to a Regional_Routing_Value of `americas` when the visitor has not chosen one, and offers a selector listing `americas`, `europe`, `asia` and `sea`. THE System SHALL remove both the default and the selector, per Requirement 2.
2. THE System currently selects the Platform_Routing_Value for Summoner-V4 and League-V4 by mapping the visitor's chosen region through `REGION_TO_PLATFORMS` and falling back to that region's first platform. THE System SHALL replace that derivation with the Resolved_Platform, per Requirements 1.2 and 1.3.
3. THE System currently treats a failure of Summoner-V4, League-V4, or Match-V5 match-ids after PUUID resolution as a condition that prevents a Profile_Report from being displayed. THE System SHALL exclude Summoner-V4 failures from that set, per Requirement 4, and SHALL leave League-V4 and Match-V5 match-ids in it.
4. THE System currently reports a Summoner-V4 404 following a resolved PUUID as `PLAYER_NOT_ON_PLATFORM`, naming the searched region and platform and inviting a different region. THE System SHALL remove that error code and its detection branch, per Requirement 5.
5. THE System SHALL retain the `REGION_TO_PLATFORMS` mapping and its existing correctness guarantee — that each region's platform list is exactly as documented and the lists are pairwise disjoint — because the Platform_To_Region_Map defined in Requirement 3 is derived from it.
