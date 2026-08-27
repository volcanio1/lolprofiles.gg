# Requirements Document

## Introduction

The recent-matches section currently renders each match as a two-row table: the analyzed player's line stats above their lane opponent's, with each side's Final_Build beneath. It answers "how did this lane go" and nothing else. The eight other players in the game are fetched, parsed, and then discarded.

This feature rebuilds that section into the shape op.gg and dpm.lol use. Each match becomes a **mirrored summary row** — the analyzed player on the left, their lane opponent on the right, each with their champion portrait, summoner spells, keystone, and secondary rune tree — above an **expandable Detail_Panel** carrying three tabs: General (the full ten-player scoreboard), Build Path, and Runes.

Four facts drive the work, and each is a place where the obvious implementation is wrong.

**The data is already in hand, but the wire type does not carry it.** Match-V5's match detail returns all ten participants with 156 fields each, and the orchestrator already fetches and caches every one of those responses indefinitely. Nothing in the General or Runes tab requires a new Riot call. But `MatchParticipantDto` — the application's own narrowed view of a participant — currently declares only puuid, championName, teamPosition, role, teamId, win, K/D/A, visionScore, minion counts and the seven item slots. Every spell, rune, level, damage and gold field this feature displays is absent from it. Requirement 6 names them explicitly rather than leaving "capture the participants" to be interpreted.

**Identifying the lane opponent among the ten is not free.** The mirrored row needs the Enemy_Laner's spells and runes, and `opponentOf` — the existing selection that `visual-assets` Requirement 3.9 already pins as the single source for the opponent's items — is module-private and returns a summary carrying no participant identity. Matching by champion name is genuinely ambiguous: Blind Pick (queue 430) is in the allowlisted queue set and permits the same champion on both teams. Requirement 6 therefore marks the Enemy_Laner in the participant list, from the same row `opponentOf` chose.

**Build Path is the exception, and it is not negotiable.** The `item-timeline` feature's Requirement 1.1 forbids retrieving a Match_Timeline while assembling a Profile_Report, because a timeline response is one to five megabytes. The Build Path tab is therefore lazy by construction, and it stays empty until that feature lands. Requirement 5 defines the tab, its empty state, and the contract `item-timeline` must satisfy to fill it — including the fact, easy to miss in a panel whose other two tabs show ten players, that the Build Path shows exactly one.

**Rune icons cannot be version-pinned, and this amends an existing invariant.** `visual-assets` Requirement 4.1 required every asset URL to resolve against one pinned version, stated absolutely — and has since been amended, by this feature, to read "except as criterion 7 provides". Verified against the live CDN: rune icons at `/cdn/{version}/img/perk-images/...` return **403**, and only the unversioned `/cdn/img/perk-images/...` returns 200. Stat shard icons behave identically and are absent from `runesReforged.json` entirely. Requirement 7 states this as an explicit, narrow exception, states its real consequence — rune imagery *will* drift with Riot patches, which is exactly what `visual-assets` Requirement 4.2 was written to prevent — and requires the amendment be recorded in `visual-assets` rather than living only here.

**ARAM and ARAM Mayhem are real, distinct queues, and Mayhem's augments live on a CDN this codebase has never called.** Riot's published queue table lists `450` ("5v5 ARAM games") and `2400` ("ARAM: Mayhem") as separate, current queue ids — verified against `https://static.developer.riotgames.com/docs/lol/queues.json` — and every Match-V5 participant, in every queue, already carries `playerAugment1` through `playerAugment6`, reporting `0` in every queue but Mayhem, where up to six are non-zero. But Data_Dragon serves no augment metadata or imagery at all — `cdn/{version}/data/en_US/augments.json` and every augment image path return 403 on the pinned version, verified live. Augment name and icon data exists only on Community Dragon, a separate Riot-operated CDN this codebase has never depended on, and it is pinnable the same way Data_Dragon is — `raw.communitydragon.org/{major}.{minor}/...`, verified live against `16.17` (the pinned `DDRAGON_VERSION`'s major and minor) — but it is not the same CDN, and Requirement 12 states the exception it needs rather than silently reusing Data_Dragon's rules for a different host.

Two scope notes. The allowlisted queue set (`QUEUE_TYPE_BY_QUEUE_ID`) admits only 5v5 Summoner's Rift queues — 400, 420, 430, 440, 480, 490 — so **Clash, Co-op vs AI and every rotating event mode still never reach the recent-matches list**, and every match those six queues admit has lane assignment. ARAM (450) and ARAM Mayhem (2400) are the one deliberate exception: Requirement 11 admits them to the recent-matches list and this feature's Detail_Panel through a second, parallel capture path that never touches `QUEUE_TYPE_BY_QUEUE_ID` or the role-relative stats it feeds — a laneless match counts for display and never counts for a role-relative number. Requirement 12 covers ARAM Mayhem's one further difference: augments stand in for the Runes tab, because Mayhem participants have no meaningful rune page to show and do have an augment set the other five queues never carry. And the Static_Data_Provider extension this feature needs is **also specified by the unimplemented `live-game` feature** (its Requirement 7.2); Requirement 7 reconciles the two rather than letting both claim ownership.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend combined), unless a more specific subsystem is named.
- **Profile_Report**: The aggregated report object returned by `POST /api/lookup`.
- **Analyzed_Player**: The player whose Riot_ID was looked up.
- **Enemy_Laner**: The opposing participant sharing the Analyzed_Player's lane, as already identified by `opponentOf` in the orchestrator's mapping module.
- **Participant**: One of the ten players in a match, as reported by a Match-V5 participant record.
- **Match_Row**: The always-visible summary of one match in the recent-matches list.
- **Detail_Panel**: The collapsible region beneath a Match_Row, containing the three tabs.
- **Summoner_Spell**: One of a Participant's two summoner spells, reported by Match-V5 as the numeric fields `summoner1Id` and `summoner2Id`.
- **Rune_Page**: A Participant's complete rune selection: four primary-tree runes, two secondary-tree runes, the two tree identifiers, and three Stat_Shards.
- **Stat_Shard**: One of the three small stat runes reported in Match-V5's `perks.statPerks` (`offense`, `flex`, `defense`).
- **Keystone**: The first rune of a Rune_Page's primary tree — the first entry of `perks.styles[0].selections`.
- **Position_Order**: The fixed ordering `TOP`, `JUNGLE`, `MIDDLE`, `BOTTOM`, `UTILITY`, being the five values Match-V5's `teamPosition` field takes when a position was assigned.
- **Static_Data_Provider**: The frontend component, established by `visual-assets`, that resolves Riot identifiers into Data_Dragon asset URLs and display names.
- **Data_Dragon_Version**: The single pinned Data_Dragon release identifier held in backend configuration as `DDRAGON_VERSION`.
- **Final_Build**: The six items and trinket a Participant held at game end, already specified and rendered by `visual-assets`.
- **Build_Path**: The ordered sequence of item acquisitions with timestamps, specified by the `item-timeline` feature.
- **Kill_Participation**: The share of a Participant's own team's total kills that the Participant took part in, as a kill or an assist.
- **Team_Side**: A Participant's team, reported by Match-V5 as `teamId` with the values 100 and 200.
- **Laneless_Match**: A match played in queue 450 (ARAM) or 2400 (ARAM: Mayhem) — a match with no `teamPosition` assignment and no Enemy_Laner, admitted to the recent-matches list by Requirement 11 through a path that never touches `QUEUE_TYPE_BY_QUEUE_ID` or the role-relative stats it feeds.
- **Augment**: One of a Participant's ARAM Mayhem augment selections, reported by Match-V5 as one of six numeric fields `playerAugment1` through `playerAugment6`, each `0` when unused. Present and always `0` in every other queue.
- **Community_Dragon**: A separate Riot-operated static content CDN, distinct from Data_Dragon, that publishes augment metadata and imagery Data_Dragon does not carry. Pinnable by major-and-minor version the same way Data_Dragon is pinned by full version.

## Requirements

### Requirement 1: Mirrored Match Row

**User Story:** As a visitor, I want each match to read as my player versus their opponent at a glance, so that I can scan a match history without expanding anything.

#### Acceptance Criteria

1. THE System SHALL render each Match_Row with the Analyzed_Player's side on the left and the Enemy_Laner's side on the right.
2. THE System SHALL display, for each of the two sides, the Participant's champion portrait, both Summoner_Spell icons, the Keystone icon, and the secondary rune tree icon, positioned adjacent to the champion portrait.
3. THE System SHALL continue to display, for each of the two sides, the kills, deaths, assists, creep score, creep score per minute, and vision score that the recent-matches section displays today.
4. THE System SHALL continue to display, for each of the two sides, the Final_Build already specified by `visual-assets`.
5. THE System SHALL continue to display each match's outcome, the Analyzed_Player's role, and the match start time, which the recent-matches section displays today.
6. THE System SHALL additionally display each match's duration and queue type, which the recent-matches section does not display today.
7. IF no Enemy_Laner was identified for a match, THEN THE System SHALL render the Analyzed_Player's side and SHALL display the existing no-opponent notice in place of the opposing side, and SHALL NOT render empty opposing portraits, spells, runes, or item slots.

### Requirement 2: Expandable Detail Panel

**User Story:** As a visitor, I want to open one match and see the whole game, so that I can understand a result the two-player summary cannot explain.

#### Acceptance Criteria

1. THE System SHALL provide, on every Match_Row, a control that expands and collapses that row's Detail_Panel.
2. THE System SHALL render every Detail_Panel collapsed on initial render of a Profile_Report.
3. THE Detail_Panel SHALL present exactly three tabs, in the order General, Build Path, Runes.
4. WHEN a Detail_Panel is expanded for the first time, THE System SHALL select the General tab; on any subsequent expansion of that same Match_Row, THE System SHALL restore the tab that row had selected when it was collapsed.
5. THE System SHALL allow more than one Match_Row's Detail_Panel to be expanded at the same time, and SHALL keep each row's expansion state and selected tab independent of every other row's.
6. THE System SHALL implement the tabs such that a keyboard user can reach and operate them, and SHALL associate each tab with the panel it controls for assistive technology.
7. THE System SHALL NOT issue any request to its own backend or to the Riot API when a Detail_Panel is expanded or when the General or Runes tab is selected. This constrains data retrieval only; the Data_Dragon image requests that rendering the newly-revealed icons necessarily produces are permitted.

### Requirement 3: General Tab

**User Story:** As a visitor, I want the full scoreboard for a match, so that I can see whether a lane result was decided by the lane or by the rest of the map.

#### Acceptance Criteria

1. THE General tab SHALL display every Participant the match carries, grouped into two blocks by Team_Side, with the Analyzed_Player's team first.
2. THE System SHALL display, for each Participant, the champion portrait and Champion_Display_Name, both Summoner_Spell icons, the Keystone icon, the secondary rune tree icon, the Participant's Riot_ID, the champion level, and the Final_Build.
3. THE System SHALL display, for each Participant, the kills, deaths, assists, creep score, vision score, damage dealt to champions, gold earned, and Kill_Participation.
4. THE System SHALL compute Kill_Participation as the sum of a Participant's kills and assists divided by the total kills of that Participant's own team, expressed as a whole-number percentage.
5. THE System SHALL derive a team's total kills by summing the kills of the Participants it displays for that team, so that the displayed Kill_Participation is consistent with the displayed kills.
6. IF a team's total kills is zero, THEN THE System SHALL display Kill_Participation as `N/A` rather than as a percentage.
7. THE System SHALL visually distinguish the Analyzed_Player's row from the others, and SHALL do so by a means that is not colour alone.
8. THE System SHALL order the Participants within each team block by Position_Order, and SHALL place every Participant whose `teamPosition` is not one of Position_Order's five values after those whose is, preserving Riot's reported order among them.

### Requirement 4: Runes Tab

**User Story:** As a visitor, I want to see what every player in the game ran, so that I can learn a rune setup I have not seen before.

#### Acceptance Criteria

1. THE Runes tab SHALL display the same Participants the General tab displays, grouped and ordered identically.
2. THE System SHALL display, for each Participant, the champion portrait and the Participant's complete Rune_Page.
3. THE System SHALL display, for each Rune_Page, the four primary-tree rune icons, the two secondary-tree rune icons, both rune tree icons, and the three Stat_Shard icons.
4. THE System SHALL visually group each Rune_Page's primary-tree runes, secondary-tree runes, and Stat_Shards as three distinguishable groups.
5. THE System SHALL preserve the order in which Match-V5 reports the runes within each tree, because that order encodes which slot each rune was chosen from.

### Requirement 5: Build Path Tab

**User Story:** As a visitor, I want the Build Path tab to tell me it is coming rather than appear broken, so that an unfinished feature does not read as a defect.

#### Acceptance Criteria

1. THE Build Path tab SHALL exist and be selectable from the moment this feature ships.
2. UNTIL the `item-timeline` feature is complete, THE Build Path tab SHALL display an explicit message stating that the build path is not yet available, and SHALL NOT display an empty region, an error, or a loading state that never resolves.
3. THE System SHALL NOT retrieve a Match_Timeline as part of assembling or rendering a Profile_Report, consistent with `item-timeline` Requirement 1.1.
4. WHEN the `item-timeline` feature is complete, THE Build Path tab SHALL retrieve that match's Build_Path only in response to that tab being selected, and SHALL NOT retrieve it when the Detail_Panel is expanded or when another tab is selected.
5. THE Build Path tab SHALL display the Build_Path for the Analyzed_Player only, consistent with `item-timeline` Requirements 3.5 and 7.3, notwithstanding that the General and Runes tabs display every Participant.
6. THE Build Path tab SHALL own its own loading state and its own unavailable state, and SHALL NOT surface either as a Match_Row-level or page-level error.

### Requirement 6: Participant Capture

**User Story:** As a system operator, I want the wider match data to cost no additional Riot calls and to leak no identifiers, so that a richer page does not create a rate-limit or privacy problem.

#### Acceptance Criteria

1. THE System SHALL capture every Participant from each Match-V5 match detail it already retrieves, and SHALL NOT issue any additional Riot API call to do so.
2. THE System SHALL capture, for each Participant: both Summoner_Spell identifiers, the complete rune selection including both tree identifiers, all six primary and secondary rune selections and all three Stat_Shard identifiers, the champion identifier, the champion level, the assigned position, the team identifier, the Riot_ID game name and tag line, kills, deaths, assists, minion and neutral-monster kills, vision score, damage dealt to champions, gold earned, the win flag, and the seven Item_Slots.
3. THE System SHALL extend its Riot API participant type to declare every field criterion 2 requires, none of which it declares today.
4. THE System SHALL capture the queue type that Requirement 1.6 displays, which the recent-match payload does not carry today. The match duration Requirement 1.6 also displays is already carried and requires no capture.
5. THE System SHALL deliver the captured Participants to the frontend such that the General and Runes tabs can render without any further request.
6. THE System SHALL NOT include the PUUID of any Participant in any Participant record it delivers, including the Analyzed_Player's own. The Profile_Report's existing top-level `puuid` field is out of scope for this requirement and is unchanged.
7. THE System SHALL identify which Participant is the Analyzed_Player, and which is the Enemy_Laner, by non-identifying markers, and SHALL NOT identify either by matching on champion identifier — champion identity is not unique within a match, because Blind Pick is among the allowlisted queue types and permits mirror picks.
8. THE System SHALL derive the Enemy_Laner marker from the same participant record that the existing opponent selection identified, and SHALL NOT derive it from any other participant, consistent with `visual-assets` Requirement 3.9.
9. THE System SHALL NOT deliver any identifier for a Participant beyond the Riot_ID that Riot itself exposes in-game. Criterion 6's prohibition on PUUIDs is the specific case of this rule that the Profile_Report would otherwise have violated.
10. THE System SHALL treat a malformed, absent, or non-numeric Participant field the same way the existing mapping module treats one, yielding a neutral value rather than throwing or excluding the match.
11. IF a match's participant list does not contain ten entries, THEN THE System SHALL render the Participants it does contain and SHALL NOT exclude the match or fail the Profile_Report.
12. THE System SHALL measure the Profile_Report payload size that criterion 5 causes and SHALL record the measurement in this feature's design document, so that a later increase to the recent-match limit is made with that cost visible. THE System SHALL NOT change the recent-match limit as part of this feature.

### Requirement 7: Summoner Spell and Rune Assets

**User Story:** As a visitor, I want spells and runes to render as the icons I recognise from the game, so that a scoreboard is readable at a glance rather than a table of numbers.

#### Acceptance Criteria

1. THE Static_Data_Provider SHALL retrieve Data_Dragon's summoner spell metadata and rune metadata, and SHALL retain them for no less than 24 hours, on the same terms as the champion and item metadata it already retrieves.
2. THE System SHALL resolve a Summoner_Spell's image from its numeric identifier against the pinned Data_Dragon_Version.
3. THE System SHALL resolve a rune's and a rune tree's image path from the pinned Data_Dragon_Version's rune metadata.
4. THE System SHALL request rune, rune tree, and Stat_Shard image files from Data_Dragon's unversioned image path, because the versioned path does not serve them. This is an explicit, narrow exception to `visual-assets` Requirement 4.1, confined to these three asset classes.
5. THE System SHALL record the exception in criterion 4 in the `visual-assets` requirements document, so that the invariant is amended where it is stated rather than contradicted from another spec.
6. THE System SHALL state, where the exception is recorded, that rune, rune tree, and Stat_Shard imagery is consequently not pinned and may change with a Riot patch without a deployment, while the mapping from identifier to image path remains pinned.
7. THE System SHALL hold the mapping from Stat_Shard identifier to image file within this codebase, because Data_Dragon publishes no metadata for Stat_Shards.
8. THE System SHALL treat the Static_Data_Provider extension this requirement describes as the same extension the `live-game` feature's Requirement 7.2 describes, such that whichever feature is implemented first satisfies it for the other, and neither implements it twice.
9. WHEN the persisted static-data index gains the spell or rune maps, THE System SHALL change its storage key, so that an index persisted by an earlier build cannot satisfy a later build's read and serve placeholders for its full retention period.
10. THE System SHALL NOT route any Data_Dragon request through the Rate_Limit_Manager, and SHALL NOT proxy any Data_Dragon image through the backend.
11. THE System SHALL apply the existing Asset_Placeholder behavior to any Summoner_Spell, rune, rune tree, or Stat_Shard identifier it cannot resolve.

### Requirement 8: Accessibility

**User Story:** As a visitor using a screen reader, I want the scoreboard and rune pages to convey what they show, so that a page made almost entirely of small icons is not silent.

#### Acceptance Criteria

1. THE System SHALL give every rendered Summoner_Spell, rune, rune tree, and Stat_Shard image a non-empty text alternative.
2. THE System SHALL use the Summoner_Spell's name as its text alternative, falling back to its numeric identifier when the name cannot be resolved.
3. THE System SHALL use the rune's, rune tree's, or Stat_Shard's name as its text alternative, falling back to its numeric identifier when the name cannot be resolved.
4. WHERE an Asset_Placeholder stands in for a Summoner_Spell, rune, rune tree, or Stat_Shard, THE System SHALL name the subject in the placeholder's text alternative rather than describing the absence alone, because these icons have no adjacent text naming them, unlike the champion icons the existing placeholder convention was written for.
5. THE System SHALL NOT convey a Participant's team, position, or identity through an image or a colour alone.
6. THE System SHALL present the General tab's scoreboard such that each Participant's statistics are associated with that Participant for assistive technology.

### Requirement 9: Degradation

**User Story:** As a visitor, I want a match row to stay readable when an asset or a field is missing, so that one absent icon does not cost me the match history.

#### Acceptance Criteria

1. IF Data_Dragon's summoner spell or rune metadata cannot be retrieved, THEN THE System SHALL render every Match_Row and every Detail_Panel in full with an Asset_Placeholder in place of each affected image, and SHALL NOT fail, blank, or block the recent-matches section.
2. IF a Participant's rune data is absent or malformed, THEN THE System SHALL render that Participant's other content and SHALL indicate that the Rune_Page is unavailable, and SHALL NOT omit the Participant.
3. THE System SHALL render no image element whose source could not be constructed.
4. THE System SHALL keep the recent-matches section's existing behavior for a match with an unresolvable Champion_Key and for a match with empty item slots, as specified by `visual-assets`. The no-Enemy_Laner case is specified by Requirement 1.7.
5. THE General and Runes tabs SHALL render every Participant regardless of whether an Enemy_Laner was identified, because their content does not depend on that selection.

### Requirement 10: Riot Compliance

**User Story:** As a system operator, I want the expanded match views to satisfy the same Riot obligations as every other part of the site, so that a richer page does not create a compliance gap.

#### Acceptance Criteria

1. THE System SHALL render every view displaying the new asset classes through the existing `RiotDataPage` wrapper, so that attribution and the no-advertising default apply without being re-implemented.
2. THE System SHALL serve summoner spell, rune, rune tree, and Stat_Shard images from Riot's distribution unmodified, and SHALL NOT rehost, alter, or re-brand them.
3. THE System SHALL NOT place an advertising slot within a Match_Row or a Detail_Panel.

### Requirement 11: Laneless Queue Support

**User Story:** As a visitor who plays ARAM, I want my ARAM games to show up in my match history with the same depth as my Summoner's Rift games, so that the feature is not silently unavailable for half of how I play.

#### Acceptance Criteria

1. THE System SHALL recognize queue 450 (ARAM) and queue 2400 (ARAM: Mayhem) as Laneless_Matches and SHALL admit them to the recent-matches list, through a capture path distinct from `QUEUE_TYPE_BY_QUEUE_ID`.
2. THE System SHALL NOT add queue 450 or queue 2400 to `QUEUE_TYPE_BY_QUEUE_ID`, and SHALL NOT include a Laneless_Match in any role-relative computation `QUEUE_TYPE_BY_QUEUE_ID`'s three allowed types feed, including win rate by role, champion preference by role, and kill participation by role. A Laneless_Match counts for display and never counts for a role-relative statistic.
3. THE System SHALL capture a Laneless_Match's Participants on the same terms Requirement 6 specifies for every other in-scope match, at no additional Riot API call, EXCEPT that THE System SHALL set every Participant's `isEnemyLaner` marker to false, because a Laneless_Match has no lane and therefore no Enemy_Laner.
4. THE System SHALL render a Laneless_Match's Match_Row with the Analyzed_Player's side populated as Requirement 1 already specifies, and SHALL display the existing no-opponent notice in place of the opposing side, on the same terms Requirement 1.7 already specifies for a match with no identified Enemy_Laner.
5. THE System SHALL NOT display the Analyzed_Player's role for a Laneless_Match, because Riot's `teamPosition` is blank and its `role` field carries values that do not describe an actual role in this queue — WHERE the existing role display would otherwise fall back to that field, THE System SHALL suppress the role rather than display it.
6. THE General tab SHALL display a Laneless_Match's ten Participants on the same terms Requirement 3 already specifies, ordered by Riot's reported order among them, because Requirement 3.8's Position_Order membership test already places every Participant whose `teamPosition` is not one of its five values — which is every Participant in a Laneless_Match — after those whose is, which resolves to no reordering when none match.
7. THE Runes tab SHALL display a standard ARAM (450) match's Participants and their Rune_Pages on the same terms Requirement 4 already specifies, because a standard ARAM match's `perks` data has the same shape as every other in-scope queue's. Requirement 12 states the one further exception this criterion does not cover: ARAM Mayhem (2400) replaces this tab with augments.
8. THE Build Path tab SHALL behave for a Laneless_Match exactly as Requirement 5 already specifies for every other match, with no exception.

### Requirement 12: ARAM Mayhem Augments

**User Story:** As a visitor who plays ARAM Mayhem, I want to see what augments every player picked, so that a Mayhem match history is as informative as a normal one.

#### Acceptance Criteria

1. THE System SHALL capture, for each Participant of an ARAM Mayhem (queue 2400) match, every non-zero value among `playerAugment1` through `playerAugment6`, in Riot's reported field order, at no additional Riot API call.
2. THE System SHALL treat a Participant's captured augments as between zero and six values, and SHALL NOT assume exactly six, because Riot leaves a slot at `0` (unused) for an augment not yet picked when a game ends early.
3. THE Detail_Panel SHALL replace the Runes tab with an Augments tab for an ARAM Mayhem match, and SHALL retain the Runes tab, unchanged, for every other queue including standard ARAM.
4. THE Augments tab SHALL display the same Participants the General tab displays, grouped and ordered identically, and SHALL display each Participant's champion portrait and captured augment icons in the order captured.
5. THE System SHALL resolve an augment's icon and display name from Community_Dragon, pinned to the major-and-minor version derived from the configured `DDRAGON_VERSION`, and SHALL NOT resolve it against a moving alias such as "latest".
6. THE System SHALL NOT route a Community_Dragon request through the Rate_Limit_Manager, which governs the rate-limited Riot game APIs only, and SHALL NOT route a Community_Dragon image request through the backend, consistent with how Data_Dragon requests are already handled.
7. THE System SHALL use the augment's resolved name as its text alternative, falling back to its numeric identifier when the name cannot be resolved, and SHALL apply the existing Asset_Placeholder behavior, naming the augment as its subject, to an augment identifier it cannot resolve.
8. THE System SHALL NOT display an augment's description or tooltip text, because no verified, complete data source for it exists across every ARAM Mayhem augment. THE System MAY add description display in a later feature once such a source is verified.
9. THE System SHALL treat a Participant with zero captured augments as a Participant who had not picked one when the match ended, and SHALL display that Participant's augment slots as empty rather than as unavailable or as an error.
