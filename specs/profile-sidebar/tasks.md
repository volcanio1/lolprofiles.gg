# Implementation Plan: profile-sidebar

## Overview

This plan is ordered so the layout change (waves 1–2, no new data) lands and is verified independently from the new computation and storage work (waves 3–6), which is riskier and has open decisions (see design.md's "Open Questions") that should be resolved before implementation, not during it. Waves 3–4 (per-queue stats, role performance, recent-matches queueType) have no unresolved decisions and can proceed once approved. **Wave 5 (Rank_History / Persistent_Store) should not start until the storage-choice open question is answered** — building against the wrong storage model is expensive to unwind, and the interface in design.md is intentionally written so no other wave depends on which choice is made.

## Tasks

- [ ] 1. Split `ProfileReportView` into sidebar and main wrappers
  - [ ] 1.1 Introduce `.report-columns`, `.report-sidebar`, `.report-main`
    - Wrap the ranked-standing `<section>` in `<aside className="report-sidebar" aria-label="Player summary">` (Champion_Preferences and Role_Performance join it in wave 4/... below, once they exist)
    - Wrap the recent-matches `<section>` and `.rsec-duo` in `<div className="report-main">`
    - Keep `report-identity` outside both, directly under `.report`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 6.2, 6.3_

  - [ ] 1.2 Run the existing `ProfileReportView.test.tsx` suite unmodified
    - Every existing assertion must pass with zero test-file edits
    - _Requirements: 6.2_

- [ ] 2. Two-column grid, breakpoint, and sidebar persistence
  - [ ] 2.1 Add the `.report-columns` grid and the 960px breakpoint
    - Single column below 960px; `var(--sidebar-width) 1fr` grid at/above it; `align-items: start` on the grid
    - _Requirements: 1.1, 5.1, 5.2_
  - [ ] 2.2 Implement sidebar persistence
    - `position: sticky; top: 1.5rem; max-height: calc(100vh - 3rem); overflow-y: auto` on `.report-sidebar`, active only at/above 960px
    - Verify by inspection: stays in view while main column scrolls, scrolls internally if taller than viewport, releases before the footer
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [ ] 2.3 Checkpoint — layout-only tests pass, manual cross-width review
    - No horizontal scrollbar in either state; sidebar left/main right above 960px; clean stack below it; sidebar releases before the footer

- [ ] 3. Backend: role performance and per-queue stats
  - [ ] 3.1 Implement `computeRolePerformance`
    - Total, pure, excludes blank-role matches (Requirement 8.3), same `roleOf` classification the rest of the orchestrator uses
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ]* 3.2 Unit + property tests for `computeRolePerformance`
    - Mirror `topChampionsOf`'s existing property-test coverage style
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ] 3.3 Compute `statsByQueue` and `rolePerformanceByQueue` in the orchestrator
    - Call `computeStats`/`computeRolePerformance` once for `'all'` and once per Allowed_Queue_Type, partitioning `matches` by `queueType`
    - Keep existing `stats` field equal to `statsByQueue['all']` — additive, not a rename
    - _Requirements: 7.1, 7.3, 7.4, 8.1, 8.4, 8.5_
  - [ ]* 3.4 Orchestrator-level regression test
    - `statsByQueue['all']` equals today's single-pass `computeStats` result on an unchanged fixture; `statsByQueue['ranked solo/duo']` reflects only solo/duo matches on a mixed fixture
    - _Requirements: 7.1_

- [ ] 4. Backend: recent-matches `queueType` and widened transport pool
  - [ ] 4.1 Add `queueType` to `RecentMatchSummary`
    - Threaded straight through from `IncludedMatch.queueType`, already computed
    - _Requirements: 9.2, 9.3_
  - [ ] 4.2 Widen the served match list ahead of the existing `RECENT_MATCH_LIMIT` display cap
    - Send enough of the already-fetched (`MATCH_HISTORY_COUNT` = 100) included matches that any single Allowed_Queue_Type can still be filtered down to a full `RECENT_MATCH_LIMIT` (10) on the frontend, without any new Riot API call
    - _Requirements: 9.2, 9.3_

- [ ] 5. Checkpoint — backend changes tested; mirror types to frontend
  - Ensure all backend tests pass.
  - Update `frontend/src/api/types.ts`: `ProfileReport.statsByQueue`, `ProfileReport.rolePerformanceByQueue`, `RecentMatchSummary.queueType`. `rankHistory` is added in wave 7, once the storage decision (task 6) is resolved — do not block this checkpoint on it.

- [ ] 6. Rank History storage — **blocked on the open question in design.md**
  - [ ] 6.1 Resolve the storage choice with the user (in-memory-but-Requirement-10.7-forbids-it / flat file / database) before writing any code in this wave
  - [ ] 6.2 Implement `RankHistoryStore` against the interface in design.md, for the chosen storage
    - `record` is idempotent per PUUID+queueType+calendar-day (Requirement 10.2); `getHistory` returns oldest-first
    - _Requirements: 10.1, 10.2, 10.7_
  - [ ]* 6.3 Unit tests against the `RankHistoryStore` interface
    - Idempotent same-day recording; per-PUUID isolation; oldest-first ordering
    - _Requirements: 10.1, 10.2, 10.7_
  - [ ] 6.4 Wire recording into the orchestrator
    - Immediately after a successful League-V4 fetch, using the `'ranked solo/duo'` entry if present; a recording failure must not fail the lookup (design.md's Error Handling table)
    - _Requirements: 10.1_

- [ ] 7. Frontend: Gamemode_Filter, Champion_Preferences, Role_Performance, RankHistoryGraph
  - [ ] 7.1 Implement the `GamemodeFilter` component
    - Two independent instances (sidebar, main), each with its own state and default (`'ranked solo/duo'` sidebar, `'all'` main); offered values limited to those present in the report's included matches; excludes ARAM/other queues per Requirement 9.5
    - _Requirements: 9.1, 9.2, 9.4, 9.5_
  - [ ] 7.2 Implement the Champion_Preferences sidebar panel
    - Reads `report.statsByQueue[filterValue].topChampions`; card-based layout suited to the sidebar's width (not the wide `<table>`); existing empty-state message when a slice is empty
    - _Requirements: 7.2, 7.3, 7.4, 7.5_
  - [ ] 7.3 Implement the Role_Performance sidebar panel
    - Reads `report.rolePerformanceByQueue[filterValue]`; "not enough data" message when empty
    - _Requirements: 8.4, 8.5_
  - [ ] 7.4 Apply the Recent_Matches_Filter to the recent-matches list
    - Filters `report.recentMatches` by `queueType` client-side, then applies the existing `RECENT_MATCH_LIMIT` display cap after filtering
    - _Requirements: 9.2, 9.3_
  - [ ] 7.5 Implement `RankHistoryGraph`
    - Inline SVG polyline, no charting dependency; renders `report.rankHistory`; Requirement 10.4's message when fewer than 2 snapshots; axis labeled "lookups over time" per Requirement 10.5
    - _Requirements: 10.3, 10.4, 10.5_
  - [ ]* 7.6 Frontend tests
    - Filter defaults and independence; RankHistoryGraph's two states; Champion_Preferences/Role_Performance re-render on filter change with no network call asserted
    - _Requirements: 9.4, 10.3, 10.4_

- [ ] 8. Final checkpoint — full suite, compliance/accessibility pass
  - Ensure all tests pass (backend and frontend).
  - Confirm `RiotDataPage` wrapping, attribution, and advertising gate are unaffected (Requirements 4.1, 4.2).
  - Confirm heading order and landmark structure match design.md's architecture diagram (Requirement 6.3).
  - Ask the user for a dpm.lol screenshot or measurement, if not already provided, before calling visual polish (sidebar width, card spacing) finished.

## Notes

- Waves 1–2 are the only part of this plan that can proceed with zero open decisions. Waves 3–4 have no open decisions either and can run in parallel with waves 1–2 if useful, since they touch different files (`insight/`, `orchestrator/index.ts` vs. `ProfileReportView.tsx`, `styles.css`).
- **Wave 6 is the one wave in this plan that should not start on a "make the reasonable call and proceed" basis** — per design.md, introducing this project's first-ever database (or committing to a flat-file store with its own concurrency risk) is a bigger, harder-to-reverse decision than anything else in this spec, and the interface is written so every other wave is indifferent to which choice is made.
- Tasks marked with `*` are optional and can be skipped for faster delivery, matching this repo's convention in other specs (e.g. `visual-assets`).
