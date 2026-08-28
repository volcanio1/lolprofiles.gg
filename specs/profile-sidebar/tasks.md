# Implementation Plan: profile-sidebar

## Overview

This plan is ordered so the layout change (waves 1–2, no new data) lands and is verified independently from the new computation and storage work (waves 3–6), which is riskier and has open decisions (see design.md's "Open Questions") that should be resolved before implementation, not during it. Waves 3–4 (per-queue stats, role performance, recent-matches queueType) have no unresolved decisions and can proceed once approved. **Wave 5 (Rank_History / Persistent_Store) should not start until the storage-choice open question is answered** — building against the wrong storage model is expensive to unwind, and the interface in design.md is intentionally written so no other wave depends on which choice is made.

## Tasks

- [x] 1. Split `ProfileReportView` into sidebar and main wrappers
  - [x] 1.1 `.report-columns` > `<aside className="report-sidebar" aria-label="Player summary">` + `<div className="report-main">` added to `ProfileReportView.tsx`
    - **Sidebar:** ranked-standing + "Recent form" stat tiles + "Top champions" `<section>`s. ("Recent form" is in neither Requirement 1.2's nor 1.3's list — spec omission; placed in the sidebar because it's at-a-glance "how good is this player" content, matching design.md's stated split. "Top champions" becomes `ChampionPreferences` in wave 7.)
    - **Main:** recent-matches `<section>` + `.rsec-duo` (fun facts + recommendations).
    - **`report-identity` kept as a `<header>` directly under `.report`, above `.report-columns`** — following task 1.1's wording. This contradicts Requirement 1.2 / design.md's diagram, which put the Identity_Card *inside* the Sidebar_Rail. Flagged to the user; trivial to move if they want it in the rail. Screen-reader order is unaffected either way (identity → sidebar headings → main headings).
    - **No layout CSS** — the wrappers are bare block elements, so the page renders byte-identically to before. The grid + sticky behaviour is task 2.
    - _Requirements: 1.1, 1.2 (partial — see identity note), 1.3, 1.4, 6.2, 6.3_
  - [x] 1.2 `ProfileReportView.test.tsx` — all **41 tests pass unmodified**; full frontend suite 370 green; tsc + eslint + vite build clean.
    - _Requirements: 6.2_

- [x] 2. Two-column grid, breakpoint, and sidebar persistence
  - [x] 2.1 `src/styles.css`: `--sidebar-width: 20rem` token added; `.report-columns` is `flex column` (single-column stack) below 960px and `display: grid; grid-template-columns: var(--sidebar-width) 1fr; align-items: start` at/above; `.report-sidebar` / `.report-main` are `flex column; gap: 2.25rem; min-width: 0` (the `min-width: 0` stops the wide champions table from blowing out the main column). Spacing is uniform 2.25rem everywhere, matching the pre-split layout.
    - `--sidebar-width` is a first guess — flagged as tunable pending a dpm.lol reference (Open Question 3).
    - _Requirements: 1.1, 5.1, 5.2_
  - [x] 2.2 ~~Sidebar persistence~~ **REMOVED at the user's request (2026-08-28).** After seeing it rendered, the user said the rail took up too much space and did not want a scroll container on it — "just an element on the page". So `position: sticky` / `max-height` / `overflow-y: auto` were all dropped; the rail is now a plain grid column that scrolls with the page. `--sidebar-width` reduced `20rem → 15rem`. **This drops the spec's Requirement 2 (sidebar persistence) entirely** — a deliberate product call by the user, not an oversight. `align-items: start` kept so the short rail doesn't stretch to the main column's height.
    - _Requirements: ~~2.1, 2.2, 2.3, 2.4~~ (dropped by the user); still satisfies 5.x_
  - [x] 2.3 Checkpoint: `ProfileReportView.test.tsx` 41/41 + full frontend suite 370 green, tsc + eslint + vite build clean. No horizontal overflow in either state (`min-width: 0` + the existing `.table-scroll { overflow-x: auto }` contain the only wide child). DOM order = sidebar (ranked / recent-form / champions) then main (recent-matches / fun-facts+recs), so the stacked order satisfies Req 5.2.
    - **Not visually confirmed in a real browser** — deferred to the wave 8 checkpoint alongside the dpm.lol reference.

- [x] 3. Backend: role performance and per-queue stats
  - [x] 3.1 `backend/src/insight/rolePerformance.ts` — `computeRolePerformance(matches)` + `compareRolePerformance`. Pure/total; reads `match.role` directly (already `roleOf`-classified by the mapping step — Req 8.2); skips blank role (Req 8.3); one `RolePerformanceEntry { role, gamesPlayed, winRatePercent }` per role, ordered games DESC → wr DESC → role ASC (mirrors `compareChampionSummaries`).
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 3.2 `rolePerformance.test.ts` (6): empty input, per-role counts + whole-percent wr, blank-role exclusion, all-blank ⇒ `[]`, ordering, order-independence. (Property test skipped per the `*` convention.)
  - [x] 3.3 `assembleReport` loops `QUEUE_FILTER_VALUES` (`'all'` + `ALLOWED_QUEUE_TYPES`), computing `computeStats` + `computeRolePerformance` over the queue-matching subset (`'all'` = whole set), into new `report.statsByQueue` / `report.rolePerformanceByQueue`. `stats` is now bound to `statsByQueue.all` — additive, not a rename. New exports: `QueueFilterValue`, `QUEUE_FILTER_VALUES`. Each slice's `rankedByQueue` is the full standing (not match-derived) — documented on the type.
    - _Requirements: 7.1, 7.3, 7.4, 8.1, 8.4, 8.5_
  - [x] 3.4 Orchestrator regression test added: `statsByQueue.all` deep-equals `stats`; on a 4-match mixed fixture (2 solo / 1 flex / 1 normal) the solo slice sees only its champions/roles and the flex slice its own. Backend suite **542 pass / 6 skip**, tsc + eslint clean.

- [x] 4. Backend: recent-matches `queueType` and widened transport pool — **already shipped by `match-detail-tabs`, verified, no change needed.**
  - `RecentMatchSummary.queueType: string` present in `insight/recentMatches.ts:60` (and the frontend mirror `api/types.ts:152`), threaded from `IncludedMatch.queueType`.
  - `RECENT_MATCH_TRANSPORT_LIMIT = 30` vs `RECENT_MATCH_LIMIT = 10` already in `recentMatches.ts`, with a comment stating its purpose is exactly this: filter-by-queue on the frontend then apply the 10 cap. The design.md cross-spec note anticipated this being a no-op.
    - _Requirements: 9.2, 9.3_

- [x] 5. Checkpoint — backend changes tested; mirror types to frontend
  - [x] All backend tests pass (542 / 6 skip); frontend 370; tsc + eslint + build clean on both.
  - [x] `frontend/src/api/types.ts`: added `QueueFilterValue`, `RolePerformanceEntry`, `RankSnapshot` (puuid-less mirror), and `ProfileReport.statsByQueue` / `.rolePerformanceByQueue` / `.rankHistory` (all **required**). `isProfileReport` in `lookupClient.ts` extended to check the three — a report without them is a version-skewed backend, not renderable.
  - [x] `report.rankHistory` wired on the backend: `assembleReport` is now `async` and `await`s `rankHistoryStore.history(puuid, SOLO_QUEUE_TYPE).catch(() => [])`. Both call sites (`runPipeline`, `buildFallbackReport`) `await`. The no-op store resolves `[]` synchronously when `MONGODB_URI` is unset; the 15s lookup budget is the backstop if a real store hangs.
  - [x] New shared test fixture `frontend/src/test/reportExtras.ts` (`perQueueReportFields(stats)`) — the four test files that build `ProfileReport` literals spread it rather than each hand-writing four queue slices.
  - [x] **Live-verified against real Atlas**: a lookup of a ranked player returns all three fields; `rolePerformanceByQueue.all` computed + ordered correctly; `rankHistory` empty on the first lookup (snapshot write is fire-and-forget, read races ahead) then populated with the single solo-queue snapshot on the next. Test data cleared from the cluster afterward.

- [x] 6. Rank History storage — **DONE by `specs/database/` (2026-08-28).** Storage-choice open question resolved: MongoDB Atlas M0.
  - [x] 6.1 Resolved: MongoDB (see `specs/database/design.md` "Why MongoDB Atlas M0").
  - [x] 6.2 `RankHistoryStore` implemented in `backend/src/db/rankHistoryStore.ts` — interface + `InMemory*` + `Mongo*` + no-op. **Method name is `history(puuid, queueType)`, not `getHistory`** (design.md's name); `RankSnapshot` carries `{ puuid, queueType, tier, division, leaguePoints, observedAt }`. `record` dedups per `(puuid, queueType, UTC day)` via a unique index (Requirement 10.2); `history` is oldest-first (Requirement 10.7 / 10.3).
  - [x] 6.3 Unit + real-Mongo integration tests done in `specs/database/` (tasks 1.3, 2.4).
  - [x] 6.4 Recording wired into the orchestrator as `recordLookupSideEffects` — fires on every fresh successful lookup (from `report.stats.rankedByQueue['RANKED_SOLO_5x5']`), **unawaited**, a store failure is logged and swallowed and never fails the lookup (`specs/database/` Requirement 4). Records `RANKED_SOLO_5x5` only.
  - **Left for this spec (wave 7.5-adjacent):** the orchestrator must also *read* `rankHistoryStore.history(puuid, 'RANKED_SOLO_5x5')` during report assembly and put it on `report.rankHistory` (`.catch(() => [])` so a DB read can't slow/fail the lookup — design.md Error Handling row). That read wiring did **not** land in `specs/database/` (which deliberately added no payload field).

- [x] 7. Frontend: Gamemode_Filter, Champion_Preferences, Role_Performance, RankHistoryGraph
  - [x] 7.1 `frontend/src/components/GamemodeFilter.tsx` — stateless `<select>`; parent owns state. `frontend/src/domain/queueFilters.ts`: labels, `SIDEBAR_QUEUE_FILTER_DEFAULT = 'ranked solo/duo'`, `availableQueueFilterValues(report)` (offers `'all'` + the solo default always, plus any Allowed_Queue_Type whose slice has champions; no ARAM). **Only the sidebar instance is rendered** — see 7.4 for the main-column decision. `GamemodeFilter.test.tsx` (2).
    - _Requirements: 9.1, 9.4, 9.5_
  - [x] 7.2 `frontend/src/components/ChampionPreferences.tsx` — card list (icon + name + games/WR + KDA/CS·min), reads `report.statsByQueue[sidebarQueueFilter].topChampions`. **Replaces the report's wide champions `<table>`** in the sidebar (Requirement 7.5). Keeps the `champion-<name>` / `champion-<name>-avg-cs` / `no-champions` testids. Formatting helpers extracted to `frontend/src/domain/format.ts` (re-exported from `ProfileReportView` for existing importers). `sidebarPanels.test.tsx` (2).
    - _Requirements: 7.2, 7.3, 7.4, 7.5_
  - [x] 7.3 `frontend/src/components/RolePerformancePanel.tsx` — role · win-rate meter · games, reads `report.rolePerformanceByQueue[sidebarQueueFilter]`; `no-role-performance` message when empty. `sidebarPanels.test.tsx` (2).
    - _Requirements: 8.4, 8.5_
  - [x] 7.4 **The existing recent-matches queue filter is kept as-is; no second `GamemodeFilter` instance was added.** That control (`RECENT_MATCH_QUEUE_FILTERS` in `ProfileReportView`) already filters `report.recentMatches` by `queueType` client-side then applies the display cap — exactly what Requirement 9.2/9.3 ask — and it also offers ARAM / ARAM Mayhem / Ranked 5v5, which the user explicitly wants in Recent Matches ([[feedback-recent-matches-completeness]]). Replacing it with the spec's restricted 4-value control would regress that. **This deviates from the spec's literal "two GamemodeFilter instances"** — flagged for the user; collapsing to one styled control later is easy.
    - _Requirements: 9.2, 9.3 (satisfied by the pre-existing control)_
  - [x] 7.5 `frontend/src/components/RankHistoryGraph.tsx` — inline `<svg>` polyline, no dependency. `frontend/src/domain/rankHistory.ts`: `rankOrdinal` (cumulative `tier·400 + division·100 + clamp(lp)`, apex tiers share one LP scale) + `rankLabel`. `< 2` snapshots ⇒ "Rank history will build up over future lookups." Caption reads "lookups over time" (never "games played"). `rankHistory.test.ts` (6) + `RankHistoryGraph.test.tsx` (5).
    - _Requirements: 10.3, 10.4, 10.5_
  - [x] 7.6 Frontend tests: sidebar filter default = solo (9.4); changing it re-scopes both panels with the recent-matches filter untouched (independence); available-values filtering; graph's two states; panel empty states. **Frontend 389 pass** (was 370), tsc + eslint + vite build clean. **No React re-render triggers a network call — the parent just indexes a different precomputed slice** (Requirement 9.3, structural).
    - _Requirements: 9.4, 10.3, 10.4_

  ### Reworked to a compact layout after user feedback + a dpm.lol screenshot (2026-08-28):
  - **No cards.** Ranked standing is a compact row per queue (28px crest · queue · `TIER DIV · N LP` / `X% WR`, thin dividers). Champion preferences and role performance are dense right-aligned **tables** (icon · KDA · CS/m · Games · WR / role · Games · WR), tiny type.
  - **Gamemode filter is a horizontal tab bar** (`All · Solo · Flex · Normal`), not a `<select>` — matches dpm.lol, fits the rail.
  - **"Recent form" — moved to the main column, then (user, 2026-08-28) back into the rail** as three compact figures (`Avg KDA` / `Top role` / `Avg length`, minutes shown as `NNm`) directly under the ranked standing, in a `.rank-extra` grid. **All three are now per-queue and follow the gamemode filter tab** — required adding `averageMatchDurationMinutes` to `ProfileStats` (moved `averageMatchDurationMinutesOf` from `funFacts.ts` to `stats.ts` to avoid the circular import; `funFacts.ts` re-exports it). `computeStats` returns it for each slice. The top-level `ProfileReport.averageMatchDurationMinutes` stays (== `statsByQueue.all`'s) but the frontend no longer reads it. The old `Recent form` heading + `.stat-tile` cards are gone.
  - **Win rate stays in the gold accent, never green/red** (dpm.lol colours it green/red; this project's palette forbids that — [[design-system]]).
  - `--sidebar-width` 15rem; section gaps tightened (`.report-sidebar` gap 1.35rem, `.rsec--tight` gap 0.5rem).
  - Sidebar order: rank-history graph → filter tabs → ranked standing → champion preferences → role performance. (Recent form is in the main column.)

  ### Further user requests (2026-08-28):
  - **Ranked standing shows one queue, not the list** — the queue the gamemode filter selects (`standingQueueFor` in `domain/queueFilters.ts`: Flex tab → flex, everything else → solo, falling back to whatever ranked entry is present so `RANKED_PREMADE_5x5` still shows).
  - **NEW "Premades" panel** (not in this spec — net-new). Backend `insight/premades.ts` `computePremades(matches)`: teammates (same `teamId` as the analyzed player's row) seen in ≥ 2 included matches, with shared games + win-rate-together. Keyed by Riot ID (`MatchParticipant` has no PUUID by design). `report.premadesByQueue` added alongside `statsByQueue` etc. Frontend `PremadesPanel.tsx` (compact table, gold WR). **Live-verified** against real Riot data. 5 backend + 2 frontend tests.

  ### Main-column fallout, and the fix (2026-08-28)
  The rail took ~28% of the main column's width, which squeezed the recent-matches rows and the expanded detail panel — the user flagged both as "majorly compacted". Addressed in three parts, with a second dpm.lol screenshot as the spacing reference:
  - **Shell widened `1060px → 1240px`.** The rail's 15rem had been carved out of a container sized for a single column. The report now gets ~884px of main column, close to its pre-rail 980px. `.page--hero .search-form` is capped at 42rem so the landing page does not stretch with it.
  - **Match rows rebuilt as horizontal bands.** Each `MatchSide` is now four blocks reading outward — portrait + champion name + 2×2 loadout, identity + line stats, final build, LP Score — instead of a vertical stack. Line stats became a label/value grid (`display: contents` on the `<dl>`'s grouping divs) at ~⅓ the width of the old three-column row; the build wraps 4-over-3 at 20px; labels abbreviated to `KDA` / `CS/m` / `Vis` / `LP` to match the scoreboard's own headers. Roughly half the height, and both sides fit side by side. The opponent's mirror keeps `row-reverse`, but the stats grid flips with `direction: rtl` — `order` cannot mirror it, since every `dt` shares one order value and would group all three labels ahead of all three values.
  - **`@container` query on `.match-mirror`.** When the two bands wrap to a stack the divider turns from a left rule to a top rule and the mirror is undone. A media query cannot express this: at 960px the rail is gone and the row is *wider* than at 1000px where the rail is back, so the trigger is the row's own width, not the viewport's.
  - **Detail panel reworked as a drawer:** tabs are a full-width segmented bar with an underline marker (was three pill buttons), the panel bleeds to the row's edges over `--bg`, and the scoreboard got real row height (3.4rem), per-cell padding, banded team captions with a win/loss left rule, a wider identity column and thicker damage bars. The Runes tab's team headings were matched to the same banded treatment.

  ### Sidebar order as built (into `ProfileReportView`'s `.report-sidebar`):
  Rank-history graph → gamemode filter tabs → ranked standing (single) → champion preferences → role performance → premades.

- [ ] 8. Final checkpoint — full suite, compliance/accessibility pass
  - Ensure all tests pass (backend and frontend).
  - Confirm `RiotDataPage` wrapping, attribution, and advertising gate are unaffected (Requirements 4.1, 4.2).
  - Confirm heading order and landmark structure match design.md's architecture diagram (Requirement 6.3).
  - Ask the user for a dpm.lol screenshot or measurement, if not already provided, before calling visual polish (sidebar width, card spacing) finished.

## Notes

- Waves 1–2 are the only part of this plan that can proceed with zero open decisions. Waves 3–4 have no open decisions either and can run in parallel with waves 1–2 if useful, since they touch different files (`insight/`, `orchestrator/index.ts` vs. `ProfileReportView.tsx`, `styles.css`).
- **Wave 6 is the one wave in this plan that should not start on a "make the reasonable call and proceed" basis** — per design.md, introducing this project's first-ever database (or committing to a flat-file store with its own concurrency risk) is a bigger, harder-to-reverse decision than anything else in this spec, and the interface is written so every other wave is indifferent to which choice is made.
- Tasks marked with `*` are optional and can be skipped for faster delivery, matching this repo's convention in other specs (e.g. `visual-assets`).
