# Requirements Document

## Introduction

The profile report currently ends in two derived sections: **Fun Facts** (time-of-day preference, champion loyalty, role preference, win/loss streak) and **Improvement Recommendations** (survivability, champion selection, vision control). Both were reviewed and found generic — single-stat threshold checks against the player's own baseline, none of them relational, none of them specific to what the player actually did in a game.

This spec **removes both sections entirely** and replaces them with two new ones:

- **Fun Facts v2** — a set of narrative statistics: the champion you struggle against most, your longest game, your favorite item(s), and (new) your most-used ping.
- **Performance Feedback** — a set of coaching signals, computed **only from ranked games**, each shown **only when the player is actually lacking** on that metric. Nothing is shown just because a category exists to fill; an empty Performance Feedback section is a valid, meaningful outcome ("nothing stood out").

Two of the requested Performance Feedback signals — lane-phase death timing and the gold/CS diff at 10 minutes — need data this codebase does not currently fetch for every match (Match-V5's timeline, today fetched only on-demand for one match at a time when a visitor opens the Build Path tab). Fetching it for an entire recent-match window is a real cost increase, not a free addition, so this spec is split into two phases: **Phase 1** ships everything buildable from data already fetched for every match, **Phase 2** adds the two timeline-dependent signals once the fetch-volume trade-off is confirmed. See design.md's Rate Limiting section before starting Phase 2.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend services combined), unless a more specific subsystem is named.
- **Insight_Engine**: The pure, I/O-free backend module family (`backend/src/insight/`) that derives statistics, fun facts, and recommendations from an assembled match window. No network, cache, database, `process.env`, or wall-clock read.
- **Included_Match**: One match in the analyzed player's recent-match window that survived the existing queue-type/participant-capture filters (`IncludedMatch` in `backend/src/insight/stats.ts`) — the type this spec's new pure functions consume, exactly as the removed Fun Facts/Recommendations did.
- **Ranked_Match**: An Included_Match whose `queueType` is `'ranked solo/duo'` or `'ranked flex'` — the two `AllowedQueueType` values Riot's queue ids 420 and 440 map to (`backend/src/orchestrator/mapping.ts`). Normal games and every laneless queue (ARAM, ARAM Mayhem, Arena) are never Ranked_Matches.
- **Recent_Ranked_Window**: The most recent `PERFORMANCE_FEEDBACK_WINDOW` (30) Ranked_Matches by `startTimestamp`, out of however many Ranked_Matches exist in the full Included_Match window — the actual data source for every Performance Feedback category (Requirement 6). Deliberately narrower than the up-to-100-match Included_Match window so feedback tracks what the player is lacking NOW, not a stale average dragged down or propped up by games from weeks ago.
- **Lane_Opponent**: The enemy participant Riot's Match-V5 data places in the analyzed player's lane, already captured per match as `RawMatch.opponent` (`OpponentSummary`) — championName, KDA, CS, CS/min, vision score, final build. Absent when no opposing participant shares the lane (Requirement 6.11's existing degradation).
- **Full_Lobby**: The ten `MatchParticipant` rows Riot's Match-V5 response carries for a match, already threaded onto `RawMatch.participants` for `match-detail-tabs`' scoreboard — teamId, teamPosition, championName, KDA, CS, damage, gold, objective kill-credits, kill-participation percent, `isAnalyzedPlayer`, `isEnemyLaner`. No participant row carries a PUUID (existing Requirement 6.6/6.7). Optional on older cached matches computed before `match-detail-tabs` shipped; absent reads as "no lobby data for this match", not a failure.
- **Match_Timeline**: Match-V5's per-minute frame data (`GET /lol/match/v5/matches/{matchId}/timeline`) — participant gold/CS/position snapshots per frame and a stream of timestamped events (kills, item purchases, wards, objectives). Today fetched only for one match at a time, on-demand, when the Build Path tab is opened (`item-timeline` spec); never fetched for a whole match-history window. Phase 2 only.
- **Performance_Feedback_Category**: One of the seven signals this spec defines (Requirements 6-12), each independently triggered.

## Requirements

### Requirement 1: Remove the existing Fun Facts and Improvement Recommendations sections

**User Story:** As the site owner, I want the current Fun Facts and Improvement Recommendations logic removed outright, not deprecated alongside the new sections, so the report has one coherent, current implementation rather than two competing ones.

#### Acceptance Criteria

1. THE System SHALL remove `computeFunFacts` (`backend/src/insight/funFacts.ts`) and every one of its four categories (time-of-day, champion loyalty, role preference, streak).
2. THE System SHALL remove `computeRecommendations` (`backend/src/insight/recommendations.ts`) and every one of its three categories (survivability, champion selection, vision control).
3. THE System SHALL remove the `funFacts` and `recommendations` fields from `ProfileReport` and replace them with the fields Requirements 2 and 6 define.
4. THE System SHALL remove the frontend rendering of the old Fun Facts and Improvement Recommendations sections (`ProfileReportView.tsx`) and replace it with the rendering Requirements 5 and 13 define.
5. THE System SHALL NOT retain any dead code path that can still produce an old-category `FunFact` or `Recommendation` value.

### Requirement 2: Fun Fact — Nemesis by champion

**User Story:** As a player, I want to know which enemy champion I have the worst record against, so I understand a real, specific weakness rather than a generic stat.

#### Acceptance Criteria

1. WHEN Fun Facts are computed, THE System SHALL group every Included_Match that has a Lane_Opponent by that opponent's `championName`, and compute a win rate per champion over the analyzed player's games against it.
2. THE System SHALL consider a champion for Nemesis only when the analyzed player has faced it in at least `NEMESIS_MIN_GAMES` (default 3) Included_Matches with a recorded Lane_Opponent.
3. THE System SHALL select the eligible champion with the LOWEST win rate as the Nemesis, breaking a tie by the higher game count, and any further tie by champion name ascending.
4. IF no champion meets the minimum game threshold, THEN THE System SHALL omit the Nemesis fact entirely rather than naming a champion from an insufficient sample.
5. THE Nemesis fact SHALL state the champion name, the record (wins-losses), and the win rate.

### Requirement 3: Fun Fact — Longest game

**User Story:** As a player, I want to see my longest game in the window, so an unusually long match is called out rather than buried in an average.

#### Acceptance Criteria

1. WHEN Fun Facts are computed over a non-empty match window, THE System SHALL identify the Included_Match with the greatest `durationSeconds`.
2. THE longest-game fact SHALL state its duration, the champion played, and the result (win/loss).
3. IF the match window is empty, THEN THE System SHALL omit this fact.
4. IF more than one match ties for the longest duration, THEN THE System SHALL select the most recent of the tied matches (highest `startTimestamp`), for a deterministic, single-match statement.

### Requirement 4: Fun Fact — Favorite item(s)

**User Story:** As a player, I want to see the item(s) I actually build most often, so the fact reflects my real habits instead of a universal purchase everyone makes.

#### Acceptance Criteria

1. WHEN Fun Facts are computed, THE System SHALL tally item id frequency across every Included_Match's final `build.items` (slots 0-5; the trinket slot is a separate field and is never counted), across every match that has a recorded build.
2. THE System SHALL exclude every item id in a maintained Boots exclusion list (Requirement 14) from the tally, since boots are bought in nearly every game and are not a distinguishing habit.
3. THE System SHALL exclude item id `0` (an empty slot) from the tally.
4. THE System SHALL report the top `FAVORITE_ITEM_COUNT` (default 3) item ids by frequency, breaking a count tie by item id ascending (the Insight_Engine has no item name to break ties by — see design.md decision on why item names are a presentation-layer concern).
5. IF no non-empty, non-boot item id was ever recorded, THEN THE System SHALL omit this fact.
6. THE frontend SHALL resolve each reported item id to its icon and display name via the existing Static_Data_Provider, the same as every other item id already rendered in the report.

### Requirement 5: Fun Fact — Most-used ping

**User Story:** As a player, I want to see which ping I spam the most, so the report has a lighter, more personal fact alongside the analytical ones.

#### Acceptance Criteria

1. WHEN Fun Facts are computed, THE System SHALL sum each of Match-V5's per-participant ping-count fields (Requirement 14: `onMyWayPings`, `enemyMissingPings`, `enemyVisionPings`, `needVisionPings`, `pushPings`, `holdPings`, `getBackPings`, `assistMePings`, `allInPings`, `retreatPings`, `dangerPings`, `basicPings`, `commandPings`, `visionClearedPings`) across every Included_Match for the analyzed player.
2. THE System SHALL report the ping type with the highest total and that total count, breaking a tie by a fixed, documented field-priority order (design.md), for a deterministic result.
3. IF every ping total is zero (no match carried ping data, or the player never pinged), THEN THE System SHALL omit this fact rather than naming an arbitrary zero-count type.
4. THE frontend SHALL display a human-readable label for the winning ping type (e.g. `onMyWayPings` → "On My Way"), not the raw Riot field name.

### Requirement 6: Performance Feedback data source is ranked games only, and windowed to the most recent 30

**User Story:** As a player, I want my coaching feedback based on ranked games only, and only my recent ones, so a lopsided normal game doesn't skew it, and so the feedback reflects what I'm lacking right now rather than what I used to lack weeks ago.

#### Acceptance Criteria

1. WHEN Performance Feedback is computed, THE System SHALL derive every one of its metrics (Requirements 7-12) EXCLUSIVELY from the analyzed player's Recent_Ranked_Window — the most recent `PERFORMANCE_FEEDBACK_WINDOW` (30) Ranked_Matches, by `startTimestamp` descending, out of their Included_Match window.
2. THE System SHALL NOT let a normal game, an ARAM, an ARAM Mayhem match, or an Arena match contribute to any Performance Feedback metric.
3. THE System SHALL NOT let a Ranked_Match older than the player's 30 most recent ranked games contribute to any Performance Feedback metric, even when the full Included_Match window contains more than 30 Ranked_Matches.
4. IF the analyzed player has fewer than 30 Ranked_Matches in their Included_Match window, THEN THE Recent_Ranked_Window SHALL consist of all of them (never padded with older or non-ranked matches to reach 30).
5. IF the analyzed player has zero Ranked_Matches in the window, THEN THE System SHALL return an empty Performance Feedback list — a valid, non-error outcome — rather than falling back to the full match window.
6. Fun Facts (Requirements 2-5) SHALL continue to draw from the full Included_Match window (all allowed queue types, up to the existing `MATCH_HISTORY_COUNT`), unchanged from today's behavior — both the ranked-only restriction and the 30-match recency window apply to Performance Feedback only.

### Requirement 7: Performance Feedback is suppressed per category, not padded

**User Story:** As a player, I want to see feedback only on the things I'm actually behind on, so an empty section reads as "you're not lacking here" rather than the site having run out of things to say.

#### Acceptance Criteria

1. THE System SHALL evaluate every Performance_Feedback_Category (Requirements 8-12) independently against its own trigger condition.
2. THE System SHALL include a category in the output ONLY when its trigger condition holds for the analyzed player's Recent_Ranked_Window.
3. THE System SHALL NOT emit a category whose trigger does not hold, and SHALL NOT substitute, pad, or reorder categories to reach any particular count.
4. Zero triggered categories SHALL be a valid outcome, rendered as an explicit "nothing stood out" state (Requirement 13), never as an empty gap or a loading state.
5. THE System SHALL evaluate categories in a fixed order (design.md) so the same Recent_Ranked_Window always produces a byte-identical, deterministically-ordered result.

### Requirement 8: Performance Feedback — role-aware suppression for Support players

**User Story:** As a Support main, I don't want to be told my CS or damage is low — that's not how the role is played, and the feedback would be noise, not advice.

#### Acceptance Criteria

1. WHEN Performance Feedback is computed, THE System SHALL determine the analyzed player's most-played role over their Recent_Ranked_Window only (not the full Included_Match window, and not the full set of Ranked_Matches beyond the 30-match cap).
2. IF the most-played ranked role is Support, THEN THE System SHALL NOT evaluate or emit the CS/min category (Requirement 9) or the Damage-share category (Requirement 10) for that player, regardless of their actual CS/min or damage numbers.
3. Every other Performance_Feedback_Category (Requirements 8, 11, 12) SHALL remain eligible for a Support-majority player — the suppression in this requirement is scoped to CS/min and damage share only.
4. IF the analyzed player has no Ranked_Matches, THEN role determination is moot (Requirement 6.3 already yields an empty result), and this requirement does not itself change that outcome.

### Requirement 9: Performance Feedback — CS per minute

**User Story:** As a player in a farming role, I want to be told when my CS/min is behind a normal benchmark, so I have a concrete number to improve.

#### Acceptance Criteria

1. WHEN Performance Feedback is computed and the analyzed player's most-played ranked role is not Support (Requirement 8), THE System SHALL compute the average CS/min across their Recent_Ranked_Window.
2. THE System SHALL trigger this category ONLY WHEN the average CS/min is strictly below `CS_PER_MINUTE_BENCHMARK` (8.5).
3. THE feedback text SHALL state the player's own average CS/min and the benchmark it fell short of.

### Requirement 10: Performance Feedback — damage compared to team

**User Story:** As a player, I want to know when my damage output is meaningfully behind my own team's, so I know if I'm underperforming relative to the game I was actually in, not a global average.

#### Acceptance Criteria

1. WHEN Performance Feedback is computed and the analyzed player's most-played ranked role is not Support (Requirement 8), THE System SHALL, for each match in their Recent_Ranked_Window that carries a Full_Lobby, compute the analyzed player's `damageToChampions` against the average `damageToChampions` of their four teammates (same `teamId`, excluding the analyzed player's own row).
2. THE System SHALL exclude a Ranked_Match from this category's computation when it carries no Full_Lobby, rather than treating it as a zero.
3. THE System SHALL trigger this category ONLY WHEN the analyzed player's average damage share across contributing matches is below `TEAM_DAMAGE_SHARE_THRESHOLD` (80%) of their teammates' average damage.
4. IF no match in the Recent_Ranked_Window carries a Full_Lobby, THEN THE System SHALL NOT trigger this category (there is nothing to compare against).
5. THE feedback text SHALL state the player's own average damage and their teammates' average damage for the same matches.

### Requirement 11: Performance Feedback — kill participation

**User Story:** As a player, I want to know when I'm sitting out of my team's fights, so I have a concrete signal about map presence.

#### Acceptance Criteria

1. WHEN Performance Feedback is computed, THE System SHALL, for each match in their Recent_Ranked_Window that carries a Full_Lobby, read the analyzed player's own `killParticipationPercent` from their Full_Lobby row.
2. THE System SHALL exclude a Ranked_Match from this category's computation when it carries no Full_Lobby or when the analyzed player's kill-participation value is `'N/A'` (the team had zero kills that match — Requirement 3.4/3.6 of `match-detail-tabs`).
3. THE System SHALL trigger this category ONLY WHEN the average kill participation across contributing matches is strictly below `KILL_PARTICIPATION_BENCHMARK` (50%).
4. IF no match in the Recent_Ranked_Window has a usable kill-participation value, THEN THE System SHALL NOT trigger this category.
5. THE feedback text SHALL state the player's average kill participation and the benchmark it fell short of.

### Requirement 12: Performance Feedback — jungler objective control vs. the enemy jungler

**User Story:** As a jungler, I want to know when the enemy jungler is out-farming or out-securing objectives against me specifically, not against some role-agnostic baseline, so the feedback names the actual matchup that matters.

#### Acceptance Criteria

1. WHEN Performance Feedback is computed, THE System SHALL consider this category only for matches in their Recent_Ranked_Window where the analyzed player's `teamPosition` (from their own Full_Lobby row) was Jungle.
2. FOR each such match that carries a Full_Lobby, THE System SHALL locate the enemy jungler as the Full_Lobby row with a different `teamId` and `teamPosition` Jungle.
3. THE System SHALL exclude a jungle match from this category's computation when it carries no Full_Lobby, or when no enemy jungler row can be identified (a Full_Lobby is present but no opposing row has `teamPosition` Jungle).
4. THE System SHALL compute, per contributing match, the analyzed player's jungle-camp clear proxy (Requirement 14's `neutralMinionsKilled`) and objective kill-credits (`turretKills + dragonKills + baronKills`) against the enemy jungler's same two figures.
5. THE System SHALL trigger this category ONLY WHEN the analyzed player's average combined figure (camp clear + objective credits) across contributing matches is below `JUNGLE_OBJECTIVE_THRESHOLD` (80%) of the enemy jungler's average combined figure over the same matches.
6. IF the analyzed player has zero qualifying jungle matches in their Recent_Ranked_Window, THEN THE System SHALL NOT trigger this category.
7. THE feedback text SHALL state the player's own average figures and the enemy junglers' average figures for the same matches.

### Requirement 13: Frontend rendering

**User Story:** As a visitor, I want the new Fun Facts and Performance Feedback sections to look and behave consistently with the rest of the report, including its empty states.

#### Acceptance Criteria

1. THE System SHALL render the Fun Facts Requirements 2-5 produce as prose statements, in a fixed section order (design.md), consistent with the existing report's visual style.
2. THE System SHALL render a Performance Feedback item for every triggered category (Requirement 7), each carrying the category's own metric name and value, consistent with the existing recommendations' presentation.
3. WHEN zero Performance Feedback categories trigger, THE System SHALL render an explicit statement that nothing stood out, distinct from a loading or error state.
4. WHEN the analyzed player has zero Ranked_Matches (so no Recent_Ranked_Window can be formed), THE System SHALL render a distinct notice explaining that Performance Feedback needs ranked games, rather than the generic "nothing stood out" statement Requirement 13.3 defines for a ranked window with no triggers.
5. WHEN Fun Facts have no eligible statements at all (an empty or very short match window), THE System SHALL render the existing limited-data notice, unchanged from today's behavior.

### Requirement 14: New Match-V5 fields required

**User Story:** As the system, I need two participant-level fields Match-V5 already returns but this codebase does not yet model, so Requirements 5 and 12 have data to read without a new Riot API call.

#### Acceptance Criteria

1. THE Riot_API_Client's `MatchParticipantDto` SHALL gain the fourteen per-participant ping-count fields Match-V5 reports (`onMyWayPings`, `enemyMissingPings`, `enemyVisionPings`, `needVisionPings`, `pushPings`, `holdPings`, `getBackPings`, `assistMePings`, `allInPings`, `retreatPings`, `dangerPings`, `basicPings`, `commandPings`, `visionClearedPings`), and the match-detail projection SHALL retain them.
2. THE Riot_API_Client's `MatchParticipantDto` SHALL gain `neutralMinionsKilled` as its own field, distinct from the already-combined `cs` total, and the match-detail projection SHALL retain it.
3. THE System SHALL NOT issue any additional Riot API call to obtain either field — both are already present in the Match-V5 response this codebase fetches for every included match today.
4. Every existing consumer of `MatchParticipantDto`/`MatchParticipant` (match-detail-tabs' scoreboard, item-timeline, clash-scouting) SHALL be unaffected by these additive fields.

### Requirement 15 (Phase 2 — deferred): Performance Feedback — lane-phase death timing

**User Story:** As a player, I want to know if I'm dying disproportionately during lane phase versus later in the game, so I can tell whether my weakness is early trading or late-game positioning.

#### Acceptance Criteria

1. THIS requirement is Phase 2 and SHALL NOT be implemented until the fetch-volume trade-off in design.md's Rate Limiting section is confirmed (it requires a Match_Timeline for every match in the Recent_Ranked_Window, not only the one match a visitor opens the Build Path tab for).
2. WHEN implemented, THE System SHALL classify each of the analyzed player's deaths in a Recent_Ranked_Window match as lane-phase (before `LANE_PHASE_CUTOFF_MS`, default 15 minutes) or post-lane-phase, using the Match_Timeline's `CHAMPION_KILL` events.
3. THE System SHALL trigger this category ONLY WHEN the average lane-phase deaths per match exceeds `LANE_PHASE_DEATH_BENCHMARK` (design.md; a specific default is an open question, see design.md).
4. A Ranked_Match whose Match_Timeline could not be retrieved SHALL be excluded from this category's computation, never treated as zero lane-phase deaths.

### Requirement 16 (Phase 2 — deferred): Performance Feedback — gold/CS diff at 10 minutes

**User Story:** As a player, I want to know if I'm consistently behind my lane opponent at the 10-minute mark, so I can tell whether my losses trace back to an early-game deficit.

#### Acceptance Criteria

1. THIS requirement is Phase 2 and SHALL NOT be implemented until the fetch-volume trade-off in design.md's Rate Limiting section is confirmed, for the same reason as Requirement 15.1.
2. WHEN implemented, THE System SHALL read the analyzed player's and their Lane_Opponent's gold and CS from the Match_Timeline's frame nearest 10 minutes into each Recent_Ranked_Window match, when a Lane_Opponent is identified for that match.
3. THE System SHALL trigger this category ONLY WHEN the average gold-at-10 diff, CS-at-10 diff, or both (design.md decides which) is behind the Lane_Opponent by more than `EARLY_GAME_DEFICIT_THRESHOLD` (an open question — see design.md).
4. A Ranked_Match with no identified Lane_Opponent, or whose Match_Timeline could not be retrieved, or whose Match_Timeline has no frame at or after 10 minutes (a match that ended before 10:00), SHALL be excluded from this category's computation.
