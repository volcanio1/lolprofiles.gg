# Requirements Document

## Introduction

Clash is League of Legends' scheduled five-player tournament mode. Teams register in advance, play a bracket over a weekend, and are eliminated. Between matches, teams get a short window in which to prepare for an opponent they have just learned the name of — and preparation means finding out who the five players are, what they play, and what to ban.

This feature builds that scouting report. Given any one player on a team, it retrieves the team's roster, joins each member's ranked standing, champion pool and recent form onto it, and derives the judgements a captain would otherwise assemble by hand across five browser tabs: which champions to ban, which declared positions do not match how the players have actually been playing, and whether the roster is a coordinated five-stack or five people who met in the lobby.

One property of Riot's API shapes the entire design and must be stated at the outset: **Riot does not expose the tournament bracket.** There is no endpoint that says who a team is playing next. A scouting report can therefore only ever be *requested* by naming a player on the team to be scouted — which is exactly what a captain has, since opponent names appear in champion select and in the post-game lobby. The feature is "scout this team, given anyone on it", not "scout my next opponent". Any design that assumed bracket access would not be implementable.

The second shaping constraint is a rate limit. Clash-V1's tournament endpoints are granted 10 requests per minute — three orders of magnitude below every other endpoint in this application. That is not a limit to be managed on the request path; it is a limit that forbids the request path entirely. Tournament data is refreshed by a background schedule and served from cache, and no visitor request may ever cause a tournament call.

Like Live Game, this feature must treat absence as the normal case. Clash runs on a handful of weekends per year, so for most of the year every player's Clash registration is empty, and that is a state rather than a failure.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend services combined), unless a more specific subsystem is named.
- **Riot_ID**: A player identifier consisting of a gameName and a tagLine separated by `#` (e.g. `Faker#KR1`), used with Account-V1 to resolve a PUUID.
- **PUUID**: The Riot-issued globally unique player identifier returned by Account-V1, used as input to the platform- and region-routed endpoints.
- **Riot_API_Client**: The backend component responsible for constructing, authenticating, and sending requests to Riot Games API endpoints.
- **Platform_Routing_Value**: A Riot API routing value scoped to a specific server region (e.g. `na1`, `euw1`, `kr`).
- **Regional_Routing_Value**: A Riot API routing value scoped to a continental region (e.g. `americas`, `europe`, `asia`, `sea`).
- **Cache_Store**: The persistence layer that stores Riot API responses for a bounded time-to-live to reduce redundant Riot API calls.
- **Rate_Limit_Manager**: The backend component that tracks Riot API rate-limit usage and throttles or queues outgoing requests to stay within Riot-defined limits.
- **Resolved_Platform**: The Platform_Routing_Value determined for a PUUID by the automatic platform resolution defined in the `lookup-pipeline-fixes` spec, authoritative for all platform-routed calls.
- **Champion_Pool**: The set of champions a player is most invested in, derived from their top champion masteries.
- **Static_Data_Provider**: The component defined in the `visual-assets` spec that resolves Riot identifiers into asset URLs and display names against a pinned Data Dragon version.

This document adds:

- **Clash_Team**: A registered five-player Clash roster, as returned by Clash-V1's teams endpoint, with a name, abbreviation, tier, icon, and captain.
- **Clash_Registration**: A player's membership of a Clash_Team for an active tournament, including their declared position and whether they are the captain.
- **Scouting_Report**: The System's assembled analysis of one Clash_Team — its roster, each member's Roster_Card, and the derived Scouting_Insights.
- **Roster_Card**: One team member's entry in a Scouting_Report, combining their Clash_Registration with their Riot ID, ranked standing, Champion_Pool and Recent_Form.
- **Champion_Pool**: The set of champions a player is most invested in, derived from their top champion masteries.
- **Recent_Form**: A bounded window of a player's most recent matches, used to derive their observed role and champion performance.
- **Declared_Position**: The position a player selected when registering for Clash, as returned by Clash-V1.
- **Observed_Role**: The role a player has most often actually played across their Recent_Form.
- **Ban_Recommendation**: A champion the System suggests banning against a scouted team, ranked by a defined total order.
- **Stack_Cohesion**: A measure of how often the scouted team's members have played together recently, derived from participant overlap across their Recent_Form.
- **Tournament_Schedule**: The cached list of Clash tournaments, refreshed on a background schedule and never on a visitor request.

## Requirements

### Requirement 1: Team Discovery

**User Story:** As a Clash captain, I want to look up a team by naming any one player on it, so that I can scout an opponent whose name I only just learned.

#### Acceptance Criteria

1. WHEN a visitor submits a Riot_ID for scouting, THE System SHALL resolve it to a PUUID and Resolved_Platform using the automatic platform resolution defined in the `lookup-pipeline-fixes` spec, and SHALL NOT ask the visitor to supply a region.
2. WHEN a PUUID is resolved, THE Riot_API_Client SHALL call Clash-V1's players-by-puuid endpoint using the Resolved_Platform to retrieve that player's Clash_Registrations.
3. IF Clash-V1's players-by-puuid endpoint returns no registrations for the PUUID, THEN THE System SHALL display a state indicating the player is not registered for an active Clash tournament and SHALL NOT display an error.
4. WHEN a Clash_Registration is retrieved, THE Riot_API_Client SHALL call Clash-V1's teams endpoint with the registration's team identifier to retrieve the Clash_Team.
5. IF a player holds more than one Clash_Registration, THEN THE System SHALL display each registered team and SHALL allow the visitor to select which one to scout.
6. THE Riot_API_Client SHALL apply the same 10-second per-call timeout, rate-limit reservation, and 429 retry policy to every Clash-V1 call as to every other Riot API call.

### Requirement 2: Roster Enrichment

**User Story:** As a Clash captain, I want each member of the scouted team annotated with their rank, champion pool and recent form, so that the roster tells me how to play against them.

#### Acceptance Criteria

1. WHEN a Scouting_Report is assembled, THE System SHALL retrieve each roster member's Riot_ID using Account-V1's get-by-puuid endpoint.
2. WHEN a Scouting_Report is assembled, THE System SHALL retrieve each roster member's ranked queue entries using League-V4's get-by-puuid endpoint on the team's platform.
3. WHEN a Scouting_Report is assembled, THE System SHALL retrieve each roster member's Champion_Pool using Champion-Mastery-V4's top-masteries-by-puuid endpoint.
4. WHEN a Scouting_Report is assembled, THE System SHALL retrieve each roster member's Recent_Form as a bounded window of their most recent matches, and SHALL NOT retrieve more than 10 matches per member.
5. IF any roster enrichment call fails for a member, THEN THE System SHALL display that Roster_Card with the corresponding field absent and SHALL NOT fail the Scouting_Report or omit the member.
6. IF an individual match retrieval within a member's Recent_Form fails, THEN THE System SHALL exclude that match and SHALL continue processing the remaining matches for that member.
7. WHEN a roster member has no ranked entry for a queue, THE System SHALL display that member as unranked rather than treating it as a failed retrieval.

### Requirement 3: Scouting Insights

**User Story:** As a Clash captain, I want the report to tell me what to ban and where the opponent is off-role, so that I get a plan rather than five profiles.

#### Acceptance Criteria

1. WHEN a Scouting_Report is assembled, THE System SHALL compute every Scouting_Insight from the assembled report alone and SHALL NOT issue further Riot API calls to do so.
2. THE System SHALL produce a ranked list of Ban_Recommendations drawn from the scouted team's members' champions, ordered by a defined total order over mastery investment and observed recent performance.
3. THE System SHALL produce no more than 5 Ban_Recommendations.
4. THE System SHALL compare each member's Declared_Position against their Observed_Role and SHALL flag the member WHEN the two differ.
5. IF a member's Declared_Position is unselected or fill, THEN THE System SHALL NOT flag that member for a position mismatch.
6. IF a member's Recent_Form contains no matches, THEN THE System SHALL omit their Observed_Role and SHALL NOT flag them for a position mismatch.
7. THE System SHALL compute Stack_Cohesion as the number of the scouted team's members who appear together in at least one match across the team's combined Recent_Form.
8. THE System SHALL compute every Scouting_Insight as a pure function of the assembled Scouting_Report, such that the same report always produces the same insights.

### Requirement 4: Tournament Schedule

**User Story:** As a system operator, I want tournament data fetched on a schedule rather than on demand, so that a visitor request can never breach a 10-per-minute limit.

#### Acceptance Criteria

1. THE System SHALL retrieve the Tournament_Schedule on a background refresh schedule and SHALL NOT issue a Clash-V1 tournaments call in response to a visitor request.
2. THE System SHALL refresh the Tournament_Schedule no more often than once every 5 minutes.
3. WHEN a Scouting_Report is displayed, THE System SHALL serve tournament details from the cached Tournament_Schedule.
4. IF the cached Tournament_Schedule is absent or stale when a Scouting_Report is displayed, THEN THE System SHALL display the Scouting_Report without tournament details and SHALL NOT block or fail the report.
5. THE System SHALL retrieve a scouted team's tournament association using Clash-V1's tournaments-by-team endpoint, which is not subject to the tournaments endpoint's 10-per-minute limit.

### Requirement 5: Caching and Staleness

**User Story:** As a system operator, I want Clash data cached according to how fast it actually changes, so that repeat scouting of one team during a tournament window is nearly free.

#### Acceptance Criteria

1. THE Cache_Store SHALL support cache entry types for Clash player registrations, Clash teams, and the Tournament_Schedule.
2. THE System SHALL retain a Clash player registration entry for 5 minutes.
3. THE System SHALL retain a Clash team entry for 5 minutes.
4. THE System SHALL retain a Tournament_Schedule entry for 1 hour.
5. THE System SHALL cache roster enrichment data using the retention already defined for its endpoint type.
6. WHEN a deletion request is processed for a PUUID, THE Cache_Store SHALL remove every Clash registration and Clash team entry in which that PUUID appears, whether as the keyed player or as a member of a roster.

### Requirement 6: Riot Compliance

**User Story:** As a system operator, I want the scouting page to satisfy the same Riot obligations as every other page, so that the feature does not create a compliance gap.

#### Acceptance Criteria

1. THE System SHALL display the required Riot attribution statement on the Scouting_Report page, as on every other page rendering Riot data.
2. THE System SHALL exclude advertising and sponsored-content slots from the Scouting_Report page by default, consistent with the policy applied to every other page rendering Riot data.
3. THE System SHALL NOT display any roster member identifier beyond the Riot_ID that Riot itself exposes for that player.
4. THE System SHALL NOT present a Scouting_Report as endorsed by, or affiliated with, Riot Games.
