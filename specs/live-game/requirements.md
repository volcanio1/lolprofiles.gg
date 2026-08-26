# Requirements Document

## Introduction

lolprofiles.gg currently reports on games a player has already finished. This feature reports on the game a player is in right now.

Spectator-V5's active-games endpoint returns the ten participants of an in-progress game, the champions they locked, their summoner spells and runes, the banned champions, and the game's start time and queue. It returns nothing a visitor could not see by spectating the game in the League client, and it is the basis of the most-visited page on every comparable site.

What the endpoint does not return is anything about *who* those ten players are. It gives PUUIDs and champion IDs and nothing else — no names, no ranks, no history. The value of the feature is almost entirely in what the System joins onto that skeleton: each player's ranked standing, their mastery on the champion they just locked, and the derived judgements those make possible — that the enemy jungler is on a champion they have never played, that one player in the lobby is four divisions above everyone else, that the support is a one-trick on their pick.

Two constraints shape the design. The endpoint answers "not in a game" far more often than it answers with a game, and that must be a normal state rather than an error. And the data is live, so it goes stale in seconds — while the enrichment joined onto it (names, ranks, mastery) does not, and must not be re-fetched at the live data's cadence.

This feature also introduces a dependency the existing build does not have. Spectator-V5 returns numeric champion, summoner-spell and rune identifiers. Rendering them as names and images requires Riot's static Data Dragon files, which are a versioned CDN rather than a rate-limited API. That dependency is specified here because without it the feature cannot render at all.

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

This document adds:

- **Live_Game**: An in-progress League of Legends game, as returned by Spectator-V5's active-games-by-summoner endpoint for a given PUUID.
- **Live_Game_Lobby**: The System's representation of a Live_Game — its ten Participant_Cards, banned champions, queue, map, and elapsed time.
- **Participant_Card**: One player's entry in a Live_Game_Lobby, combining the Spectator-V5 participant record with the enrichment the System joins onto it.
- **Participant_Enrichment**: The Riot ID, ranked standing, and champion mastery the System retrieves per participant to make a Participant_Card readable.
- **Lobby_Insight**: A judgement derived purely from a fully assembled Live_Game_Lobby, such as an off-champion flag or a rank-spread summary, computed without further Riot API calls.
- **Static_Data_Provider**: The component defined in the `visual-assets` spec that resolves Riot identifiers into asset URLs and display names against a pinned Data Dragon version. This feature extends it with summoner-spell and rune resolution rather than redefining it.
- **Game_Clock**: The elapsed time of a Live_Game, derived from its start timestamp and the current time rather than stored as a countdown.
- **Pre_Game**: The state of a Live_Game that Spectator-V5 has returned but which has not yet started, identifiable by an absent or zero start timestamp.

## Requirements

### Requirement 1: Live Game Retrieval

**User Story:** As a visitor, I want to see whether a player is in a game right now, so that I can follow the game they are playing.

#### Acceptance Criteria

1. WHEN a visitor requests the live game state for a resolved PUUID, THE Riot_API_Client SHALL call Spectator-V5's active-games-by-summoner endpoint using that player's Resolved_Platform.
2. IF Spectator-V5 reports that no active game exists for the PUUID, THEN THE System SHALL display a "not currently in a game" state and SHALL NOT display an error.
3. WHEN Spectator-V5 returns an active game, THE System SHALL display a Live_Game_Lobby containing every participant returned, the banned champions, the queue, the map, and the Game_Clock.
4. THE Riot_API_Client SHALL apply the same 10-second per-call timeout, rate-limit reservation, and 429 retry policy to the Spectator-V5 call as to every other Riot API call.
5. THE System SHALL resolve the PUUID and Resolved_Platform for a live game request using the same automatic platform resolution defined in the `lookup-pipeline-fixes` spec, and SHALL NOT ask the visitor to supply a region.

### Requirement 2: Participant Enrichment

**User Story:** As a visitor, I want to know who the ten players are and how good they are, so that the lobby tells me something the game client does not.

#### Acceptance Criteria

1. WHEN a Live_Game_Lobby is assembled, THE System SHALL retrieve each participant's Riot_ID using Account-V1's get-by-puuid endpoint.
2. WHEN a Live_Game_Lobby is assembled, THE System SHALL retrieve each participant's ranked queue entries using League-V4's get-by-puuid endpoint on the game's platform.
3. WHEN a Live_Game_Lobby is assembled, THE System SHALL retrieve each participant's champion mastery for the champion they have locked, using Champion-Mastery-V4's by-puuid-by-champion endpoint.
4. IF any Participant_Enrichment call fails for a participant, THEN THE System SHALL display that Participant_Card with the corresponding field absent and SHALL NOT fail the Live_Game_Lobby or omit the participant.
5. IF a participant is flagged by Spectator-V5 as a bot, THEN THE System SHALL display the Participant_Card without attempting any Participant_Enrichment call for it.
6. WHEN a participant has no ranked entry for a queue, THE System SHALL display that participant as unranked rather than treating it as a failed retrieval.

### Requirement 3: Lobby Insights

**User Story:** As a visitor, I want the lobby to point out what is notable about it, so that I do not have to read ten cards and work it out myself.

#### Acceptance Criteria

1. WHEN a Live_Game_Lobby is assembled, THE System SHALL compute each Lobby_Insight from the assembled lobby alone and SHALL NOT issue further Riot API calls to do so.
2. THE System SHALL flag a participant as off-champion WHEN their mastery points on the locked champion are below 10,000 AND at least one ranked entry or mastery record exists for that participant.
3. THE System SHALL flag a participant as a one-trick WHEN their mastery points on the locked champion are at or above 200,000.
4. THE System SHALL display the rank spread of the lobby as the highest and lowest ranked tier present among participants with a ranked entry in the game's queue.
5. IF fewer than two participants have a ranked entry in the game's queue, THEN THE System SHALL omit the rank spread rather than displaying a spread computed from one entry.
6. THE System SHALL compute every Lobby_Insight as a pure function of the assembled Live_Game_Lobby, such that the same lobby always produces the same insights.

### Requirement 4: Game Clock and Pre-Game State

**User Story:** As a visitor, I want the elapsed game time to be correct, so that I can tell how far into the game the players are.

#### Acceptance Criteria

1. THE System SHALL derive the Game_Clock from the Live_Game's start timestamp and the current time, and SHALL NOT derive it from a stored elapsed-time value.
2. IF a Live_Game's start timestamp is absent or zero, THEN THE System SHALL display the game as Pre_Game and SHALL NOT display a Game_Clock.
3. WHILE a Live_Game_Lobby is displayed, THE System SHALL advance the displayed Game_Clock without issuing a Riot API call to do so.
4. THE System SHALL NOT display a negative Game_Clock value under any circumstances.

### Requirement 5: Polling and Game End

**User Story:** As a visitor, I want the lobby to notice when the game ends, so that I am not left watching a page that stopped being true.

#### Acceptance Criteria

1. WHILE a Live_Game_Lobby is displayed, THE System SHALL re-request the live game state at an interval of no less than 30 seconds.
2. IF a re-request reports that no active game exists for a PUUID whose Live_Game_Lobby was previously displayed, THEN THE System SHALL display a game-ended state.
3. WHEN a game-ended state is displayed, THE System SHALL offer a link to the finished match, constructed from the platform identifier and game identifier of the ended Live_Game.
4. IF the finished match is requested before Riot has published it, THEN THE System SHALL display a message stating that the match results are not yet available and SHALL NOT display an error.
5. WHEN a visitor navigates away from a Live_Game_Lobby, THE System SHALL stop re-requesting the live game state.

### Requirement 6: Caching and Staleness

**User Story:** As a system operator, I want live data and enrichment data cached at different rates, so that following a game does not re-fetch ten players' ranks every thirty seconds.

#### Acceptance Criteria

1. THE Cache_Store SHALL support a cache entry type for active game data, keyed on the PUUID and the platform.
2. THE System SHALL retain an active-game entry for no more than 30 seconds, after which it SHALL be treated as stale.
3. THE System SHALL cache Participant_Enrichment data using the retention already defined for its endpoint type, and SHALL NOT shorten that retention to match the active-game entry.
4. THE Cache_Store SHALL support a cache entry type for champion mastery, keyed on the PUUID, the platform, and the champion identifier, retained for 1 hour.
5. WHEN a deletion request is processed for a PUUID, THE Cache_Store SHALL remove that PUUID's active-game and champion-mastery entries along with every other entry in which the PUUID appears.
6. THE System SHALL remove a participant's PUUID from any cached active-game entry in which it appears as a participant when a deletion request is processed for that PUUID.

### Requirement 7: Static Data

**User Story:** As a visitor, I want to see champion names and portraits rather than numbers, so that the lobby is readable.

#### Acceptance Criteria

1. THE System SHALL resolve every identifier in a Live_Game_Lobby through the Static_Data_Provider, and SHALL NOT introduce a second mechanism for resolving Riot identifiers to assets.
2. THE System SHALL extend the Static_Data_Provider to resolve summoner-spell identifiers and rune identifiers into display names and image URLs, which the provider does not resolve today.
3. THE System SHALL extend the Static_Data_Provider to resolve a NUMERIC champion identifier into a Champion_Key, since Spectator-V5 reports champions numerically whereas Match-V5 reports them as a key.
4. IF an identifier cannot be resolved against the pinned static data, THEN THE System SHALL display the raw identifier and SHALL NOT fail the Live_Game_Lobby.
5. THE System SHALL inherit the Static_Data_Provider's version pinning, its retention of no less than 24 hours, and its exclusion from the Rate_Limit_Manager, and SHALL NOT restate or vary them.

### Requirement 8: Riot Compliance

**User Story:** As a system operator, I want the live game page to satisfy the same Riot obligations as every other page, so that the feature does not create a compliance gap.

#### Acceptance Criteria

1. THE System SHALL display the required Riot attribution statement on the Live_Game_Lobby page, as on every other page rendering Riot data.
2. THE System SHALL exclude advertising and sponsored-content slots from the Live_Game_Lobby page by default, consistent with the policy applied to every other page rendering Riot data.
3. THE System SHALL NOT display any participant identifier beyond the Riot_ID that Riot itself exposes for that player.
