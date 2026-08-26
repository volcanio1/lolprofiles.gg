# Requirements Document

## Introduction

lolprofiles.gg renders no images. Not a champion portrait, not a profile icon, not an item — the frontend contains zero `<img>` elements, and a Profile_Report is a wall of names and numbers. This is the single largest gap between what the application computes and what it communicates: the data is there, and the page reads like a spreadsheet.

This feature adds the three asset classes that carry the most meaning per pixel, in the order they matter:

1. **Champion icons**, wherever a champion is named — the top-champions list, every match row, and the enemy laner in each matchup.
2. **The looked-up player's profile icon**, beside their Riot ID.
3. **Item images** for both the player and their enemy laner in the match history, which is the comparison a visitor actually wants and cannot currently make at all.

Three facts about the existing system shape the work, and each removes a problem that would otherwise have needed solving.

Riot's Match-V5 `championName` field is already the champion's internal key — `Aatrox`, `MonkeyKing`, `Chogath` — which is exactly the filename Data Dragon serves champion images under. The application already stores that string on every match, every opponent, and every top-champion entry. No identifier translation is needed to render a champion icon; only a base URL and a pinned version.

The enemy laner is already identified. `opponentOf` in the orchestrator's mapping module pairs the player with the opposing participant sharing their lane and surfaces them as an `OpponentSummary`, returning nothing when no lane could be determined. Item images for the matchup therefore need no new matching logic — only the item fields, on a participant row the system already selects.

Those item fields are the one genuine gap. Match-V5's participant record carries `item0` through `item6`, and the application captures none of them. They must be captured on both sides of the matchup before anything can render them.

One clarification the requirements depend on: Match-V5's participant record reports the player's **final inventory at game end**, not the sequence in which items were bought. This document specifies the final build, which is what a match history row shows. A true purchase timeline requires Match-V5's timeline endpoint and is out of scope here.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend services combined), unless a more specific subsystem is named.
- **Riot_ID**: A player identifier consisting of a gameName and a tagLine separated by `#` (e.g. `Faker#KR1`).
- **PUUID**: The Riot-issued globally unique player identifier returned by Account-V1.
- **Profile_Report**: The aggregated set of stats, fun facts, and improvement recommendations generated for a single Riot_ID lookup.
- **Cache_Store**: The persistence layer that stores Riot API responses for a bounded time-to-live.
- **Rate_Limit_Manager**: The backend component that tracks Riot API rate-limit usage and throttles outgoing requests to stay within Riot-defined limits.
- **Data_Dragon**: Riot's versioned static content distribution, which serves champion, item, and profile-icon images and the metadata files that describe them. It is a public CDN and is not a rate-limited game API.
- **Data_Dragon_Version**: The single Data_Dragon release identifier the System resolves every asset against, fixed in configuration rather than resolved to a moving alias.
- **Static_Data_Provider**: The component that resolves Riot identifiers into asset URLs and display names against the pinned Data_Dragon_Version.
- **Champion_Key**: Riot's internal champion identifier string as returned in Match-V5's `championName` field (e.g. `MonkeyKing`), which is also the Data_Dragon image filename stem.
- **Champion_Display_Name**: The human-readable champion name (e.g. `Wukong`) corresponding to a Champion_Key.
- **Item_Slot**: One of the seven inventory positions a Match-V5 participant record reports, where slots 0 through 5 hold items and slot 6 holds the trinket.
- **Final_Build**: The set of items a participant held at game end, as reported by Match-V5, as distinct from the order in which they were purchased.
- **Enemy_Laner**: The opposing participant sharing the analyzed player's lane, as already identified by the orchestrator's opponent selection.
- **Asset_Placeholder**: The neutral visual the System renders in place of an image that could not be resolved.

## Requirements

### Requirement 1: Champion Icons

**User Story:** As a visitor, I want to see each champion's portrait rather than only its name, so that I can read a match history at a glance.

#### Acceptance Criteria

1. WHERE a champion is named in a Profile_Report, THE System SHALL display that champion's icon alongside the name, resolved from the Champion_Key against the pinned Data_Dragon_Version.
2. THE System SHALL display a champion icon in the top-champions list, in every match history row for the analyzed player, and for the Enemy_Laner in every match history row where one was identified.
3. THE System SHALL display the Champion_Display_Name rather than the raw Champion_Key wherever a champion is named to the visitor.
4. IF a Champion_Key cannot be resolved against the pinned Data_Dragon_Version, THEN THE System SHALL display an Asset_Placeholder in place of the icon and SHALL display the raw Champion_Key as the name.
5. IF a Champion_Key is absent or empty for a match, THEN THE System SHALL display an Asset_Placeholder and SHALL NOT render a broken image or an empty element.

### Requirement 2: Profile Icon

**User Story:** As a visitor, I want to see the player's profile picture next to their name, so that the report is recognisably about a person.

#### Acceptance Criteria

1. WHEN a Profile_Report is displayed, THE System SHALL display the analyzed player's profile icon adjacent to their Riot_ID, resolved from the profile icon identifier against the pinned Data_Dragon_Version.
2. THE System SHALL treat the profile icon identifier as absent when the summoner data it is derived from could not be retrieved, and SHALL NOT substitute a numeric default for an absent value.
3. IF the profile icon identifier is absent, THEN THE System SHALL display an Asset_Placeholder in place of the icon.
4. IF the profile icon identifier cannot be resolved against the pinned Data_Dragon_Version, THEN THE System SHALL display an Asset_Placeholder.

### Requirement 3: Item Images in Match History

**User Story:** As a visitor, I want to see what I built and what my lane opponent built, so that I can compare the two without opening the game client.

#### Acceptance Criteria

1. THE System SHALL capture all seven Item_Slots from the analyzed player's Match-V5 participant record for every match included in a Profile_Report.
2. THE System SHALL capture all seven Item_Slots from the Enemy_Laner's Match-V5 participant record for every match in which an Enemy_Laner was identified.
3. WHEN a match history row is displayed, THE System SHALL display the analyzed player's Final_Build as images in Item_Slot order.
4. WHEN a match history row is displayed AND an Enemy_Laner was identified, THE System SHALL display the Enemy_Laner's Final_Build as images in Item_Slot order.
5. THE System SHALL render Item_Slot 6 as visually distinct from Item_Slots 0 through 5, reflecting that it holds a trinket rather than an item.
6. IF an Item_Slot holds the identifier 0, THEN THE System SHALL render an empty slot and SHALL NOT request or render an image for it.
7. IF no Enemy_Laner was identified for a match, THEN THE System SHALL display no opposing build for that match and SHALL NOT render empty opposing slots.
8. THE System SHALL present the displayed items as the Final_Build and SHALL NOT describe them as a purchase order.
9. THE System SHALL derive an Enemy_Laner's Item_Slots from the same participant record that the opponent selection identified, and SHALL NOT derive them from any other participant.

### Requirement 4: Static Data Retrieval and Version Pinning

**User Story:** As a system operator, I want every asset resolved against one pinned version, so that a Riot patch cannot silently change what the site renders.

#### Acceptance Criteria

1. THE System SHALL resolve every asset URL and display name against a single Data_Dragon_Version held in backend configuration.
2. THE System SHALL NOT resolve assets against a moving alias such as "latest".
3. THE System SHALL expose the configured Data_Dragon_Version to the frontend at runtime, so that changing it does not require a frontend rebuild.
4. THE Static_Data_Provider SHALL retrieve champion and item metadata from Data_Dragon and SHALL retain it for no less than 24 hours.
5. THE System SHALL NOT route Data_Dragon requests through the Rate_Limit_Manager, which governs the rate-limited Riot game APIs only.
6. THE System SHALL NOT route Data_Dragon image requests through the backend.

### Requirement 5: Placeholder and Failure Behavior

**User Story:** As a visitor, I want a page with a missing image to still look finished, so that a CDN problem does not read as a broken site.

#### Acceptance Criteria

1. THE System SHALL display an Asset_Placeholder of the same dimensions as the asset it replaces, so that a missing image does not change the page layout.
2. IF Data_Dragon metadata cannot be retrieved, THEN THE System SHALL display the Profile_Report in full with an Asset_Placeholder in place of every image, and SHALL NOT fail, blank, or block the report.
3. THE System SHALL NOT render an image element whose source could not be constructed.
4. THE System SHALL treat an identifier that is absent, empty, zero-valued where zero means empty, or unknown to the pinned version as an unresolvable identifier and SHALL apply the Asset_Placeholder behavior to it.

### Requirement 6: Accessibility

**User Story:** As a visitor using a screen reader, I want every image to be described, so that the report conveys the same information it does visually.

#### Acceptance Criteria

1. THE System SHALL give every rendered asset image a non-empty text alternative.
2. THE System SHALL use the Champion_Display_Name as the text alternative for a champion icon, falling back to the Champion_Key when the display name cannot be resolved.
3. THE System SHALL use the item's name as the text alternative for an item image, falling back to the item identifier when the name cannot be resolved.
4. THE System SHALL give an Asset_Placeholder a text alternative describing what could not be loaded.
5. THE System SHALL NOT convey any information through an image alone that is not also available as text.

### Requirement 7: Riot Compliance

**User Story:** As a system operator, I want asset rendering to satisfy the same Riot obligations as every other part of the site, so that adding images does not create a compliance gap.

#### Acceptance Criteria

1. THE System SHALL display the required Riot attribution statement on every page rendering Data_Dragon assets, as on every other page rendering Riot data.
2. THE System SHALL exclude advertising and sponsored-content slots from pages rendering Data_Dragon assets, consistent with the policy applied to every other page rendering Riot data.
3. THE System SHALL serve Data_Dragon assets from Riot's distribution and SHALL NOT rehost, modify, or re-brand them.
