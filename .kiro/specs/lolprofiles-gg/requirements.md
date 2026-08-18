# Requirements Document

## Introduction

lolprofiles.gg is a web application that analyzes League of Legends player profiles using the Riot Games APIs. A player enters a Riot ID (gameName#tagLine) into a search box, and the system retrieves account, summoner, ranked, and match history data from Riot's APIs. The system then presents statistics, derived insights ("fun facts"), and personalized improvement recommendations based on the player's recent match history. Because Riot's APIs enforce strict rate limits and require an API key, the system must cache responses, handle regional routing correctly, and gracefully handle API errors, invalid input, and downtime, while complying with Riot's Developer API Terms of Service.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend services combined), unless a more specific subsystem is named.
- **Riot_ID**: A player identifier consisting of a gameName and a tagLine separated by `#` (e.g. `Faker#KR1`), used with Account-V1 to resolve a PUUID.
- **PUUID**: The Riot-issued globally unique player identifier returned by Account-V1, used as input to Summoner-V4, League-V4, and Match-V5 endpoints.
- **Riot_API_Client**: The backend component responsible for constructing, authenticating, and sending requests to Riot Games API endpoints.
- **Platform_Routing_Value**: A Riot API routing value scoped to a specific server region (e.g. `na1`, `euw1`, `kr`), used for Summoner-V4 and League-V4 endpoints.
- **Regional_Routing_Value**: A Riot API routing value scoped to a continental region (e.g. `americas`, `europe`, `asia`, `sea`), used for Account-V1 and Match-V5 endpoints.
- **Profile_Report**: The aggregated set of stats, fun facts, and improvement recommendations generated for a single Riot_ID lookup.
- **Match_History_Window**: The bounded set of the player's most recent ranked and normal matches retrieved from Match-V5 and used as the basis for analysis.
- **Insight_Engine**: The backend component that derives fun facts, habits, and improvement recommendations from retrieved summoner, league, and match data.
- **Cache_Store**: The persistence layer that stores Riot API responses for a bounded time-to-live to reduce redundant Riot API calls.
- **Rate_Limit_Manager**: The backend component that tracks Riot API rate-limit usage and throttles or queues outgoing requests to stay within Riot-defined limits.
- **Lookup_Session**: A single end-to-end user request to view a Profile_Report for a given Riot_ID.

## Requirements

### Requirement 1: Riot ID Input and Validation

**User Story:** As a visitor, I want to enter a Riot ID in a search box, so that I can look up a League of Legends player's profile.

#### Acceptance Criteria

1. THE System SHALL display a text input field that accepts a Riot_ID in the format `gameName#tagLine`.
2. WHEN a visitor submits a value containing exactly one `#` character with a non-empty gameName part and a non-empty tagLine part (after removing leading and trailing whitespace from each part), THE System SHALL accept the value as a candidate Riot_ID and initiate a Lookup_Session.
3. IF a visitor submits a value that does not contain exactly one `#` character, THEN THE System SHALL reject the submission and display a message indicating the required `gameName#tagLine` format.
4. IF a visitor submits a value where the gameName part or the tagLine part is empty or consists only of whitespace characters, THEN THE System SHALL reject the submission and display a message indicating the required `gameName#tagLine` format.
5. IF a visitor submits a gameName part longer than 16 characters or a tagLine part longer than 5 characters, THEN THE System SHALL reject the submission and display a message indicating the field-length constraint.
6. WHILE a visitor has not selected a specific Regional_Routing_Value, THE System SHALL use a default Regional_Routing_Value of `americas` for the initial account lookup.
7. THE System SHALL provide a region selector listing the Regional_Routing_Values `americas`, `europe`, `asia`, and `sea`, allowing the visitor to choose the Regional_Routing_Value used for the account lookup.

### Requirement 2: Account and Summoner Data Retrieval

**User Story:** As a visitor, I want the system to fetch the correct player account and summoner data, so that the Profile_Report reflects the right player.

#### Acceptance Criteria

1. WHEN a Lookup_Session begins with a validated Riot_ID and a Regional_Routing_Value, THE Riot_API_Client SHALL call Account-V1's get-by-riot-id endpoint to resolve a PUUID.
2. WHEN a PUUID is resolved, THE Riot_API_Client SHALL call Summoner-V4's get-by-puuid endpoint using the corresponding Platform_Routing_Value to retrieve summoner level, icon, and summoner ID data.
3. WHEN a PUUID is resolved, THE Riot_API_Client SHALL call League-V4's get-by-puuid endpoint using the corresponding Platform_Routing_Value to retrieve ranked queue entries, tier, division, league points, wins, and losses.
4. IF Account-V1 returns a response indicating no account exists for the submitted Riot_ID, THEN THE System SHALL display a message indicating the player was not found, SHALL NOT proceed with Summoner-V4, League-V4, or Match-V5 calls, and SHALL discard any partial data retrieved for that Lookup_Session.
5. THE System SHALL maintain a mapping between each Regional_Routing_Value and its corresponding set of Platform_Routing_Values, and SHALL use this mapping to select the Platform_Routing_Value for Summoner-V4 and League-V4 calls.
6. THE Riot_API_Client SHALL apply a timeout of 10 seconds to each Account-V1, Summoner-V4, League-V4, and Match-V5 call, and SHALL treat a call that does not complete within this timeout as a failed call.
7. IF a Summoner-V4, League-V4, or Match-V5 call fails (due to timeout or a service error response) after the PUUID has been resolved, THEN THE System SHALL display a message indicating that player data could not be retrieved and SHALL NOT display a Profile_Report containing partial or stale data for that Lookup_Session.
8. IF League-V4 returns zero ranked queue entries for the resolved PUUID, THEN THE System SHALL treat this as a valid unranked state and SHALL display an "unranked" indication for the corresponding queue in the Profile_Report rather than treating it as a failed call.

### Requirement 3: Match History Retrieval

**User Story:** As a visitor, I want the system to retrieve recent match history for the player, so that stats and insights can be based on actual gameplay.

#### Acceptance Criteria

1. WHEN a PUUID is resolved, THE Riot_API_Client SHALL call Match-V5's match-ids-by-puuid endpoint using the Regional_Routing_Value to retrieve a Match_History_Window of up to 100 most recent match IDs.
2. WHEN a Match_History_Window's match IDs are retrieved, THE Riot_API_Client SHALL call Match-V5's match-by-id endpoint for each match ID to retrieve match detail data.
3. IF a Match-V5 match-by-id request for an individual match ID fails to return a successful match detail response for any reason, including timeout or rate limiting, THEN THE System SHALL exclude that match from the Profile_Report and SHALL continue processing the remaining match IDs in the Match_History_Window.
4. WHEN retrieval of a Match_History_Window completes and fewer than 5 matches were successfully retrieved, THE System SHALL display the Profile_Report with a notice that stats and insights are based on limited data.
5. IF a retrieved match's queue type is not "ranked solo/duo", "ranked flex", or "normal", THEN THE System SHALL exclude that match from the Profile_Report and from the count of successfully retrieved matches used to determine the limited-data notice.
6. IF the Match-V5 match-ids-by-puuid request fails for a resolved PUUID, THEN THE System SHALL display an error message indicating that match history could not be retrieved and SHALL NOT display a Profile_Report for that PUUID.

### Requirement 4: Rate Limiting and API Key Handling

**User Story:** As a system operator, I want Riot API requests to respect Riot's rate limits, so that the application's API key remains in good standing.

#### Acceptance Criteria

1. THE Riot_API_Client SHALL attach the Riot API key to every outgoing Riot API request as a request header.
2. THE Riot_API_Client SHALL NOT expose the Riot API key in any response, header, payload, or network request visible to frontend clients.
3. THE Rate_Limit_Manager SHALL track the number of requests sent per Platform_Routing_Value and Regional_Routing_Value against the application-level and method-level rate-limit windows returned by Riot in the `X-App-Rate-Limit` and `X-Method-Rate-Limit` response headers.
4. WHEN the Rate_Limit_Manager determines that sending a request would exceed a tracked rate-limit window and the required wait is 30 seconds or less, THE Rate_Limit_Manager SHALL delay the request until the window allows it.
5. IF the Rate_Limit_Manager determines that the required wait to avoid exceeding a tracked rate-limit window would exceed 30 seconds, THEN THE System SHALL abandon the request and display a message indicating the lookup could not complete due to rate limiting.
6. IF a Riot API response has HTTP status 429 and includes a `Retry-After` response header, THEN THE Riot_API_Client SHALL wait at least the duration specified in that header before retrying the request, up to 2 retry attempts.
7. IF a Riot API response has HTTP status 429 and does not include a `Retry-After` response header, THEN THE Riot_API_Client SHALL wait at least 5 seconds before retrying the request, up to 2 retry attempts.
8. IF a Riot API request fails after 2 retry attempts due to repeated HTTP 429 responses, THEN THE System SHALL display a message indicating the lookup could not complete due to rate limiting and SHALL invite the visitor to retry later.

### Requirement 5: Regional Routing Correctness

**User Story:** As a visitor searching for a player from any supported region, I want the system to route API calls to the correct Riot servers, so that lookups succeed regardless of region.

#### Acceptance Criteria

1. THE System SHALL support exactly the following Regional_Routing_Values for Account-V1 and Match-V5 calls: `americas`, `europe`, `asia`, and `sea`, and SHALL NOT accept any Regional_Routing_Value outside this set.
2. THE System SHALL maintain a closed mapping from each Regional_Routing_Value to its member Platform_Routing_Values, consisting of exactly:
   - `americas`: `na1`, `br1`, `la1`, `la2`
   - `europe`: `euw1`, `eun1`, `tr1`, `ru`
   - `asia`: `kr`, `jp1`
   - `sea`: `oc1`

   and THE System SHALL NOT accept any Platform_Routing_Value outside this mapping.
3. WHEN a visitor selects a Regional_Routing_Value, THE System SHALL restrict the region selector's Platform_Routing_Value choices to exactly the platforms listed for that Regional_Routing_Value in the mapping defined in Criterion 2.
4. IF a Lookup_Session is initiated with a Platform_Routing_Value that does not belong to the selected Regional_Routing_Value per the mapping in Criterion 2, THEN THE System SHALL replace the Platform_Routing_Value with the first Platform_Routing_Value listed for that Regional_Routing_Value in the mapping in Criterion 2, before calling Summoner-V4 or League-V4.
5. IF a Lookup_Session or region selector input specifies a Regional_Routing_Value or Platform_Routing_Value that is not present in the mapping defined in Criterion 2, THEN THE System SHALL reject the input, SHALL NOT initiate any Summoner-V4, League-V4, or Match-V5 calls for that input, and SHALL display a message indicating the region or platform is not supported.

### Requirement 6: Stats Display

**User Story:** As a visitor, I want to see clear statistics about a player, so that I can understand their performance at a glance.

#### Acceptance Criteria

1. WHEN a Profile_Report is generated, THE System SHALL display the player's current ranked tier and division for each queue type returned by League-V4, or display "Unranked" for a queue type when no ranked entry exists for that queue type.
2. WHEN a Profile_Report is generated, THE System SHALL display the player's win rate for each queue type that has a ranked entry, computed as wins divided by (wins plus losses), expressed as a percentage rounded to the nearest whole number.
3. WHEN a Profile_Report is generated, THE System SHALL display the player's average KDA (kills, deaths, assists) computed as (average kills plus average assists) divided by average deaths across all matches in the Match_History_Window, expressed to 2 decimal places.
4. WHEN a Profile_Report is generated, THE System SHALL display, for each of the top 5 most-played champions in the Match_History_Window (or fewer than 5 if the player has played fewer than 5 distinct champions), the champion name, games played, win rate rounded to the nearest whole percent, and average KDA expressed to 2 decimal places, ranked in descending order of games played with ties broken by descending win rate and then alphabetically by champion name.
5. WHEN a Profile_Report is generated, THE System SHALL display the player's most-played role, determined by the role with the highest match count in the Match_History_Window, with ties broken by selecting the role played in the most recent match within the Match_History_Window.
6. IF a queue type has a ranked entry with wins plus losses equal to zero, THEN THE System SHALL display "N/A" for that queue type's win rate instead of a computed value.
7. IF the player's average deaths across the Match_History_Window equal zero, THEN THE System SHALL display the average KDA as the sum of average kills and average assists, expressed to 2 decimal places, without division by deaths.

### Requirement 7: Fun Facts and Derived Insights

**User Story:** As a visitor, I want to see fun facts and habits about a player, so that I get an entertaining and personalized view of their playstyle.

#### Acceptance Criteria

1. WHEN a Profile_Report is generated, THE Insight_Engine SHALL derive the player's most common time-of-day window for starting matches from four fixed windows, each match's window being determined by its start timestamp interpreted in UTC (Night: 00:00-05:59, Morning: 06:00-11:59, Afternoon: 12:00-17:59, Evening: 18:00-23:59), computed from match start timestamps in the Match_History_Window, and SHALL display the resulting window(s), including all windows tied for the highest match count. (UTC is used so that the derivation is deterministic and independent of server or client locale.)
2. WHEN a Profile_Report is generated, THE Insight_Engine SHALL derive the player's longest win streak and longest loss streak, each defined as the maximum number of consecutive wins or consecutive losses respectively within the Match_History_Window ordered by match start timestamp, and SHALL display both streak lengths, using a value of 0 for a streak type that does not occur.
3. WHEN a Profile_Report is generated, THE Insight_Engine SHALL derive the player's average match duration across all matches in the Match_History_Window and SHALL display that value expressed in minutes.
4. WHEN a Profile_Report is generated, THE Insight_Engine SHALL derive and display between 3 and 4 distinct fun-fact statements selected from a defined set of habit categories, including role preference, champion loyalty, time-of-day pattern, and streak behavior, with at most one fun-fact statement displayed per category.
5. IF the Match_History_Window contains fewer than 5 successfully retrieved matches, THEN THE Insight_Engine SHALL omit fun-fact statements derived from the time-of-day pattern and streak behavior categories, and SHALL display a notice that additional fun facts require more match data.
6. IF fewer than 3 fun-fact statements remain eligible for display after applying the exclusions in Criterion 5, THEN THE Insight_Engine SHALL display only the eligible fun-fact statements together with the notice, without substituting statements from excluded categories.

### Requirement 8: Improvement Recommendations

**User Story:** As a visitor, I want personalized recommendations, so that I can understand what to improve in my gameplay.

#### Acceptance Criteria

1. WHEN a Profile_Report is generated, THE Insight_Engine SHALL derive and display at most 5 improvement recommendations based on patterns in the Match_History_Window, and SHALL display no recommendation whose triggering condition, as defined in Criteria 2, 3, and 4, is not met. Displaying zero improvement recommendations is a valid outcome when no triggering condition is met.
2. WHEN a Profile_Report is generated, IF the player's average deaths per match across the Match_History_Window exceeds the average deaths per match for the player's most-played role, THEN THE Insight_Engine SHALL include a recommendation addressing survivability.
3. WHEN a Profile_Report is generated, IF the player has played at least 2 distinct champions within the Match_History_Window AND the win rate on their most-played champion is lower than the win rate on their second-most-played champion by more than 10 percentage points, THEN THE Insight_Engine SHALL include a recommendation addressing champion selection.
4. WHEN a Profile_Report is generated, IF the player's average vision score per match across the Match_History_Window falls below the median vision score per match computed from the player's own matches played in their most-played role within the Match_History_Window, THEN THE Insight_Engine SHALL include a recommendation addressing vision control.
5. EACH improvement recommendation displayed SHALL include the specific metric name and the player's corresponding computed value from the Match_History_Window that produced the recommendation.

### Requirement 9: Error Handling

**User Story:** As a visitor, I want clear error messages when something goes wrong, so that I understand why a lookup failed and what to do next.

#### Acceptance Criteria

1. IF a submitted Riot_ID fails validation per Requirement 1, THEN THE System SHALL display a validation error message identifying which specific validation rule was not met, without initiating any Riot API calls.
2. IF Account-V1 returns HTTP 404 for a submitted Riot_ID, THEN THE System SHALL display a "player not found" message identifying the submitted gameName and tagLine.
3. IF a Riot API endpoint returns HTTP 500, 502, 503, or 504, THEN THE System SHALL display a message indicating Riot's services are temporarily unavailable and SHALL allow the visitor to retry the lookup, up to a maximum of 3 retry attempts per Lookup_Session, with each retry initiated only by explicit visitor action.
4. IF a Riot API request exceeds a 10-second timeout, THEN THE System SHALL abort the request and display a message indicating the lookup timed out.
5. IF the Riot API key used by the Riot_API_Client is rejected with HTTP 401 or HTTP 403, THEN THE System SHALL log the failure and SHALL display a generic "service unavailable" message to the visitor without exposing API key details.
6. WHILE a Lookup_Session is in progress, THE System SHALL display a loading indicator to the visitor.
7. WHEN a Lookup_Session completes, succeeds, fails, or times out, THE System SHALL remove the loading indicator.
8. IF a Riot API endpoint returns HTTP 429, THEN THE System SHALL display a message indicating the lookup was rate-limited and SHALL disable the retry action for a cooldown period of at least 5 seconds before allowing the visitor to retry.
9. IF a Riot API request fails due to a network connectivity error with no HTTP response received, THEN THE System SHALL display a message indicating a connection error occurred and SHALL allow the visitor to retry the lookup.
10. IF Account-V1 successfully resolves a PUUID for the submitted Riot_ID but Summoner-V4 reports that no summoner exists for that PUUID on the selected Platform_Routing_Value, THEN THE System SHALL display a message identifying the submitted Riot_ID and the Regional_Routing_Value and Platform_Routing_Value that were searched, SHALL indicate that the player exists but has no League of Legends profile on that region, and SHALL invite the visitor to select a different region; THE System SHALL NOT present this outcome as a Riot service outage or as a nonexistent account. (Riot accounts are global, so Account-V1 resolves a PUUID regardless of where the player plays; a Summoner-V4 404 is therefore evidence about the selected region rather than about Riot's availability or the validity of the Riot_ID.)

### Requirement 10: Caching of Riot API Responses

**User Story:** As a system operator, I want Riot API responses cached, so that the system stays within rate limits and responds quickly to repeated lookups.

#### Acceptance Criteria

1. WHEN a Riot API response for a given endpoint and parameter set is successfully retrieved, THE Cache_Store SHALL store the response keyed by endpoint, routing value, and the request-identifying parameters used for that endpoint (such as PUUID, summoner ID, or match ID, as applicable).
2. THE Cache_Store SHALL retain Account-V1 and Summoner-V4 responses for at least 1 hour before treating them as stale.
3. THE Cache_Store SHALL retain League-V4 responses for at least 10 minutes before treating them as stale.
4. THE Cache_Store SHALL retain individual Match-V5 match-by-id responses indefinitely, since completed match data does not change.
5. WHEN a Lookup_Session requests data for which a non-stale Cache_Store entry exists, THE System SHALL use the cached entry instead of calling the Riot API.
6. WHEN a Lookup_Session requests data for which a stale or absent Cache_Store entry exists and the resulting Riot API call succeeds, THE System SHALL update the Cache_Store with the new response and SHALL return the new response to the Lookup_Session.
7. IF a Riot API call made to refresh a stale or absent Cache_Store entry fails, THEN THE System SHALL NOT overwrite the existing Cache_Store entry with a failed response and SHALL report a lookup failure to the Lookup_Session.
8. IF the Cache_Store fails to persist a successfully retrieved Riot API response, THEN THE System SHALL still return the retrieved response to the Lookup_Session without reporting the lookup as failed.

### Requirement 11: Performance and Data Freshness

**User Story:** As a visitor, I want profile lookups to complete quickly, so that I don't have to wait a long time to see results.

#### Acceptance Criteria

1. WHEN all required data for a Profile_Report is available from the Cache_Store, THE System SHALL fully display the Profile_Report to the visitor within 2 seconds of Lookup_Session initiation, measured at the 95th percentile of Lookup_Sessions.
2. WHEN a Profile_Report requires fresh Riot API calls for a Match_History_Window of up to 100 matches, THE System SHALL fully display the Profile_Report to the visitor within 15 seconds of Lookup_Session initiation, measured at the 95th percentile of Lookup_Sessions.
3. IF a Riot API call required for a Profile_Report does not complete within 15 seconds or fails, THEN THE System SHALL stop waiting on that call, display the Profile_Report using the most recent available Cache_Store data, and display an indication that some data may be outdated or unavailable.
4. THE System SHALL display the last-updated timestamp of the data used to generate each Profile_Report.
5. IF no last-updated timestamp exists for a Profile_Report because no prior successful lookup has completed for that profile, THEN THE System SHALL display an indication that the data is being retrieved for the first time instead of a timestamp.

### Requirement 12: Riot API Terms of Service Compliance

**User Story:** As a system operator, I want the application to comply with Riot's Developer API Terms of Service, so that the application's API access remains authorized.

#### Acceptance Criteria

1. WHILE a page displays data obtained from Riot APIs, THE System SHALL display the attribution statement "lolprofiles.gg isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc." on that page.
2. THE System SHALL NOT display third-party advertisements, sponsored content, or paid promotional banners on any page that renders data obtained from Riot APIs.
3. WHERE the System operates under a Riot-approved commercial agreement that explicitly permits advertising alongside Riot API data, THE System SHALL be permitted to display advertising on pages that render data obtained from Riot APIs, limited to the scope authorized by that agreement.
4. THE System SHALL NOT persist Riot API response data for longer than the retention periods defined in Requirement 10 for cache purposes, except for aggregate, non-personally-identifying statistics that contain no PUUID, summoner name, or other data-subject-identifying fields.
5. IF a data subject requests removal of their Riot API-derived data, THEN THE System SHALL delete cached data associated with that data subject's PUUID within 30 days of the request and SHALL provide the requester a confirmation response indicating the deletion has been completed.
6. IF a data subject requests removal of their Riot API-derived data and no cached data exists for that data subject's PUUID, THEN THE System SHALL provide the requester a confirmation response indicating no data was found, without treating the request as an error.
