# Requirements Document

## Introduction

The `visual-assets` feature renders each match's Final_Build — the six items and trinket a player held when the game ended — for both the analyzed player and their lane opponent. That answers *what* was built. It cannot answer *when*, or *in what order*, or *what was bought and then sold*, because Match-V5's participant record reports an end-state and nothing else.

This feature adds the build path: the ordered sequence of item purchases the analyzed player made, with timestamps, reconstructed from Match-V5's timeline endpoint. It is what turns "you finished with these six items" into "you completed your first legendary at 9:40, your second at 15:20, and you sold your starting item at 11:05".

**This feature now has a defined home.** When this spec was written, "where the build path renders" was left open. The `match-detail-tabs` feature has since established an expandable Detail_Panel on every match row carrying three tabs — General, Build Path, and Runes — and ships the Build Path tab as an explicit not-yet-available placeholder that this feature replaces. Requirements 3.8 through 3.10 record that contract. The two specs were written independently to the same lazy-retrieval constraint, so there is nothing to reconcile: `match-detail-tabs` Requirement 5.4 fetches only on tab selection, which is exactly what Requirement 1.1 below demands.

The scope is deliberately one-sided. The build path is retrieved and displayed **for the analyzed player only**. The lane opponent continues to show the Final_Build already specified in `visual-assets`, and no timeline data is extracted for them. This is a product decision rather than a technical limit — the same timeline response contains every participant's events — and the extraction is specified per-participant so that including the opponent later is a parameter change rather than a redesign. What the narrowed scope forgoes is any timing *comparison* between the two players, since only one side has timings at all.

Three properties of the data shape this work, and each is a place where a straightforward implementation is wrong rather than merely slow.

A timeline response is one to five megabytes of JSON. The application's cache is an unbounded in-memory map with no eviction policy, and match details are retained indefinitely because completed matches are immutable. Applying that retention to raw timelines would grow memory without bound. The resolution is that the raw response is never stored: it is parsed, the analyzed player's item events are extracted, and everything else is discarded. The retained slice is smaller than the source by roughly three orders of magnitude.

A build path is not the list of `ITEM_PURCHASED` events. Players use the shop's undo button routinely, and an undone purchase emits no compensating purchase event — it emits an `ITEM_UNDO`. Filtering for purchases and sorting by timestamp produces a build containing items the player never actually owned, which reads as plausible and is wrong.

Finally, the reconstruction has an independent oracle. Replaying the event stream to its end must produce the same set of items that Match-V5's participant record already reports as the Final_Build. The two come from different endpoints and are derived by different means, so agreement between them is real evidence that the replay is correct, and disagreement is a signal worth surfacing rather than suppressing.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend services combined), unless a more specific subsystem is named.
- **Riot_ID**: A player identifier consisting of a gameName and a tagLine separated by `#`.
- **PUUID**: The Riot-issued globally unique player identifier returned by Account-V1.
- **Cache_Store**: The persistence layer that stores Riot API responses for a bounded time-to-live.
- **Rate_Limit_Manager**: The backend component that tracks Riot API rate-limit usage and throttles outgoing requests to stay within Riot-defined limits.
- **Match_Timeline**: The full Match-V5 timeline response for one match, containing per-minute frames and a complete event stream for all ten participants.
- **Shop_Event**: One of the four Match_Timeline events that change a participant's inventory — item purchased, item sold, item destroyed, or item undone.
- **Participant_Slot**: The numeric identifier, 1 through 10, by which Match_Timeline events address a participant, as distinct from the PUUID used elsewhere in the application.
- **Build_Path**: The ordered sequence of item acquisitions the analyzed player actually completed in a match, after undone actions have been removed, each carrying the game time at which it occurred.
- **Reconstructed_Inventory**: The set of items held by the analyzed player at a given point in a match, derived by replaying Shop_Events from the start of the game to that point.
- **Final_Build**: The six items and trinket a participant held at game end, as reported by Match-V5's participant record and already displayed by the `visual-assets` feature.
- **Component_Item**: An item that exists to be built into another item, as distinguished from a completed item by the item metadata the `visual-assets` Static_Data_Provider already retrieves.
- **Timeline_Slice**: The extracted, retained representation of one player's Build_Path for one match, which is what the System stores in place of the Match_Timeline it was derived from.
- **Reconciliation**: The comparison of a Reconstructed_Inventory at game end against the Final_Build reported independently by Match-V5's participant record.

## Requirements

### Requirement 1: Timeline Retrieval

**User Story:** As a visitor, I want to open a single match and see how its build came together, without every other match paying for it.

#### Acceptance Criteria

1. THE System SHALL retrieve a Match_Timeline only in response to an explicit request for one match's Build_Path, and SHALL NOT retrieve any Match_Timeline as part of assembling a Profile_Report.
2. THE Riot_API_Client SHALL call Match-V5's timeline endpoint using the Regional_Routing_Value derived from the platform identifier encoded in the match identifier.
3. THE Riot_API_Client SHALL apply the same 10-second per-call timeout, rate-limit reservation, and 429 retry policy to the timeline call as to every other Riot API call.
4. THE System SHALL bound the number of Match_Timeline responses being parsed concurrently, so that transient parse memory cannot grow with request volume.
5. IF a Match_Timeline is not available for a match identifier that has a valid match detail, THEN THE System SHALL report that the Build_Path is unavailable for that match and SHALL NOT surface an error.

### Requirement 2: Shop Event Replay

**User Story:** As a visitor, I want the build path to show what I actually bought, so that a misclick I immediately undid does not appear as part of my build.

#### Acceptance Criteria

1. THE System SHALL derive the Build_Path by replaying the analyzed player's Shop_Events in ascending timestamp order, and SHALL NOT derive it by filtering for purchase events alone.
2. WHEN an item-undone event is replayed, THE System SHALL reverse the most recent not-yet-reversed shop action it corresponds to, such that the resulting Build_Path and Reconstructed_Inventory are identical to those that would result had the reversed action never occurred.
3. WHEN an item-sold event is replayed, THE System SHALL remove the item from the Reconstructed_Inventory and SHALL retain the original acquisition in the Build_Path, because the item was genuinely acquired before being sold.
4. WHEN an item-destroyed event is replayed, THE System SHALL remove the item from the Reconstructed_Inventory and SHALL retain the original acquisition in the Build_Path.
5. THE System SHALL identify the analyzed player's Participant_Slot using the participant mapping carried within the Match_Timeline itself, and SHALL NOT infer it from the ordering of any other response.
6. THE System SHALL extract Shop_Events for the analyzed player's Participant_Slot only, and SHALL NOT allow any other participant's events to affect the Build_Path.
7. THE System SHALL produce a Build_Path whose entries are in non-decreasing timestamp order.

### Requirement 3: Build Path Presentation

**User Story:** As a visitor, I want to see the items that mattered rather than every component, so that the build path is readable.

#### Acceptance Criteria

1. WHEN a Build_Path is displayed, THE System SHALL display each acquisition as an item image with the game time at which it occurred.
2. THE System SHALL distinguish Component_Items from completed items using the item metadata already retrieved by the Static_Data_Provider, and SHALL NOT introduce a second source for that classification.
3. THE System SHALL allow the visitor to view the Build_Path restricted to completed items, and SHALL default to that restricted view.
4. THE System SHALL display game time relative to the start of the match, not as a wall-clock timestamp.
5. THE System SHALL display the Build_Path for the analyzed player only.
6. THE System SHALL continue to display the lane opponent's Final_Build as specified by the `visual-assets` feature, and SHALL NOT display a Build_Path for the lane opponent.
7. THE System SHALL give every item image in a Build_Path a non-empty text alternative, consistent with the accessibility rules already applied to item images.
8. THE System SHALL render the Build_Path in the Build Path tab of the Detail_Panel established by the `match-detail-tabs` feature, replacing that tab's not-yet-available message.
9. THE System SHALL retrieve a Build_Path only in response to the Build Path tab being selected for a match, and SHALL NOT retrieve one when a Detail_Panel is expanded or when any other tab is selected.
10. THE Build Path tab SHALL display its own loading state while a Build_Path is being retrieved, and SHALL display Requirement 6's unavailable state within the tab rather than as a page-level error.

### Requirement 4: Reconciliation Against the Final Build

**User Story:** As a system operator, I want the replay checked against data the application already has, so that a reconstruction error is detected rather than displayed.

#### Acceptance Criteria

1. WHEN a Build_Path is derived, THE System SHALL compare the Reconstructed_Inventory at game end against the Final_Build reported by Match-V5's participant record for the same player and match.
2. WHEN the comparison agrees, THE System SHALL mark the Build_Path as reconciled.
3. IF the comparison disagrees, THEN THE System SHALL mark the Build_Path as unreconciled, SHALL still display it, and SHALL indicate to the visitor that the reconstruction may be incomplete.
4. IF the comparison disagrees, THEN THE System SHALL record the match identifier and the nature of the disagreement in server-side logging, so that unhandled item behaviors can be identified from real data.
5. THE System SHALL NOT discard, suppress, or silently correct a Build_Path that fails Reconciliation.

### Requirement 5: Retention and Payload Handling

**User Story:** As a system operator, I want timelines never retained in full, so that adding this feature cannot exhaust memory.

#### Acceptance Criteria

1. THE System SHALL NOT write a Match_Timeline to the Cache_Store.
2. THE System SHALL discard the Match_Timeline once the Timeline_Slice has been extracted from it.
3. THE Cache_Store SHALL support a cache entry type for a Timeline_Slice, keyed on the match identifier and the PUUID of the player it describes.
4. THE System SHALL retain a Timeline_Slice indefinitely, since a completed match's events are immutable.
5. WHEN a non-stale Timeline_Slice exists for a match and player, THE System SHALL use it and SHALL NOT retrieve the Match_Timeline.
6. WHEN a deletion request is processed for a PUUID, THE Cache_Store SHALL remove every Timeline_Slice describing that PUUID along with every other entry in which the PUUID appears.

### Requirement 6: Degradation

**User Story:** As a visitor, I want a match whose timeline cannot be loaded to still show everything else, so that one missing detail does not cost me the row.

#### Acceptance Criteria

1. IF a Match_Timeline retrieval fails for any reason, THEN THE System SHALL continue to display the match row and its Final_Build, and SHALL indicate only that the Build_Path is unavailable.
2. IF the analyzed player has no Participant_Slot in a retrieved Match_Timeline, THEN THE System SHALL report the Build_Path as unavailable and SHALL NOT display a partial or empty Build_Path.
3. IF a Shop_Event references an item identifier unknown to the pinned item metadata, THEN THE System SHALL retain that acquisition in the Build_Path and SHALL display it with a placeholder image and the raw identifier as its text alternative.
4. THE System SHALL NOT block the display of a Profile_Report on the availability of any Build_Path.

### Requirement 7: Scope Boundary

**User Story:** As a maintainer, I want this feature's deliberate limits recorded, so that they are recognised as decisions rather than mistaken for gaps.

#### Acceptance Criteria

1. THE System SHALL extract Build_Path data for one Participant_Slot per Match_Timeline retrieval, and the extraction SHALL be parameterised by Participant_Slot so that extracting additional participants requires no change to the replay logic.
2. THE System SHALL NOT derive gold, experience, position, ward, kill, or objective data from a Match_Timeline under this feature.
3. THE System SHALL NOT present any timing comparison between the analyzed player and the lane opponent, since Build_Path timings are retrieved for the analyzed player only.

### Requirement 8: Riot Compliance

**User Story:** As a system operator, I want the build path display to satisfy the same Riot obligations as every other page, so that the feature does not create a compliance gap.

#### Acceptance Criteria

1. THE System SHALL display the required Riot attribution statement wherever a Build_Path is rendered, as on every other page rendering Riot data.
2. THE System SHALL exclude advertising and sponsored-content slots from views rendering a Build_Path, consistent with the policy applied to every other page rendering Riot data.
3. THE System SHALL serve item images for a Build_Path from Riot's distribution unmodified, consistent with the asset policy already in force.
