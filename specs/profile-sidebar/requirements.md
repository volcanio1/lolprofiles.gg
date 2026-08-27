# Requirements Document

## Introduction

The Profile_Report currently renders as one long, single-column stack: identity, ranked standing, recent form, top champions, recent matches, then fun facts and recommendations. A visitor scrolls past the player's own summary just to reach the content they came for — recent matches — and loses that summary entirely once they've scrolled past it.

Both reference sites named for this feature (op.gg, dpm.lol) solve this the same way: a persistent left rail carries the player's identity and at-a-glance stats, while match-by-match detail scrolls independently in a wider main column beside it.

**This feature grew in scope partway through spec'ing it, and that growth needs to be stated plainly.** It started as a pure layout rearrangement (Requirements 1–6: no new data, no backend change). Direct observation of dpm.lol's actual sidebar (relayed by the user, since this tool could not reach dpm.lol directly — it returned an HTTP 403 bot-check) added three things that are **not** pure layout:

1. A **rank-over-time line graph** for Ranked Solo/Duo, at the top of the sidebar.
2. A **gamemode filter** that re-scopes the champion-preferences panel and the recent-matches list to a selected queue type.
3. A **role performance** breakdown (games, win rate, per role) that doesn't exist as a computed value anywhere in this codebase today.

Each of these needs new backend computation or new backend storage, detailed in Requirements 7–10. Requirement 10 (the rank graph) is the one with a real architectural cost: **Riot's API exposes only a player's current rank, never a history of it.** The only way to have a rank-over-time graph is for this system to start recording a snapshot every time it looks a player up, from the day this ships forward. There is no way to backfill the past, and the graph is empty for a player who has never been looked up before. Building a graph with per-game granularity (a point after every ranked game, the way a continuously-polling tracker could) is out of scope — this system only observes a player at the moments someone looks them up, and Requirement 10 is written against that constraint, not against dpm.lol's presumed granularity. This is documented explicitly here and in design.md's "Open Questions" so it isn't discovered as a surprise during implementation.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend), unless a more specific subsystem is named.
- **Profile_Report**: The aggregated report object returned by `POST /api/lookup`, as defined by `frontend/src/api/types.ts` / `backend/src/orchestrator/index.ts`.
- **Sidebar_Rail**: The persistent left-hand column holding the player's identity and at-a-glance stats.
- **Main_Column**: The right-hand (or, on narrow viewports, lower) column holding match-by-match detail.
- **Identity_Card**: The Sidebar_Rail's top section — profile icon, Riot_ID, tag line, and summoner level.
- **Narrow_Viewport**: A viewport too narrow to show the Sidebar_Rail and Main_Column side by side, per Requirement 5.
- **Allowed_Queue_Type**: One of the three queue classifications this system already captures — `'ranked solo/duo'`, `'ranked flex'`, `'normal'` — per `backend/src/orchestrator/mapping.ts`. ARAM and every other queue are excluded from analysis entirely, and remain excluded by this feature (see Requirement 9.5).
- **Queue_Filter_Value**: `'all'` or one Allowed_Queue_Type, the value a Gamemode_Filter control can be set to.
- **Gamemode_Filter**: A control that sets a Queue_Filter_Value, scoping which matches contribute to the panel(s) it governs.
- **Sidebar_Queue_Filter**: The Gamemode_Filter instance governing the Champion_Preferences panel and the Role_Performance panel; defaults to `'ranked solo/duo'` (Requirement 9.4).
- **Recent_Matches_Filter**: The Gamemode_Filter instance governing the recent-matches list in the Main_Column; defaults to `'all'` (Requirement 9.4). Kept independent of the Sidebar_Queue_Filter — see design.md's documented decision on why these are two filters, not one shared filter, despite dpm.lol appearing to use a single control.
- **Champion_Preferences**: The existing top-champions content (games, win rate, KDA, CS/min per champion), computed against whatever Queue_Filter_Value the Sidebar_Queue_Filter is set to, rather than always against every Allowed_Queue_Type combined.
- **Role_Performance**: A new per-role breakdown — games played and win rate for each role the player has played, computed against the Sidebar_Queue_Filter's selected Queue_Filter_Value.
- **Rank_Snapshot**: One recorded observation of a player's rank for one queue type at one point in time: `{ puuid, queueType, tier, division, leaguePoints, observedAt }`, captured at the moment of a lookup.
- **Rank_History**: The ordered sequence of Rank_Snapshots this system has recorded for a given PUUID and queue type, oldest first.
- **Persistent_Store**: A storage layer that survives process restarts and does not evict entries by TTL — required for Rank_History, and explicitly NOT the same component as the existing Cache_Store (which is in-memory and TTL-bound; see design.md).

## Requirements

### Requirement 1: Two-Column Layout

**User Story:** As a visitor, I want the player's identity and summary stats to stay visible while I scroll through their match history, so that I don't lose that context partway down the page.

#### Acceptance Criteria

1. WHEN a Profile_Report is displayed on a viewport at or above the two-column breakpoint (Requirement 5), THE System SHALL render the Sidebar_Rail and the Main_Column as two side-by-side columns within the report.
2. THE System SHALL place the Identity_Card, the Rank_History graph, the Sidebar_Queue_Filter, the ranked-standing cards, the Champion_Preferences panel, and the Role_Performance panel in the Sidebar_Rail, in that order.
3. THE System SHALL place the Recent_Matches_Filter, the recent-matches list, the fun facts section, and the recommendations section in the Main_Column, in that order.
4. THE System SHALL NOT change the wording or underlying source of any relocated section beyond what Requirements 7–10 explicitly require.

### Requirement 2: Sidebar Persistence on Scroll

**User Story:** As a visitor, I want the sidebar to stay in view as I scroll the match history, the way it does on op.gg and dpm.lol, so that I always know whose report I'm looking at.

#### Acceptance Criteria

1. WHEN the Main_Column's content is taller than the viewport AND the viewport is at or above the two-column breakpoint, THE System SHALL keep the Sidebar_Rail visible within the viewport as the visitor scrolls the Main_Column, up to the point defined by Requirement 2.3.
2. IF the Sidebar_Rail's own content is taller than the viewport, THEN THE System SHALL allow the Sidebar_Rail to scroll independently rather than clipping its content.
3. THE System SHALL stop the Sidebar_Rail's persistence before it overlaps the page footer, so the Riot attribution statement (Requirement 4) is never obscured by the sidebar.
4. THE System SHALL NOT apply sidebar persistence on a Narrow_Viewport, where the Sidebar_Rail and Main_Column are not side by side.

### Requirement 3: Sidebar Identity Content

**User Story:** As a visitor, I want the sidebar to answer "who is this" without any scrolling, so that I get the headline read immediately.

#### Acceptance Criteria

1. THE Identity_Card SHALL display the analyzed player's profile icon, Riot_ID (gameName and tagLine), and summoner level.
2. THE Sidebar_Rail SHALL display the existing ranked-standing content for every queue type present on the Profile_Report, unchanged in source, or the existing "Unranked in every queue" message when none are present.

### Requirement 4: Compliance Continuity

**User Story:** As a system operator, I want the sidebar to inherit the same compliance guarantees as the rest of the report, so that a layout change cannot create a compliance gap.

#### Acceptance Criteria

1. THE System SHALL render the Sidebar_Rail and Main_Column inside the existing `RiotDataPage` template, unchanged, so the Riot attribution statement and the no-advertising default continue to apply.
2. THE System SHALL NOT place an advertising slot inside the Sidebar_Rail outside of the existing, agreement-gated advertising mechanism.

### Requirement 5: Responsive Fallback

**User Story:** As a visitor on a phone or a narrow window, I want the report to remain fully readable, so that the sidebar concept doesn't break the page on small screens.

#### Acceptance Criteria

1. THE System SHALL define a two-column breakpoint below which the Sidebar_Rail and Main_Column stack vertically as a single column, matching a Narrow_Viewport.
2. WHEN stacked on a Narrow_Viewport, THE System SHALL render the Sidebar_Rail's sections above the Main_Column's sections, preserving Requirement 1's within-column ordering.
3. THE System SHALL NOT apply sidebar persistence (Requirement 2) on a Narrow_Viewport; the stacked layout SHALL scroll as a single flow.
4. THE System SHALL keep every existing touch target and text at its current, already-accessible size when stacked.

### Requirement 6: No Regression to Existing Behavior

**User Story:** As the developer maintaining this codebase, I want the layout change to be as close to a pure rearrangement as this feature's new content allows, so that every existing guarantee about the report's content survives untouched.

#### Acceptance Criteria

1. THE System SHALL continue to satisfy every requirement of the `visual-assets` feature (champion icons, profile icon, item builds) unchanged, regardless of which column a section now renders in.
2. THE System SHALL continue to render every `data-testid` currently present on `ProfileReportView`'s sections that are relocated without content change (Identity_Card, ranked standing, recent matches, fun facts, recommendations), so existing tests addressing those sections keep passing without modification to their assertions.
3. THE System SHALL NOT change the heading hierarchy (`h2`/`h3`) of any relocated section; a screen reader's heading-based navigation SHALL find the same headings in the same relative order as before, split across two landmark regions rather than reordered within one.

### Requirement 7: Champion Preferences Scoped by Queue

**User Story:** As a visitor, I want to see a player's most-played champions for the queue I actually care about (usually ranked solo/duo), not blended across every game mode this system tracks, so that the numbers reflect the context I'm asking about.

#### Acceptance Criteria

1. THE System SHALL compute Champion_Preferences (games, win rate, average KDA, average CS/min per champion) separately for `'all'` and for each Allowed_Queue_Type, rather than only once across every Allowed_Queue_Type combined.
2. WHEN the Sidebar_Queue_Filter's Queue_Filter_Value changes, THE System SHALL display the Champion_Preferences computed for that value, with no additional network request.
3. THE System SHALL preserve the existing ordering rule (games DESC, win rate DESC, name ASC) and the existing 5-champion cap within each computed slice.
4. IF a given Queue_Filter_Value has zero included matches, THEN THE System SHALL display the existing "no matches available" message for that slice, not an error.
5. THE System SHALL lay out Champion_Preferences suitably for the Sidebar_Rail's narrower width, per the `visual-assets` feature's existing icon components, rather than reusing the Main_Column's wide table layout unchanged if that would force horizontal scrolling inside the sidebar.

### Requirement 8: Role Performance

**User Story:** As a visitor, I want to see which roles a player actually wins on, not just which role they play most, so that I can judge their strength in context.

#### Acceptance Criteria

1. THE System SHALL compute Role_Performance as games played and win rate per role, derived from the same included-match set Champion_Preferences (Requirement 7) draws from, for `'all'` and for each Allowed_Queue_Type.
2. THE System SHALL classify a match's role using the same `roleOf` logic already used elsewhere in the orchestrator (`teamPosition`, falling back to `role`), so Role_Performance's role names are consistent with the rest of the report.
3. IF a match's role cannot be determined (blank per the existing `roleOf` fallback), THEN THE System SHALL exclude that match from Role_Performance rather than inventing a role bucket for it.
4. WHEN the Sidebar_Queue_Filter's Queue_Filter_Value changes, THE System SHALL display the Role_Performance computed for that value, with no additional network request.
5. IF a given Queue_Filter_Value has zero matches with a determinable role, THEN THE System SHALL display an explicit "not enough data" message, not an empty or error state.

### Requirement 9: Gamemode Filter

**User Story:** As a visitor, I want to switch between "ranked solo/duo" and "everything" without leaving the page, so that I can see a player's ranked form specifically or their overall activity, on demand.

#### Acceptance Criteria

1. THE Sidebar_Rail SHALL expose a Sidebar_Queue_Filter control offering `'all'` and every Allowed_Queue_Type present in the Profile_Report's included matches.
2. THE Main_Column SHALL expose a Recent_Matches_Filter control, independent of the Sidebar_Queue_Filter, offering the same set of values.
3. Changing either filter SHALL affect only the panel(s) it governs (Requirement 1.2/1.3), and SHALL NOT require a new network request, since Requirement 7.1's per-queue computation is already delivered with the Profile_Report.
4. ON initial render of a Profile_Report, THE System SHALL default the Sidebar_Queue_Filter to `'ranked solo/duo'` and the Recent_Matches_Filter to `'all'`.
5. THE System SHALL NOT offer ARAM or any queue type outside the three Allowed_Queue_Types as a filter option; expanding queue capture to include ARAM is out of scope for this feature (see design.md).
6. IF `'ranked solo/duo'` has zero included matches for a given player, THEN THE System SHALL still default the Sidebar_Queue_Filter to `'ranked solo/duo'` per 9.4, and SHALL rely on Requirements 7.4/8.5's empty-state messages rather than silently falling back to a different default.

### Requirement 10: Ranked Solo/Duo Rank History Graph

**User Story:** As a visitor, I want to see how a player's rank has moved over the times they've been looked up, so that I get a sense of their recent trajectory rather than just a single snapshot.

#### Acceptance Criteria

1. WHEN a lookup for a Riot_ID completes successfully AND that player has a League-V4 entry for `'ranked solo/duo'`, THE System SHALL record a Rank_Snapshot for that PUUID and queue type in the Persistent_Store.
2. THE System SHALL record a Rank_Snapshot at most once per PUUID per queue type per calendar day, so repeated lookups within the same day do not distort the graph's spacing.
3. THE Sidebar_Rail SHALL render the recorded Rank_History for `'ranked solo/duo'` as a line graph, ordered oldest to newest, at the top of the Sidebar_Rail.
4. IF fewer than two Rank_Snapshots exist for the current PUUID's `'ranked solo/duo'` queue, THEN THE System SHALL display an explicit message that history will build up over future lookups, rather than an empty or broken graph.
5. THE System SHALL label the graph's horizontal axis as "lookups over time," not "games played," since a Rank_Snapshot is recorded once per lookup rather than once per completed game — the System has no way to observe every game a player completes, only the rank visible at the moment someone looks them up.
6. THE System SHALL NOT attempt to backfill Rank_History for any period before this feature's Persistent_Store began recording snapshots; a player's history starts empty at deployment and grows only from lookups made after that point.
7. THE Persistent_Store used for Rank_History SHALL survive an application restart; the existing in-memory, TTL-evicting Cache_Store SHALL NOT be used for this purpose (see design.md for the storage options considered).
