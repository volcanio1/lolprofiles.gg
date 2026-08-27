# Design Document

## Overview

This feature has two very different halves, and they should be read as such.

**Half one (Requirements 1–6) is a pure layout rearrangement.** `ProfileReportView.tsx`'s existing section order already splits cleanly: identity/ranked-standing/champion-summary reads as "who is this and how good are they," while recent-matches/fun-facts/recommendations reads as the detail a visitor scrolls through. No section needs reordering — only regrouping into two column wrappers.

**Half two (Requirements 7–10) adds real computation and, for the rank graph, real persistence.** None of it is free:

- **Champion_Preferences and Role_Performance scoped by queue (Req 7–8)** require the Insight Engine to compute its existing per-champion and a brand-new per-role aggregation **once per queue filter value**, not once overall. This is new backend work, but it is the same *kind* of work this codebase already does well — a pure function over `IncludedMatch[]`, testable the same way `topChampionsOf` already is.
- **The Gamemode_Filter (Req 9)** is mostly free once Req 7–8 exist: it's a piece of frontend state that picks which precomputed slice to render, with no new network round-trip.
- **The Rank_History graph (Req 10)** is the one item here that is not "more of the same." Riot's API has no historical-rank endpoint — League-V4 returns only a player's *current* standing. The only way to have a graph at all is for this system to become something it currently isn't: a service that remembers things across restarts. Every other piece of state in this backend today (`backend/src/cache/index.ts`) is an in-memory, TTL-evicting cache that is explicitly *supposed* to lose data — that's a different job than a growing history that must survive a redeploy. This is flagged prominently because it's the one place in this spec where "just write the pure function" isn't the whole story.

### What was verified against a live reference, and what wasn't

`op.gg/lol/summoners/euw/Doffy-Smile` was fetched directly and confirmed the general shape: profile card → ladder rank → nav tabs → queue filters → ranked-standing cards → champion mastery, all in a left column.

`dpm.lol/Doffy-Smile` returned an HTTP 403 (Cloudflare bot check) and could not be fetched by this tool. Requirements 7–10 are built from the user's direct description of dpm.lol's sidebar (ranked solo/duo line graph at top → gamemode filter → champion preferences with KDA/CS/games/WR → role performance with games/WR), not from a page this tool inspected. Two things in that description are deliberately **not** carried over as-is, and both are called out below and in requirements.md:

1. dpm.lol's filter appears to be a single control governing multiple panels including recent matches. This design uses **two independent filters** (Sidebar_Queue_Filter, Recent_Matches_Filter) because the user's own instruction gave them different defaults (`'ranked solo/duo'` vs `'all'`) — a single shared control can't hold two different default values at once. If dpm.lol's actual behavior turns out to be closer to "one filter, but recent matches has its own separate default toggle," this is easy to collapse into fewer components later; it is not easy to go the other direction once shared state is wired up.
2. dpm.lol's rank graph is almost certainly denser than what Requirement 10 can deliver — a graph with a point after every ranked game most plausibly comes from a service that continuously polls tracked players and correlates match completions with rank changes. That is a fundamentally different infrastructure commitment (a background crawler, not an on-demand lookup tool) than anything in this codebase. Requirement 10 specifies the honest version this system can actually build: a snapshot taken each time someone looks the player up.

## Architecture

```
ProfileReportPage
  └─ RiotDataPage (unchanged)
       └─ ProfileReportView
            └─ .report-columns
                 ├─ <aside class="report-sidebar">
                 │    ├─ report-identity                (existing, unchanged)
                 │    ├─ RankHistoryGraph (NEW)          — Req 10
                 │    ├─ GamemodeFilter (NEW, "sidebar" instance) — Req 9
                 │    ├─ ranked standing <section>       (existing, unchanged)
                 │    ├─ ChampionPreferences (NEW layout, existing data source extended) — Req 7
                 │    └─ RolePerformance (NEW)           — Req 8
                 │
                 └─ <div class="report-main">
                      ├─ GamemodeFilter (NEW, "main" instance) — Req 9
                      ├─ recent matches <section>              (existing, unchanged JSX; new queueType field)
                      └─ .rsec-duo (fun facts + recommendations) (existing, unchanged)
```

### Backend architecture addition

```
backend/src
├─ insight/
│   ├─ stats.ts              existing computeStats — now called once per Queue_Filter_Value
│   ├─ rolePerformance.ts    NEW — computeRolePerformance(matches): RolePerformanceEntry[]
│   └─ ...
├─ orchestrator/
│   └─ index.ts              assembles `statsByQueue` and `rolePerformanceByQueue` (Req 7.1/8.1),
│                             and calls the new Rank_History recorder after a successful League-V4 fetch (Req 10.1)
└─ rankHistory/               NEW module
    ├─ index.ts               RankHistoryStore interface + an in-memory reference implementation
    └─ index.test.ts
```

## Components and Interfaces

### Backend: per-queue stats and role performance (Requirements 7, 8)

```typescript
// insight/stats.ts — existing function, called per queue value rather than once
function computeStats(matches: readonly IncludedMatch[], league: readonly LeagueEntry[]): ProfileStats;

// insight/rolePerformance.ts — new
export interface RolePerformanceEntry {
  role: string;
  gamesPlayed: number;
  winRatePercent: number;
}

/** Excludes any match whose role is blank (Requirement 8.3), same rule as `roleOf`. */
export function computeRolePerformance(matches: readonly IncludedMatch[]): RolePerformanceEntry[];
```

`computeRolePerformance` is a new pure function, sibling to `topChampionsOf` and `mostPlayedRoleOf` in the same file (or a new file — either is consistent with this codebase's existing module boundaries), taking the exact same `IncludedMatch[]` shape everything else in the Insight Engine already consumes. It needs no new field on `IncludedMatch`: `role` is already populated by `roleOf` in the orchestrator's mapping step.

The orchestrator computes both `computeStats` and `computeRolePerformance` once per Queue_Filter_Value (`'all'` plus each of the three Allowed_Queue_Types — four calls total, each over the subset of `matches` whose `queueType` matches, or the full set for `'all'`), and assembles:

```typescript
type QueueFilterValue = 'all' | AllowedQueueType;

interface ProfileReport {
  // ...existing fields unchanged...
  statsByQueue: Record<QueueFilterValue, ProfileStats>;
  rolePerformanceByQueue: Record<QueueFilterValue, RolePerformanceEntry[]>;
}
```

The existing top-level `stats: ProfileStats` field is **kept**, equal to `statsByQueue['all']`, so nothing that currently reads `report.stats` breaks — this is additive, not a rename. (`ProfileReportView`'s existing "Recent form" stat tiles and ranked-standing cards keep reading `report.stats` exactly as today; only the new Champion_Preferences/Role_Performance sidebar panels read `report.statsByQueue`/`report.rolePerformanceByQueue`.)

### Recent matches: adding `queueType` and widening the served pool (Requirement 9.2/9.3)

Two small, additive changes to `insight/recentMatches.ts`:

```typescript
export interface RecentMatchSummary {
  // ...existing fields unchanged...
  /** Requirement 9.2/9.3 — lets the frontend filter without a new request. */
  queueType: string;
}
```

> **Cross-spec note.** `match-detail-tabs`, which this codebase's roadmap builds first, independently adds this same `queueType: string` field from the same `IncludedMatch` source. If it has already shipped by the time this spec is implemented, this change is a no-op — verify the field before adding it rather than assuming it is still missing. That same feature also adds a `participants: MatchParticipant[]` field to every `RecentMatchSummary` (all ten players' summary rows), which is not shown here because it predates this spec's authorship. Its presence means the transport-limit widening below (`RECENT_MATCH_TRANSPORT_LIMIT`) multiplies against a per-match payload that is already larger than the estimate `match-detail-tabs`' design assumed for `RECENT_MATCH_LIMIT` (10) matches — re-measure the combined payload rather than reusing either spec's original budget figure.

`RECENT_MATCH_LIMIT` (currently 10) is the count **displayed after filtering**, not the count **sent**. The orchestrator already fetches and caches up to `MATCH_HISTORY_COUNT` (100) included matches per lookup — comfortably enough to filter down to 10-per-queue for any Allowed_Queue_Type without any additional Riot API call. The transport payload's match list is widened accordingly (a new constant, e.g. `RECENT_MATCH_TRANSPORT_LIMIT`, sized generously — see task list), and the frontend applies `RECENT_MATCH_LIMIT` **after** filtering by `Recent_Matches_Filter`, mirroring exactly how `computeRecentMatches` already slices `matches` today, just moved one layer up.

This keeps the "Insight Engine computes, view formats" boundary this codebase already commits to (`ProfileReportView.tsx`'s decision 1: "numbers are formatted, never recomputed") intact for KDA/CS/win-rate math, while treating "which 10 of the already-computed recent matches to show" as a presentation-layer slice — the same kind of operation `orderedQueueTypes` already performs today, not a re-derivation of any Insight Engine value.

### Rank History: storage and recording (Requirement 10)

```typescript
// rankHistory/index.ts
export interface RankSnapshot {
  puuid: string;
  queueType: 'RANKED_SOLO_5x5';
  tier: string;
  division: string;
  leaguePoints: number;
  /** Epoch ms, injected clock per this codebase's existing convention. */
  observedAt: number;
}

export interface RankHistoryStore {
  /** No-ops if a snapshot for this puuid+queueType+calendar-day already exists (Req 10.2). */
  record(snapshot: RankSnapshot): Promise<void>;
  /** Oldest first. Empty array if nothing has ever been recorded. */
  getHistory(puuid: string, queueType: string): Promise<RankSnapshot[]>;
}
```

**Storage options considered:**

| Option | Survives restart? | New infra? | Notes |
|---|---|---|---|
| Extend the existing `InMemoryCacheStore` | No | None | Ruled out by Requirement 10.7 — this is exactly the "in-memory, TTL-evicting" component the requirement names as unsuitable. A restart (routine on most hosting, including the Render deploys this project already targets) would silently erase the graph, making the feature look broken rather than merely young. |
| Flat file (JSON or newline-delimited) on a persistent disk volume | Yes, if the host provides a persistent volume | Minimal | Cheapest to implement; risk is concurrent-write safety under multiple backend instances, and dependence on the hosting platform actually providing a persistent (non-ephemeral) disk — Render's free/starter tiers do not guarantee this. |
| A real database (SQLite file, Postgres, etc.) | Yes | A new dependency and a new operational concern (migrations, connection config) | The durable, conventional answer, but this codebase currently has **zero** database dependency of any kind — this would be the first. |

**This design does not choose one for the user.** All three satisfy Requirement 10.7's letter; they trade off very differently on operational risk given this specific project's current hosting (Render, per this session's earlier deploy troubleshooting) and its explicit "no `.env` loading, no database" posture (README's Known Gaps). That posture is exactly why this decision is surfaced here rather than assumed — introducing the *first* database this project has ever had is a bigger commitment than anything else in this spec, and should be a decision the user makes deliberately, not one a spec quietly bakes in. See "Open Questions" below.

The interface above (`RankHistoryStore`) is deliberately storage-agnostic — matching this codebase's existing pattern for `CacheStore` (interface first, in-memory implementation as the concrete default) — precisely so that whichever option is chosen doesn't change any caller.

**Recording point:** the orchestrator calls `rankHistoryStore.record(...)` immediately after a successful League-V4 fetch, using the `'ranked solo/duo'` entry if present (Requirement 10.1) — the same point in `DefaultLookupOrchestrator` that already reads League-V4 for `stats.rankedByQueue`. This does not add a new Riot API call; it reads data already being fetched for an existing purpose.

### Frontend: Gamemode_Filter (Requirement 9)

```typescript
export type QueueFilterValue = 'all' | 'ranked solo/duo' | 'ranked flex' | 'normal';

interface GamemodeFilterProps {
  value: QueueFilterValue;
  onChange: (value: QueueFilterValue) => void;
  /** Only offer values actually present in this report's included matches. */
  availableValues: readonly QueueFilterValue[];
}
```

Two independent instances are rendered — one in `.report-sidebar` (governing `ChampionPreferences` and `RolePerformance`), one in `.report-main` (governing the recent-matches list) — each with its own `useState` in `ProfileReportView`, defaulted per Requirement 9.4. Neither triggers a network request; both simply pick a different precomputed slice already present on `report`.

### Frontend: RankHistoryGraph (Requirement 10)

No charting library exists in this codebase today (`frontend/package.json` has no chart dependency), and this project's dependency footprint is intentionally minimal (React, React Router, and nothing else at runtime). A `Rank_History` line graph for one queue type, with at most a few dozen points, does not need a charting library — it is drawn as a small inline `<svg>` (a polyline over normalized LP values against snapshot index), consistent with how this codebase already favors small, dependency-free, purpose-built components (`AssetPlaceholder`, `ChampionIcon`) over pulling in a library for a narrow need.

```typescript
interface RankHistoryGraphProps {
  history: readonly RankSnapshot[]; // as delivered on the Profile_Report, see below
}
```

`RankHistory` reaches the frontend as part of the `ProfileReport` payload (`rankHistory: RankSnapshot[]`, `'ranked solo/duo'` only per Requirement 10.3's scope), fetched in the same lookup response — no separate endpoint, keeping this consistent with "no additional Riot calls, no additional round trips" for a value already resolved server-side at lookup time.

## Data Models

Additions to `ProfileReport` (backend `orchestrator/index.ts` and the frontend mirror in `api/types.ts`):

```typescript
interface ProfileReport {
  // ...existing fields unchanged, including the pre-existing `stats: ProfileStats`...
  statsByQueue: Record<QueueFilterValue, ProfileStats>;
  rolePerformanceByQueue: Record<QueueFilterValue, RolePerformanceEntry[]>;
  /** 'ranked solo/duo' only, oldest first, per Requirement 10.3. */
  rankHistory: RankSnapshot[];
}

interface RecentMatchSummary {
  // ...existing fields unchanged...
  queueType: string; // Requirement 9.2/9.3
}
```

No existing field changes shape or meaning. `stats` remains exactly what it is today (`statsByQueue['all']`), so every current consumer of `report.stats` is unaffected.

## Responsive Breakpoint

Unchanged from the layout-only version of this spec: a 960px breakpoint, `.report-columns` as a CSS grid (`var(--sidebar-width) 1fr` at/above it, single column below), `position: sticky` on `.report-sidebar` with `max-height: calc(100vh - 3rem); overflow-y: auto`, and `align-items: start` on the grid (required for sticky to function inside it). See this spec's git history / the original layout-only draft for the full CSS if needed — Requirements 7–10 don't change any of this mechanics, only what's rendered inside the sidebar.

## Error Handling

| Scenario | Behavior |
|---|---|
| Selected Queue_Filter_Value has zero matches | Requirement 7.4 / 8.5's explicit empty-state messages, not a blank panel. |
| Fewer than 2 Rank_Snapshots recorded | Requirement 10.4's "history will build up over future lookups" message. |
| `RankHistoryStore.record` fails (storage unavailable) | MUST NOT fail the lookup itself — Rank_History is supplementary. The orchestrator treats a recording failure the same way it treats other non-blocking enrichment failures elsewhere in this codebase (log and continue), returning `rankHistory: []` for this response if the store can't be reached, rather than surfacing an error to the visitor for a feature they didn't directly request. |
| Viewport resized across the 960px breakpoint mid-scroll | Unchanged from the layout-only draft — CSS-only reflow, no stale state. |

## Testing Strategy

- **`computeRolePerformance`**: unit tests (blank role excluded, tie-breaking, empty input) plus a property test mirroring the existing property coverage on `topChampionsOf` (games/win-rate/role invariants hold for any generated match set).
- **Per-queue `computeStats`/`computeRolePerformance` orchestration**: an orchestrator-level test asserting `statsByQueue['ranked solo/duo']` reflects only solo/duo matches from a mixed fixture, and `statsByQueue['all']` still equals today's single-pass result (regression guard for the "stats stays additive" claim above).
- **`RankHistoryStore`**: unit tests against the interface (record is idempotent per PUUID+queue+day; `getHistory` returns oldest-first; a `record` for a different PUUID doesn't appear in another player's history) — written against the interface so they pass regardless of which storage option is eventually chosen.
- **Existing `ProfileReportView.test.tsx` suite**: must keep passing unmodified for every relocated-without-content-change section (Requirement 6.2), exactly as in the layout-only draft of this spec.
- **New frontend tests**: Gamemode_Filter defaults (9.4) and independence (changing one filter doesn't affect the other's panel); RankHistoryGraph's two states (has-data vs. fewer-than-2-snapshots).
- Manual verification note carried over from the layout-only draft: no browser automation is available in this environment (Playwright requires Node 20+, this environment runs Node 18, and `chromium-cli` is not installed) — cross-width and visual checks are done by reading rendered output/CSS, not by screenshot, unless that tooling gap is separately resolved.

## Open Questions For The User

1. **Rank_History storage choice.** This is the decision with the most lasting consequence in this spec — it determines whether this project gains its first real database. Needs an explicit choice among (or beyond) the three options in "Storage options considered" before task work on Requirement 10 begins.
2. **Gamemode_Filter as one control or two.** This design chose two independent filters to satisfy the two different defaults given in the user's instructions. If dpm.lol's actual UI is a single shared control with some other mechanism for recent-matches having a different starting value, that's worth confirming — it changes the frontend component count but not the underlying per-queue data model.
3. **Sidebar width and general visual fidelity to dpm.lol** — carried over from the original layout-only draft, still unresolved since dpm.lol couldn't be fetched directly. A screenshot would remove the remaining guesswork here and in the Champion_Preferences card layout.
4. **Rank_History granularity expectations.** Confirming that "a point per lookup" (this design) is an acceptable v1 against whatever denser graph dpm.lol may actually show — since a true per-game graph would require a background-polling architecture well beyond this spec's scope.
