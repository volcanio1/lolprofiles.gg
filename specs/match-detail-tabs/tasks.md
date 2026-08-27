# Implementation Plan: match-detail-tabs

## Overview

This plan is ordered by dependency, and the dependencies are unusually clean: the backend widening and the frontend asset layer touch different workspaces and can proceed in parallel, but every component task needs both.

It opens with two verification tasks rather than code, because two things this design rests on have no upstream source of truth to check against at implementation time. The stat shard identifier-to-image mapping is published nowhere — the nine icon files were verified to exist, but only two of the nine identifiers appeared in the match sampled during design, so seven rows of that table are inferred. And the unversioned rune path is an amendment to an invariant stated absolutely in another spec; recording it there, rather than only here, is what stops the next reader treating it as a bug to fix.

The shared `CdnImage` primitive lands before the four new icon components rather than after. Written after, it would be a refactor of six call sites; written before, the four new wrappers are one-liners and the two existing ones (`ChampionIcon`, `ProfileIcon`) are refactored onto it with their current tests unchanged as the proof nothing moved.

## Tasks

- [x] 1. Verify the asset contract and extend the Static Data Provider
  - [x] 1.1 Record the live CDN findings in design.md
    - Already performed during design: versioned summoner spell path (200), versioned rune path (403), unversioned rune/tree/shard paths (200), metadata sizes and CORS, Match-V5 field names, `summonerName` deprecation
    - _Requirements: 7.2, 7.3, 7.4_

  - [x] 1.2 Verify the stat shard identifier mapping
    - Sampled 228 real participants across 22 matches (20 five-queue matches spanning ranked solo, ranked flex, and normal, plus 2 standard ARAM matches) and collected every distinct `perks.statPerks` value observed
    - Seven of nine identifiers confirmed present in real data: 5001, 5005, 5007, 5008, 5010, 5011, 5013 — design.md's table updated with observation counts for each
    - 5002 (Armor) and 5003 (Magic Resist) were not observed in any of the 228 sampled participants; left in the table but explicitly marked unverified rather than removed, since non-observation is weaker than a confirmed absence
    - `statShardIconUrl`/`statShardDisplayName` (task 1.4) may rely on the seven confirmed rows; 5002/5003 should not be treated as more trustworthy than "the file exists" until a real match reports one
    - _Requirements: 7.7_

  - [x] 1.3 Record the version-pinning exception in `visual-assets`
    - Done when this spec was written: `specs/visual-assets/requirements.md` Requirement 4 gained criteria 7-9 and an amendment note, so the exception lives where the invariant is stated rather than being contradicted from another spec
    - Criterion 9 states the consequence plainly — rune imagery may change with a Riot patch without a deployment, which is the outcome criterion 2 exists to prevent and is here unavoidable
    - The note records that `live-game` Requirement 7.5 defers to that document and therefore inherits the amendment
    - Re-read it before implementing task 1.4 and correct any drift
    - _Requirements: 7.4, 7.5, 7.6_

  - [x] 1.4 Extend the Static Data Provider with spells and runes
    - Coordinate with `live-game` Requirement 7.2, which specifies this same extension: implement it once here, and leave `live-game`'s numeric-champion-id accessor (its Requirement 7.3) to that feature
    - Fetch `summoner.json` and `runesReforged.json` alongside the existing two files, retained on the same 24-hour terms
    - Invert `summoner.json` to a numeric-id index once at build time, since Riot reports `key` as a string and Match-V5 reports the id as a number
    - Flatten `runesReforged.json` into a rune-id index and a tree-id index across every tree and slot
    - Implement `summonerSpellIconUrl`, `summonerSpellDisplayName`, `runeIconUrl`, `runeDisplayName`, `runeTreeIconUrl`, `runeTreeDisplayName`, `statShardIconUrl`, `statShardDisplayName`
    - Build spell URLs against the pinned version; build rune, tree and shard URLs against the **unversioned** path, per the verified contract
    - **Bump the persisted index's storage key.** `cache.ts` keys it `lolprofiles.staticData.v1` and validates by shape; its own comment notes nothing enforces the coupling. Without the bump, a returning visitor's v1 entry validates, matches the version, short-circuits the fetch, and serves placeholders for every spell and rune for 24 hours — presenting exactly as the degradation path
    - Make every accessor total on the same terms as the existing six: a URL or `null`, a name or a documented fallback, never a throw, never a URL containing `undefined`, before or after the index loads
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.7, 7.8, 7.9, 7.10, 7.11_

  - [x]* 1.5 Write property test for the new asset URL families
    - **Property 4: The four new asset URL families are total**
    - **Validates: Requirements 7.2, 7.3, 7.11, 9.3**
    - Must include prototype-chain keys (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) — `visual-assets` task 2.2 records that a hand-written sweep missed exactly this and produced a URL ending in the literal `undefined`

- [x] 2. Capture the participants on the backend
  - [x] 2.1 Extend `MatchParticipantDto`
    - Declare `summoner1Id`, `summoner2Id`, `perks`, `champLevel`, `goldEarned`, `totalDamageDealtToChampions`, `riotIdGameName`, `riotIdTagline` — none of which the type declares today
    - Declare every new field optional, matching how `teamPosition`, `role` and the item slots are already declared, so the module's "malformed becomes neutral" contract stays expressible
    - _Requirements: 6.2, 6.3_

  - [x] 2.2 Implement `toMatchParticipant` and `RunePage`
    - Total and never throwing, matching `mapping.ts`'s existing contract: a malformed, absent or non-numeric field becomes a neutral value
    - Read names from `riotIdGameName` / `riotIdTagline`; `summonerName` is deprecated and empty on current matches
    - Preserve Riot's reported order within each rune tree; do not sort or dedupe
    - Reuse `itemBuildOf` verbatim for the participant's `build`
    - Set `isAnalyzedPlayer` from the PUUID while it is still in scope, and put no PUUID on the record
    - _Requirements: 6.1, 6.2, 6.6, 6.9, 6.10, 4.5_

  - [x] 2.3 Mark the Enemy_Laner from the opponent selection's own row
    - Extract `opponentOf`'s `participants.find(...)` **predicate verbatim** into `opponentRowOf(participants, player): MatchParticipantDto | undefined`. `opponentOf`'s signature changes from `(participants, player, durationSeconds)` to `(rival, durationSeconds)` — it now only summarizes a row it is given, never selects one itself. The predicate does not change; only which function runs it does
    - Call `opponentRowOf` once in `toIncludedMatch` and give its row to both consumers: `opponentOf` for the summary, and `toMatchParticipant` for the `isEnemyLaner` marker
    - Do not match on champion identifier — Blind Pick is allowlisted and permits mirror picks, so champion identity is not unique within a match
    - `mapping.test.ts`'s existing opponent tests pass unmodified — they observe `toIncludedMatch`'s output only and never call `opponentOf` directly, so its internal signature change is invisible to them; that is the evidence the extraction changed nothing observable
    - _Requirements: 6.7, 6.8_

  - [x] 2.4 Implement team kills and kill participation
    - `killParticipationOf(kills, assists, teamKills)` goes in `insight/stats.ts` beside `csPerMinuteOf` — pure, property-tested there, returning a whole-number percentage or `'N/A'` when the denominator is zero, reusing the encoding `winRatePercent` already uses
    - `teamKillsOf` sums kills per `teamId` across the participants being displayed, not from `info.teams[]`
    - `mapping.ts` calls `killParticipationOf` from inside `toMatchParticipant`, which is the same arrangement it already uses for `csPerMinuteOf`. Computation in the Insight Engine, arguments from the mapping layer, formatting in the view — the view never derives
    - _Requirements: 3.4, 3.5, 3.6_

  - [x] 2.5 Attach participants and queue type to `RecentMatchSummary`
    - Add `participants` and `queueType`; `IncludedMatch` already carries the queue type and `computeRecentMatches` currently drops it. `durationSeconds` is already carried and needs no capture
    - Change no existing field's shape; `championName`, `opponent` and `build` keep rendering the current row from the same fields
    - Mirror the new types into the frontend contract in the same wave, since the two workspaces share no code — done when task 5.1 needed `MatchParticipant`/`RunePage` on the frontend, not strictly in this same commit; recorded here rather than re-opening this task
    - Measure the resulting payload and record it, so a later increase to the recent-match limit is made with that cost visible
    - _Requirements: 6.1, 6.4, 6.5, 6.12_

  - [x]* 2.6 Write property test for participant capture
    - **Property 2: Participant capture preserves the match**
    - **Validates: Requirements 6.1, 6.7, 6.11**

  - [x]* 2.7 Write property test for kill participation
    - **Property 1: Kill participation is total, bounded, and team-local**
    - **Validates: Requirements 3.4, 3.5, 3.6**

  - [x]* 2.8 Write property test for PUUID absence
    - **Property 3: No participant record carries a PUUID**
    - **Validates: Requirements 6.6, 6.9**

  - [x]* 2.9 Write property test for the Enemy_Laner marker
    - **Property 5: The Enemy_Laner marker comes from the opponent's own row**
    - **Validates: Requirements 6.7, 6.8**
    - Must include a mirror-lane example — the same champion on both teams in the same position — since that is the case a champion-name match gets wrong

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Consolidate the CDN image primitive
  - [x] 4.1 Implement `CdnImage`
    - Owns the whole pattern once: render `AssetPlaceholder` when the URL is `null`, render `<img>` otherwise, swap to `AssetPlaceholder` on the image's `error` event, reserve identical dimensions in both cases
    - _Requirements: 7.11, 9.3, 8.1_

  - [x] 4.2 Refactor `ChampionIcon` and `ProfileIcon` onto it
    - Their existing tests must pass unmodified — that is the evidence the refactor changed no behavior
    - _Requirements: 9.3_

  - [x] 4.3 Implement the four new icon components
    - `SummonerSpellIcon`, `RuneIcon`, `RuneTreeIcon`, `StatShardIcon`, each a thin typed wrapper over `CdnImage`
    - Text alternative is the resolved name, falling back to the numeric identifier
    - When a placeholder stands in, name the subject (`"Flash unavailable"`), not the absence alone — these icons have no adjacent text, unlike the champion icons the existing convention was written for. `ItemBuildRow` already sets this precedent
    - Update `AssetPlaceholder`'s own documented decision 2, which currently states the opposite rule ("THE LABEL DESCRIBES THE ABSENCE, NOT THE SUBJECT") on the justification that every call site renders the name beside the icon — no longer true. Leaving it would have the component's header contradict this task
    - _Requirements: 7.11, 8.1, 8.2, 8.3, 8.4_

- [x] 5. Rebuild the match row as a mirror
  - [x] 5.1 Implement `MatchSide` and `MatchRow`
    - Analyzed player left, Enemy_Laner right, mirrored; read the opponent's spells and runes from the participant marked `isEnemyLaner`
    - Champion portrait, both summoner spell icons, keystone icon and secondary tree icon adjacent to the portrait
    - Keep the existing KDA, CS, CS/min and vision score for both sides, and both Final_Builds
    - Keep outcome, role and start time; add duration and queue type
    - Render the existing no-opponent notice when no Enemy_Laner was identified, and render no empty opposing portraits, spells, runes or item slots
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x]* 5.2 Write unit tests for the mirrored row
    - Both sides render their spells and runes; the no-opponent case renders neither an opposing portrait nor opposing slots; the row still shows every value it shows today, plus duration and queue type
    - _Requirements: 1.2, 1.3, 1.6, 1.7_

- [x] 6. Build the detail panel and its three tabs
  - [x] 6.1 Implement the panel shell and tab semantics
    - Expand/collapse control per row; every panel collapsed on initial render; General selected on first expansion, previously-selected tab restored on subsequent expansions of that row
    - Per-row state, so expansion and tab selection are independent across rows
    - WAI-ARIA tabs: `role="tablist"`/`"tab"`/`"tabpanel"`, `aria-selected`, `aria-controls`, arrow-key movement
    - Issue no backend or Riot request on expand or on selecting General or Runes. Data_Dragon image loads for newly-revealed icons are expected and permitted
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 6.2 Implement the General tab
    - Every participant the match carries, in two team blocks, analyzed player's team first, ordered by `Position_Order` with non-member positions last preserving Riot's order among them
    - Order by `teamPosition` directly, not through `roleOf`, whose fallback returns a different vocabulary (`SOLO`/`CARRY`/`SUPPORT`/`DUO`/`NONE`) from which no lane ordering is derivable
    - Per participant: portrait and display name, both spell icons, keystone icon, secondary tree icon, Riot ID, champion level, Final_Build
    - Per participant: kills, deaths, assists, CS, vision score, damage to champions, gold earned, kill participation
    - Distinguish the analyzed player's row by a means that is not colour alone; associate each participant's statistics with that participant for assistive technology
    - _Requirements: 3.1, 3.2, 3.3, 3.7, 3.8, 8.5, 8.6_

  - [x] 6.3 Implement the Runes tab
    - Same participants in the same order the General tab uses, from the shared `Position_Order` constant
    - Per participant: portrait, four primary rune icons, two secondary rune icons, both tree icons, three stat shard icons
    - Group primary, secondary and shards as three distinguishable groups; preserve Riot's reported order within each tree
    - Render a participant whose rune data is absent or malformed with its rune page marked unavailable, rather than omitting the participant
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 9.2_

  - [x] 6.4 Implement the Build Path tab placeholder
    - Selectable from the moment this ships; displays an explicit not-yet-available message
    - Not an empty region, not an error, not a loading state that never resolves
    - Retrieve no Match_Timeline anywhere in this feature
    - _Requirements: 5.1, 5.2, 5.3_

  - [x]* 6.5 Write component tests for the panel
    - Collapsed on first render; per-row independence; tab restored on re-expansion; both tabs list the same participants in identical order; analyzed player distinguishable; Build Path message present; no `<img>` when the provider is not ready
    - _Requirements: 2.2, 2.4, 2.5, 3.7, 4.1, 5.2, 9.3_

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Degradation, compliance, documentation and the `item-timeline` handoff
  - [ ] 8.1 Verify the degraded paths
    - Rows and tabs render in full with placeholders when the spell or rune metadata fetch fails
    - A match with fewer than ten participants renders what it has
    - The General and Runes tabs are unaffected by the absence of an Enemy_Laner
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 6.11_

  - [ ] 8.2 Confirm compliance and update the README
    - Confirm the Detail_Panel inherits `RiotDataPage`'s attribution and no-advertising default rather than re-implementing either, and that no advertising slot exists inside a Match_Row or Detail_Panel
    - Extend the README's Assets section with the two new metadata files and the unversioned rune path, stating plainly that rune imagery is the one asset class `DDRAGON_VERSION` does not pin
    - _Requirements: 10.1, 10.2, 10.3, 7.6_

  - [ ] 8.3 Confirm the `item-timeline` amendment still holds
    - That spec was amended when this one was written (its Requirements 3.8-3.10, its `BuildPathView` design section, its sequence flow, and its task 8.2)
    - Re-read it against the shipped Build Path tab and correct any drift before starting `item-timeline`
    - _Requirements: 5.4, 5.5, 5.6_

- [ ] 9. Laneless queue support (ARAM and ARAM Mayhem)
  - [ ] 9.1 Add the laneless capture path in `mapping.ts`
    - Declare `LANELESS_QUEUE_TYPE_BY_QUEUE_ID` (`{450: 'aram', 2400: 'aram mayhem'}`), disjoint from `QUEUE_TYPE_BY_QUEUE_ID` — do not add these ids to it or to `AllowedQueueType`
    - Implement `toLanelessMatch`, calling `toMatchParticipant` for all ten rows with `isEnemyLaner` hardcoded `false`; never call `opponentRowOf` or `opponentOf` from it
    - Declare `playerAugment1` through `playerAugment6` on `MatchParticipantDto`, optional, matching the existing pattern
    - Extend `toMatchParticipant` to read them unconditionally into `MatchParticipant.augments` (non-zero values only, Riot's field order) — no queue check inside this function; the field is simply zero everywhere but queue 2400
    - _Requirements: 11.1, 11.2, 11.3, 12.1, 12.2_

  - [ ] 9.2 Verify the augment identifier mapping against a real match
    - Obtain a real queue-2400 (ARAM Mayhem) match — the mode was not queueable by any account checked during design, so this may require waiting for the event to be active or sourcing a match id from another verified source
    - Confirm `playerAugmentN`'s reported values are found as `id`s in `cherry-augments.json`, and that the resulting icon URLs return 200
    - This is the design's most consequential open item (see design.md's Open Questions): unlike the stat shard table, a wrong id space here silently mislabels every augment, not a handful of icons. Do not ship `augmentIconUrl`/`augmentDisplayName` as trustworthy until this passes
    - If no real match can be obtained before this feature ships, ship behind a note in the README identical in spirit to the stat shard caveat, and re-run this check the first time the mode is confirmed active
    - _Requirements: 12.5_

  - [ ] 9.3 Wire the laneless path into the orchestrator and `computeRecentMatches`
    - Extend the match-fetch loop: when `toIncludedMatch` returns `undefined`, try `toLanelessMatch` before discarding the match; collect hits into a new `lanelessMatches: LanelessMatch[]`, kept alongside the unchanged `matches: IncludedMatch[]`
    - Widen `computeRecentMatches` to take both arrays and merge by `startTimestamp` descending before slicing to `RECENT_MATCH_LIMIT`; a `LanelessMatch` competes for a slot on equal footing
    - Set `role: ''` when mapping a `LanelessMatch` — this is the existing "role could not be determined" sentinel already handled downstream, not a new one
    - Verify no other caller of `matches` (`computeStats`, `roleAggregatesOf`, `topChampionsOf`, `mostPlayedRoleOf`) changed signature or behavior
    - _Requirements: 11.1, 11.2, 11.4, 11.5_

  - [ ] 9.4 Extend the Static_Data_Provider with augment accessors
    - Fetch `cherry-augments.json` from Community_Dragon at `https://raw.communitydragon.org/{major}.{minor}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json`, deriving `{major}.{minor}` from `DDRAGON_VERSION` — never request Community_Dragon's `"latest"`
    - Build the id → `{ name, iconPath }` index; build icon URLs by lowercasing `augmentSmallIconPath`, stripping its leading `/lol-game-data/assets/` segment, and appending to the pinned Community_Dragon base path
    - Implement `augmentIconUrl`, `augmentDisplayName`, total on the same terms as the other eight accessors — a URL or `null`, a name or the numeric id, never a throw
    - Do not route this request through the Rate_Limit_Manager or the backend, consistent with every other Data_Dragon/Community_Dragon request
    - Bump the persisted index's storage key again, for the same reason task 1.4 already bumps it for spells and runes
    - _Requirements: 12.5, 12.6, 12.7_

  - [ ] 9.5 Implement the Augments tab and wire the queue-based tab switch
    - `AugmentsTab`, a thin sibling of `RunesTab` reading `MatchParticipant.augments` instead of `.runes`, same participant ordering and grouping
    - In `DetailPanel`, render `AugmentsTab` in the third tab's place when `queueType === 'aram mayhem'`, and `RunesTab` for every other value including `'aram'`; relabel the tab accordingly
    - Render empty slots, not an unavailable state, for a participant with fewer than six captured augments
    - Render no description or tooltip text for an augment — name only, per decision 13
    - _Requirements: 11.7, 12.3, 12.4, 12.8, 12.9_

  - [ ] 9.6 Suppress role and opponent display for Laneless_Matches in the row
    - `MatchRow`/`MatchSide` render no role text when `role === ''` and a `LanelessMatch` produced it — reuse the existing no-opponent-notice path for the right-hand side unconditionally
    - Every other row field (KDA, CS, CS/min, vision score, Final_Build, duration, queue type) renders exactly as it does for any other match
    - _Requirements: 11.4, 11.5_

  - [ ]* 9.7 Write property test for the laneless boundary and augment capture
    - **Property 7: A Laneless_Match never reaches a role-relative computation**
    - **Validates: Requirements 11.2, 11.3, 12.1, 12.2**

  - [ ]* 9.8 Write unit and component tests
    - `toLanelessMatch` against queue 450 and queue 2400 fixtures, and `undefined` for every other queue
    - A queue-2400 participant with zero, some, and six captured augments
    - A queue-450 match renders the Runes tab; a queue-2400 match renders the Augments tab
    - A Laneless_Match's row shows no role text and no opposing side

- [ ] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster delivery; they are not implemented by the coding agent by default.
- **Task groups 1 and 2 are independent** — one is frontend asset plumbing, the other backend participant capture. They touch different workspaces and can run in parallel. Group 5 onward needs both. ("Group" here means the numbered headings below; the `waves` in the dependency graph at the end are execution rounds and do not correspond one-to-one.)
- **The stat shard table is the only unverified thing in this design.** Task 1.2 exists because the nine icon files were confirmed to exist but only two of the nine identifiers were observed in a real match. Do not skip it and do not build `statShardIconUrl` on an unverified row.
- **Rune icons are deliberately unversioned.** The versioned path returns 403 — this is not an oversight to "fix" later. The metadata that maps a rune id to an icon path *is* pinned; only the image bytes float. Task 1.3 records this in `visual-assets`, where the invariant is stated, precisely so the next reader finds the amendment rather than an apparent contradiction.
- **The Static_Data_Provider extension is shared with `live-game`.** That spec's Requirement 7.2 specifies the same spell-and-rune extension and neither feature is built yet. Whichever ships first implements it; the second must not reimplement it. `live-game`'s numeric-champion-id accessor is not part of this.
- **No new Riot API call is introduced by this feature.** If an implementation finds itself adding one, something has been misread: every value the General and Runes tabs show is already in the match detail the orchestrator fetches and caches indefinitely.
- **`opponentOf` is not to be modified.** It already identifies the Enemy_Laner and already returns nothing when no lane could be determined. Task 2.3 reuses the row it selects; it does not re-implement the selection, and it does not match on champion name.
- **Eight queue ids reach this feature now, through two paths that must stay separate.** `QUEUE_TYPE_BY_QUEUE_ID` still allowlists only 400/420/430/440/480/490 and still feeds every role-relative computation — that map is not to gain 450 or 2400. Those two reach the recent-matches list through the sibling `LANELESS_QUEUE_TYPE_BY_QUEUE_ID` and `toLanelessMatch` (task 9), which a role-relative function never sees. Clash and every rotating event mode still reach neither path. Blind Pick (430) *is* included in the first path, which is why mirror picks are a real case for task 2.3.
- **Task 9's augment identifier mapping is unverified going in, and is the single highest-risk item in this feature.** No live ARAM Mayhem match could be sampled during design. Task 9.2 is not optional busywork the way some verification tasks can feel — until it passes, every augment name and icon this feature would show is an inference, not a confirmed fact.
- The Build Path tab is the only surface in this feature that will ever issue a request, and only after `item-timeline` lands — for one player, where the neighbouring tabs show ten.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1"] },
    { "id": 1, "tasks": ["1.4", "2.2", "2.4"] },
    { "id": 2, "tasks": ["1.5", "2.3", "2.5", "2.6", "2.7", "2.8", "4.1"] },
    { "id": 3, "tasks": ["2.9", "4.2", "4.3"] },
    { "id": 4, "tasks": ["5.1", "6.1"] },
    { "id": 5, "tasks": ["5.2", "6.2", "6.3", "6.4"] },
    { "id": 6, "tasks": ["6.5", "8.1", "8.2", "8.3"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.4"] },
    { "id": 8, "tasks": ["9.3"] },
    { "id": 9, "tasks": ["9.5", "9.6", "9.7"] },
    { "id": 10, "tasks": ["9.8"] }
  ]
}
```
