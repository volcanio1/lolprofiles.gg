# Implementation Plan: champion-build-stats

## Overview

Two layers, split so the frontend ships first (design.md "Overview", Requirement 14):

- **Frontend (Requirements 1–9)** — champion rows in the existing search dropdown +
  a new `/champion/:championKey` page that renders one endpoint's response through
  components that already exist (`SkillOrderView`, `RunesTab`'s `RunePageCard`,
  `ItemBuildRow`, `SummonerSpellIcon`, `SEO`, `RiotDataPage`, `LoadingIndicator`,
  `ErrorNotice`).
- **Backend (Requirements 10–14)** — one read-only endpoint over a new
  `championStatsStore` collaborator. Until the crawler pipeline lands the store is
  empty and the endpoint returns the empty-state response (Requirement 12.3), so
  the page renders Not_Enough_Data everywhere — the same cold-start behaviour
  `autofill-search` shipped with (Requirement 14.1).

**Out of scope for this plan:** the crawler / seeder / extractor / aggregator /
aggregate-document schema / storage budget / worker process (Requirement 12.2).
Those are their own spec (`champion-build-stats-pipeline`, not yet drafted). This
plan builds only the `championStatsStore` *interface* + an in-memory fake + a
no-op impl; the Mongo impl that reads real aggregate documents is deferred to that
spec, because its document shape (design.md "Store": nested per-item-path cohort
sub-maps) is that spec's to fix.

**No change** to the lookup pipeline, the player profile, `POST /api/privacy/delete`
(this feature stores no per-player data — Requirement 12.1, "aggregates only"), or
any existing component's behaviour (Requirement 9).

## Interpretation choices — NOT user-specified, confirm before/while building

1. **`Display_Floor`** (Req 7.1/7.4) — no value in the spec. Proposed
   **`DISPLAY_FLOOR = 100`** total games. Frontend-only, belt-and-braces below the
   backend's own `popular: null` gate. **Kept out of the parity-checked constants**
   (it has no backend counterpart — see task 7.2).
2. **Backend display floor** (Req 11.5, "the backend's display floor") — a distinct
   value the store applies to force `popular: null`. Proposed **`BACKEND_DISPLAY_FLOOR
   = 100`** (same number, different layer). Needed by the in-memory fake + endpoint
   tests (tasks 2.4 / 3.4 / 6.1).
3. **Backend modal threshold** (Req 11.6, design "Store") — the minimum cohort
   share for a skill order / rune page / spell pair to be emitted rather than
   `null`. Proposed **`MODAL_MIN_SHARE = 0.30`** of the item-path cohort. Needed by
   tasks 2.4 / 6.1.
4. **Rank_Bucket v1 set** — `EMERALD_PLUS / DIAMOND_PLUS / MASTER_PLUS / ALL`.
   design.md calls this a v1 *recommendation*, not settled; task 1.1 adopts it —
   confirm.
5. **`meta.patch` / `meta.lastUpdatedAt` wire encoding** — this plan assumes
   `lastUpdatedAt` is **epoch ms** (so `relativeAge` consumes it directly) and
   `patch` is a **display string** (e.g. `"14.18"`). Confirm before task 10.1.
6. **`championStatsStore` is a REQUIRED `ApiDependencies` field** (like
   `liveGameOrchestrator` / `scoutingOrchestrator`), not optional — drives the
   task 4.3 fan-out size.
7. **Unknown-champion treatment** (Req 3.2 permits either) — this plan pins it to an
   **in-page "Unknown champion" state** (not a route change to `NotFoundPage`), so
   the URL stays shareable. Confirm.
8. **Champion-key source on the backend** (task 1.2) — **bundle a static champion-id
   list** generated from Data Dragon at build time, rather than adding the backend's
   first-ever runtime Data Dragon fetch. Confirm — the alternative is a real
   fetch+cache layer.

Specified and fixed (no choice): `Min_Sample = 500`, `Core_Item_Count = 3`
(Glossary, Req 13.1); `Max_Champion_Suggestions = 5` (Req 1.3); `MIN_QUERY_LENGTH
= 2` (existing); region default `world` (Req 6.5.3).

---

## Backend

- [x] 1. Shared constants + the champion-key set
  - [x] 1.1 **New dir `backend/src/champions/`** + `buildStatsConstants.ts` —
    `MIN_SAMPLE = 500`, `CORE_ITEM_COUNT = 3`, `BACKEND_DISPLAY_FLOOR`,
    `MODAL_MIN_SHARE`, `ROLE_VALUES` (`TOP`/`JUNGLE`/`MIDDLE`/`BOTTOM`/`UTILITY`/`ALL`),
    `RANK_BUCKET_VALUES` (choice 4), `clampRole` / `clampRank` / `clampRegion`
    (unknown value → that filter's default; caller echoes the applied value —
    Req 10.4).
    - _Requirements: 13.1, 10.4, 11.4_
  - [x] 1.2 Champion-key set — **bundle `backend/src/champions/championKeys.ts`**, a
    generated `ReadonlySet<string>` of valid `Champion_Key`s (choice 8; a
    `scripts/` one-liner regenerates it from Data Dragon `champion.json` at a pinned
    version, committed output, no runtime fetch). Expose `isKnownChampionKey(key)`.
    If choice 8 flips to a runtime fetch, this subtask grows a fetch+cache module
    modelled on the frontend `staticData` cache — flag at that point.
    - _Requirements: 3.2 (backend half), 10.3_

- [x] 2. The `championStatsStore` collaborator
  - [x] 2.1 `backend/src/db/championStatsStore.ts` — `ChampionStatsStore` interface:
    `getBuildStats(championKey, filters): Promise<ChampionStatsResult | null>`.
    Per design.md "Store", the **store** (not the route) owns loading the
    per-`(championKey, role, rankBucket, region, patch)` doc(s) and resolving:
    `popular` (max-games item path), `highestWinRate` (max `wins/games` among paths
    with `games ≥ MIN_SAMPLE`, else `null`), and for each the modal skill order /
    rune page / spells **restricted to that path's cohort** (`null` when no value
    clears `MODAL_MIN_SHARE`). Plus `meta`: `patch` (string), `lastUpdatedAt`
    (epoch ms), `availableRoles`, `defaultRole`, `availableRanks`, `defaultRank`,
    `availableRegions`, `overall { winRate, pickRate, totalGames }`. `popular` →
    `null` when `overall.totalGames < BACKEND_DISPLAY_FLOOR`.
    - _Requirements: 11.1, 11.4, 11.5, 11.6, 12.1_
  - [x] 2.2 `InMemoryChampionStatsStore` (+ `createInMemoryChampionStatsStore` seeded
    from fixtures) and `createNoopChampionStatsStore` (every `getBuildStats` →
    `null`), mirroring `MatchStore` / `LookedUpPlayerStore` / `ProfileSnapshotStore`
    (Interface + `InMemory…` + `createNoop…` + `Mongo…`).
    - _Requirements: 12.3_
  - [x] 2.3 **Mongo impl deferred to `champion-build-stats-pipeline`** — leave
    `// TODO(champion-build-stats-pipeline): MongoChampionStatsStore` at the
    interface + a note in design.md's "Store" section. The composition root wires
    the **no-op** impl for now (task 4.2). This is the Requirement 14.1
    frontend-first rollout.
    - _Requirements: 14.1_
  - [x] 2.4 `championStatsStore.test.ts` — in-memory fake: modal-within-cohort
    selection; `MIN_SAMPLE` gate → `highestWinRate` `null` when no path clears 500;
    `popular` = max-games path; `popular` `null` below `BACKEND_DISPLAY_FLOOR`;
    sub-map → `null` below `MODAL_MIN_SHARE`; empty store → `null`.
    - _Requirements: 11.4, 11.5, 11.6_

- [x] 3. The build-stats endpoint
  - [x] 3.1 `backend/src/api/championBuildStats.ts` —
    `createChampionBuildStatsHandler({ championStatsStore })`. Reads `:championKey` +
    `role` / `rank` / `region`; unknown key → **404** (Req 10.3); unknown filter
    value → **clamp to default**, never 400, applied value reported in
    `filtersApplied` (Req 10.4). **No `RateLimitManager`, no Riot client** injected
    (Req 10.2) — assert structurally in tests.
    - _Requirements: 10.1, 10.2, 10.3, 10.4_
  - [x] 3.2 Response assembly (Req 11): `{ champion { key, name }, filtersApplied
    { role, rank, region }, meta { patch, lastUpdatedAt, availableRoles,
    defaultRole, availableRanks, defaultRank, availableRegions, overall { winRate,
    pickRate, totalGames } }, popular: Build | null, highestWinRate: Build | null }`.
    A `Build`: `{ matchCount, winRate, pickRate, coreItems: number[] (≤
    CORE_ITEM_COUNT), startingItems: number[] | null, skillOrder: { maxOrder:
    ('Q'|'W'|'E')[], perLevel: (1|2|3|4)[] } | null, runes: RunePage | null,
    summonerSpells: [number, number] | null }`. `Build.runes` is emitted in the
    **`MatchParticipant['runes']` shape** (`primaryStyle`, `primarySelections`,
    `secondaryStyle`, `secondarySelections`, `statShards`) so the lifted
    `RunePageCard` (task 12.1) consumes it directly. `winRate`/`pickRate` ∈ `[0,1]`;
    `matchCount`/`totalGames` non-negative ints.
    - _Requirements: 11.1, 11.2, 11.3, 11.6_
  - [x] 3.3 Empty / unavailable / throwing store → **200** with `popular` +
    `highestWinRate` `null` and empty `meta` option lists (Req 12.3), never 5xx. A
    store throw also logs `ApiLogger.championBuildStatsFailed` (new logger method +
    console impl, mirroring `suggestFailed`); no detail leak to the body.
    - _Requirements: 12.3, 11.5_
  - [x] 3.4 `popular` `null` / `highestWinRate` `null` decisions come straight from
    the store (task 2.1) — the handler only serializes; add a test that a
    store result with `popular: null` serializes to the Not_Enough_Data 200 body.
    - _Requirements: 11.4, 11.5_

- [x] 4. Wiring
  - [x] 4.1 `championStatsStore` added as a **required** `ApiDependencies` field
    (choice 6); route registered in `createApiRouter` alongside
    `/api/players/suggest` etc.:
    `router.get('/champions/:championKey/build-stats',
    createChampionBuildStatsHandler({ championStatsStore: deps.championStatsStore }))`.
    - _Requirements: 10.1_
  - [x] 4.2 Composition root selects no-op vs (future) Mongo the way the other
    stores do (`databaseClient.enabled ? … : noop`) — for now **always the no-op**
    (task 2.3).
    - _Requirements: 14.1_
  - [x] 4.3 Fan-out: every test that builds `ApiDependencies` (app.test.ts,
    api/*.test.ts, endToEnd.test.ts, liveGame/integration.test.ts,
    clashScouting/integration.test.ts) gets a stub `championStatsStore` — same
    pattern as the `liveGameOrchestrator` / `scoutingOrchestrator` fan-outs
    (`live-game` task 7 updated 8 sites).
    - _Requirements: 10.1_
  - [x] 4.4 **No `POST /api/privacy/delete` change** — this store holds no
    puuid-keyed data (Req 12.1). Add a one-line comment in the privacy handler
    saying so, so a future reader doesn't assume it was missed.
    - _Requirements: 12.1_
  - [x] 4.5 CORS allowlist + SPA-fallback exemption are automatic for `/api/*`
    (Req 10.5) — add one structural assertion in the endpoint tests (task 6.1) that
    the route is under the `/api` router, matching how `suggest` / `live-game` rely
    on it.
    - _Requirements: 10.5_

- [x] 5. Backend checkpoint — `npm run test:backend` + tsc + eslint clean.

- [x] 6. Backend endpoint tests
  - [x] 6.1 `backend/src/api/championBuildStats.test.ts` — 404 unknown key; filter
    clamping (bad `role`/`rank`/`region` → default, echoed in `filtersApplied`);
    empty store → 200 empty-state (`popular`/`highestWinRate` `null`, empty `meta`
    lists); throwing store → 200 empty-state + logged once, no detail leak; store
    result surfaces modal-within-cohort values; `MIN_SAMPLE` gate; `null`
    sub-sections passed through unchanged; `popular: null` store result → 200
    Not_Enough_Data body; structural: no Riot client / no rate-limit reservation /
    route under `/api`.
    - _Requirements: 10.2, 10.3, 10.4, 10.5, 11.4, 11.5, 11.6, 12.3_

---

## Frontend

- [x] 7. Champion suggestion matching (pure) + shared constants
  - [x] 7.1 `frontend/src/domain/championSuggestions.ts` — `MAX_CHAMPION_SUGGESTIONS
    = 5`; `matchChampions(query, index, limit?)`: `#` in query OR `null` index OR
    trimmed length `< MIN_QUERY_LENGTH` → `[]`; else anchored, case-insensitive
    **prefix** match on each `StaticDataIndex.champions` entry's display `name`
    (not substring / fuzzy / `Champion_Key`); sorted by `name.localeCompare(other)`
    (bare, default locale — matches design's snippet); capped at `limit`.
    `championPathFor(key, filters?)` → `/champion/{key}` with a query string built
    only from non-default filter values.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 9.1_
  - [x] 7.2 `frontend/src/domain/buildStatsConstants.ts` — mirror `MIN_SAMPLE` (500)
    + `CORE_ITEM_COUNT` (3) + the Role / Rank_Bucket vocab. **`DISPLAY_FLOOR` lives
    here too but is explicitly excluded from the parity comparison** (no backend
    counterpart — choice 1). `domain/parity.test.ts` extended with an `existsSync`-
    guarded block cross-checking `MIN_SAMPLE` / `CORE_ITEM_COUNT` / the two vocab
    arrays against `backend/src/champions/buildStatsConstants.ts` (regex-parsed as
    text, the way `MIN_QUERY_LENGTH` / `MAX_SUGGESTIONS` already are).
    - _Requirements: 13.1_
  - [x] 7.3 `championSuggestions.test.ts` — prefix/case/anchor (`"ja"` → Jax, Janna,
    Jarvan IV; not Rammus), limit, alphabetical order, `#` short-circuit, `null`
    index → `[]`, sub-`MIN_QUERY_LENGTH` → `[]`; `championPathFor` with/without
    non-default filters.
    - _Requirements: 1.1–1.4, 9.1_

- [x] 8. SearchForm: the "Champions" group
  - [x] 8.1 `SearchForm` composes `[...champions, ...players]` into ONE flat array
    for `activeIndex` / `aria-activedescendant`; the render splits into two
    `role="group"` sections. **Group labels ("Champions", "Players") render only
    when BOTH kinds are present** (Req 2.1); a players-only dropdown renders exactly
    as today — no label (Req 2.6, 9.x). Champions group first. `select(row)`
    branches on `row.kind`. Champion matching is synchronous in the component — no
    change to `usePlayerSuggestions`.
    - _Requirements: 1.6, 2.1, 2.6_
  - [x] 8.2 Each champion row: `ChampionIcon` (prop `championKey`; degrades to
    `AssetPlaceholder` exactly as elsewhere) + champion display name. `role="option"`
    with a stable id in the same flat sequence as player rows.
    - _Requirements: 2.2_
  - [x] 8.3 Keyboard model from `autofill-search` Req 4 extends across both groups
    as one flat sequence — Arrow Down from the last champion row → first player row;
    wrapping, `aria-activedescendant`, Enter-to-select, Escape-to-dismiss unchanged
    over the combined list.
    - _Requirements: 2.3_
  - [x] 8.4 Selecting a champion row (click or Enter) calls a new
    `onSelectChampion(key)` prop and does **not** run `validateRiotId` or a lookup;
    selecting a player row behaves exactly as today (Req 2.5); no suggestions of
    either kind → no dropdown, no empty state (Req 2.6).
    - _Requirements: 2.4, 2.5, 2.6_
  - [x] 8.5 `#` in the value → zero champion matches, dropdown behaves exactly as
    today (Req 9.1); a full Riot ID + Enter with no active row submits a lookup even
    if `gameName` matches a champion (Req 9.2); no network request / no measurable
    latency added — bounded scan of ~170 names on the existing debounce (Req 9.3);
    champion suggestions still appear when the persistent store is disabled but the
    static-data index is `ready` (Req 9.4, 1.5).
    - _Requirements: 1.5, 9.1, 9.2, 9.3, 9.4_

- [x] 9. SearchPage wiring
  - [x] 9.1 `SearchPage` passes `onSelectChampion={(key) => navigate(championPathFor(key))}`
    (history **push** — Req 3.6). The prefilled `/profile` form's `SearchForm` also
    gets `onSelectChampion` so a champion pick there navigates too.
    - _Requirements: 2.4, 3.6_

- [x] 10. Frontend data layer
  - [x] 10.1 `frontend/src/api/types.ts` — `ChampionBuild`, `ChampionStatsMeta`,
    `ChampionBuildStats` matching Req 11's wire shape. `Build.runes` reuses the
    existing `MatchParticipant['runes']` type. `meta.lastUpdatedAt: number` (epoch
    ms), `meta.patch: string` (choice 5).
    - _Requirements: 11.1, 11.2_
  - [x] 10.2 `fetchChampionBuildStats(championKey, filters, { baseUrl?, fetch?,
    signal? })` + `readChampionBuildStats` narrower in `lookupClient.ts` — omits a
    filter param at its `ALL`/`world` default (Req 4.1); a malformed / non-2xx /
    parse-failed / aborted response is narrowed to the **empty-state shape**
    (`popular`/`highestWinRate` `null`, empty `meta` lists), never thrown past the
    hook (design.md "api/types.ts").
    - _Requirements: 4.1, 4.4, 5.5_
  - [x] 10.3 Tests in `lookupClient.test.ts` — request URL (default filters
    omitted), hit parse, non-200 / malformed / abort → empty-state, signal
    passthrough.
    - _Requirements: 4.4_

- [x] 11. `useChampionBuildStats` hook
  - [x] 11.1 `frontend/src/hooks/useChampionBuildStats.ts` —
    `useChampionBuildStats(championKey, filters)` → `{ data, status, error, retry }`.
    Fetches on mount with a valid key and on any `role`/`rank`/`region` change
    (Req 4.1); no debounce; monotonic request-id guard copied from `useLookup`
    (`sequence` ref + `dispatched !== sequence.current`) — a stale response (late
    older request, or filters changed mid-flight) is ignored (Req 4.3);
    `AbortController` per fetch, aborted on change/unmount; never fetches for an
    unknown/empty key (the page short-circuits first — Req 4.5); a failed fetch sets
    `error` and leaves no spinner running (Req 4.4).
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x] 11.2 `useChampionBuildStats.test.ts` — one fetch per filter change; stale
    response dropped + old signal aborted; `retry()` re-issues; unmount aborts; no
    fetch for empty/unknown key.
    - _Requirements: 4.3_

- [x] 12. Component-reuse refactors (no behaviour change to existing views)
  - [x] 12.1 **Refactor `RunePageCard` out of `RunesTab.tsx`** into
    `frontend/src/components/RunePageCard.tsx`, changing its prop from `{ participant:
    MatchParticipant }` to `{ runes: MatchParticipant['runes']; championKey: string;
    variant?: 'analyzed' | 'default' }`. `RunesTab` updates its call site to
    `<RunePageCard runes={p.runes} championKey={p.championName} variant={p.isAnalyzedPlayer
    ? 'analyzed' : 'default'} />`. The component keeps its internal
    `isRunePageUnavailable(runes)` "Rune page unavailable." branch — that IS the
    Req 7.3 per-section fallback for runes, so `ChampionBuildPanel` (13.2) does NOT
    add its own runes fallback, it just lets the card render its branch. Existing
    `RunesTab` tests updated for the new prop; behaviour identical.
    - _Requirements: 5.3.5, 7.3, design.md "Component reuse notes"_
  - [x] 12.2 **Factor `SkillOrderView`'s presentational core.** Current API is
    `{ championName: string; skillOrder: readonly number[] }` where `skillOrder` is
    one ability-slot index (1–4) per level and the component derives max order via
    its exported `maxOrder(skillOrder)` helper. New `SkillOrderChart` core accepts
    `{ championKey: string; perLevel: readonly (1|2|3|4)[]; maxOrder: readonly
    ('Q'|'W'|'E')[] }` directly. **Mapping subtask:** write `perLevel` ↔ the old
    `number[]` model and `('Q'|'W'|'E')[]` ↔ the old numeric max-order record; the
    match tab keeps a thin `SkillOrderView` wrapper that computes those from
    `skillOrder` and renders `SkillOrderChart` (its tests stay green). Rename the
    exported helper to `maxOrderFromSkillOrder` to avoid the prop/function name
    collision. The panel feeds the wire `skillOrder` object straight to
    `SkillOrderChart`.
    - _Requirements: 5.3.4, 11.2, design.md "Component reuse notes"_
  - [x] 12.3 `frontend/src/components/CoreItemsRow.tsx` — a thin wrapper over the
    same item tile + `Tooltip` (`title` + `description={provider.itemDescription(id)}`)
    the Build Path tab / `ItemBuildRow` use; ids resolved via
    `useStaticData().itemIconUrl`; each unresolved id degrades to `AssetPlaceholder`.
    - _Requirements: 5.3.3_

- [x] 13. `ChampionBuildPanel`
  - [x] 13.1 `frontend/src/components/ChampionBuildPanel.tsx` — one `Build` →
    `winRate` + `pickRate` (percentage, one decimal), `matchCount` labelled
    unambiguously as games on *this* build ("1,240 games", thousands separator),
    `CoreItemsRow`, `SkillOrderChart`, `RunePageCard`, two `SummonerSpellIcon`s.
    - _Requirements: 5.3.1, 5.3.2, 5.3.3, 5.3.4, 5.3.5, 5.3.6_
  - [x] 13.2 Per-section fallback (Req 7.3): a `null` `skillOrder` / `summonerSpells`
    renders a small "not enough data" line for that section only; a `null` `runes`
    is handled by `RunePageCard`'s own unavailable branch (task 12.1); the panel
    still renders the sections it has. (`startingItems` is not rendered — task 21.4,
    optional — so it is not in this list.)
    - _Requirements: 7.3_
  - [x] 13.3 No figure ever renders as `NaN` / `undefined` / `Infinity%` / a URL
    with an unresolved value — a missing field routes to the section fallback, never
    a broken figure (Req 5.5).
    - _Requirements: 5.5_

- [x] 14. `ChampionStatsFilters`
  - [x] 14.1 `frontend/src/components/ChampionStatsFilters.tsx` — three controls
    (Role, Rank_Bucket, Region_Filter); options come **only** from `meta.available*`
    (no hard-coded sets — Req 6.2); a control with one advertised option is rendered
    **disabled, not hidden** (Req 6.3); Role labels use the site's existing role
    vocabulary/icons, not raw `teamPosition` strings (Req 6.6); a change emits
    upward (parent updates URL + refetches).
    - _Requirements: 6.1, 6.2, 6.3, 6.6_

- [x] 15. `ChampionBuildPage`
  - [x] 15.1 `frontend/src/pages/ChampionBuildPage.tsx` — reads `:championKey` +
    `useSearchParams` filters; **unknown key** (not in `StaticDataIndex.champions`
    once `ready`) → an **in-page "Unknown champion" state** (choice 7), **no backend
    request** (Req 3.2); rendered inside `RiotDataPage` (Req 3.5). Before the index
    is `ready`, render the loading state, not "unknown".
    - _Requirements: 3.1, 3.2, 3.5_
  - [x] 15.2 Filter state ↔ URL: `role`/`rank`/`region` in the query string
    (`?role=BOTTOM&rank=EMERALD_PLUS&region=world`), read back on load (Req 3.3); an
    absent / not-advertised value falls back to that filter's default without
    erroring (Req 3.4, 6.5 — Role → `meta.defaultRole` ?? `ALL`; Rank →
    `meta.defaultRank` ?? `ALL`; Region → `world`); a filter change is
    `setSearchParams(next, { replace: true })`, a new champion is a push (Req 3.6).
    Defaults resolve from `meta` after the first response, so the initial fetch goes
    out with whatever the URL says (or bare).
    - _Requirements: 3.3, 3.4, 3.6, 6.4, 6.5_
  - [x] 15.3 Header (Req 5.1): champion square icon + display name + the
    filter-scoped overall `winRate` / `pickRate` (`meta.overall`, one decimal) +
    total games as a plain thousands-separated integer.
    - _Requirements: 5.1_
  - [x] 15.4 Body layout (Req 5.2): two `ChampionBuildPanel`s — "Most popular"
    (`popular`) and "Highest win rate" (`highestWinRate`) — side by side on wide
    viewports, stacked on narrow; when they are the same item path both panels still
    render and MAY show a "most popular is also highest win rate" note (Req 5.4 —
    the note itself is optional, task 21.3).
    - _Requirements: 5.2, 5.4_
  - [x] 15.5 State machine (design.md "States"): `loading` → `LoadingIndicator`;
    `error` → `ErrorNotice` + `retry()`; `ready` & (`overall.totalGames <
    DISPLAY_FLOOR` OR `popular == null`) → single "Not enough games recorded for
    these filters yet" notice + widen-filters hint, **no panels** (Req 7.1); `ready`
    & `popular` set & `highestWinRate == null` → popular panel + an explicit "No
    build has reached 500 games at these filters yet" card in place of the second
    panel (Req 7.2); `ready` & both set → both panels.
    - _Requirements: 4.2, 4.4, 7.1, 7.2, 7.4_
  - [x] 15.6 Freshness + provenance (Req 8): show `meta.patch` and, from
    `meta.lastUpdatedAt` (epoch ms), a relative "updated N ago" via
    `domain/format.ts` `relativeAge`; attribute the data as **this site's own
    sample, not Riot**, consistent with `RiotDataPage` copy; **no** crawl/refresh
    control anywhere (Req 8.3).
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 15.7 `SEO` — `title` names the champion + active filters; `description` a
    one-liner (Req 3.5). `SEO` auto-appends the site name.
    - _Requirements: 3.5_

- [x] 16. Route registration
  - [x] 16.1 `frontend/src/App.tsx` — `<Route path="/champion/:championKey"
    element={<ChampionBuildPage />} />` before the `*` catch-all.
    - _Requirements: 3.1_

- [x] 17. Styling
  - [x] 17.1 `frontend/src/styles.css` — `.champion-build-*` classes (header, panel
    grid two-up → stacked, filter bar, freshness line, not-enough-data notice) +
    `.suggestion-group` / `.suggestion-group-label` for the dropdown groups. Reuse
    existing tokens (black/gold, **gold = win, never green/red** — [[design-system]]).
    `vite build` clean.
    - _Requirements: 2.1 (visual), 5.2 (visual), design-system_

- [x] 18. Frontend tests
  - [x] 18.1 `SearchForm.test.tsx` (new cases) — "Champions" group renders above
    "Players" **only when both present**; players-only dropdown has no group label
    and behaves as today; combined keyboard traversal crosses the group boundary; a
    champion row click/Enter calls `onSelectChampion` and runs **no**
    validation/lookup; player rows unchanged; no dropdown when both groups empty;
    `#` in value → no champion group; full Riot ID + Enter still submits.
    - _Requirements: 1.6, 2.1–2.6, 9.1, 9.2_
  - [x] 18.2 `ChampionBuildPage.test.tsx` — unknown key → in-page "Unknown champion",
    **no fetch**; index-not-ready → loading not "unknown"; filters round-trip through
    the URL (load reads, change writes with `replace`, new champion pushes);
    stale-response guard; the five state rows from design.md "States"; the
    `MIN_SAMPLE` gate shows the "no build ≥ 500 games" card not a small-sample
    build; freshness line renders `meta.patch` + relative time; no refresh control
    in the DOM.
    - _Requirements: 3.2, 3.3, 3.4, 3.6, 4.3, 7.1, 7.2, 8.1, 8.3_
  - [x] 18.3 `ChampionBuildPanel.test.tsx` — full build renders all six sections;
    `null` `skillOrder`/`summonerSpells` show their own "not enough data" line, panel
    still renders; `null` `runes` → `RunePageCard`'s unavailable branch; percentages
    format to one decimal; `matchCount` shows with a thousands separator + a "games
    on this build" label; no `NaN`/`Infinity%` on holey data.
    - _Requirements: 5.3, 5.5, 7.3_
  - [x] 18.4 `ChampionStatsFilters.test.tsx` — options come from `meta.available*`; a
    one-option list renders disabled; Role uses site role labels not raw
    `teamPosition`.
    - _Requirements: 6.2, 6.3, 6.6_
  - [x] 18.5 `championSuggestions.test.ts` + `domain/parity.test.ts` extension (from
    tasks 7.2 / 7.3); `RunesTab.test.tsx` + `SkillOrderView.test.tsx` updated for the
    refactored props and still green.
    - _Requirements: 1.1–1.4, 13.1_

- [x] 19. Frontend checkpoint — `npm run test:frontend` + tsc + eslint + `vite
  build` clean; existing `SearchForm` / `RunesTab` / `SkillOrderView` / pages
  suites re-verified after the refactors.

- [x] 20. Documentation + verification
  - [x] 20.1 README API section — new `### GET /api/champions/:championKey/build-stats`:
    params + clamp behaviour, 404 on unknown key, pre-aggregated read (no Riot call,
    no shared rate budget, edge-cacheable), empty-store → 200 empty-state, cold-start
    note (pipeline not yet built → Not_Enough_Data everywhere).
    - _Requirements: 8.2_
  - [x] 20.2 README — new route `/champion/:championKey` in the routes list; a
    "Known gaps" bullet that the numbers are this site's own crawl sample (not Riot
    aggregates) and that the crawler pipeline is a separate, not-yet-built spec
    (`champion-build-stats-pipeline`).
    - _Requirements: 8.2, 14.1_
  - [x] 20.3 `npm run test:backend` + `npm run test:frontend` + both lints + `vite
    build` clean.
  - [x] 20.4 Run the backend with the no-op store: `GET
    /api/champions/Jinx/build-stats` → 200 empty-state; `GET
    /api/champions/NotAChamp/build-stats` → 404; bad `?rank=` → 200 with
    `filtersApplied.rank` clamped. `/champion/Jinx` in the app renders the
    Not_Enough_Data state with the filter bar present and the region control
    disabled.
  - [x] 20.5 Type a champion prefix in the search box → the "Champions" group
    appears; selecting a row lands on `/champion/{key}`; a Riot ID with `#` still
    submits a lookup unchanged. (Browser interaction otherwise covered by the
    `SearchForm` tests — no automation on Node 18.)

## Task dependency graph

```json
{
  "1":  [],
  "2":  ["1"],
  "3":  ["2"],
  "4":  ["3"],
  "5":  ["4"],
  "6":  ["5"],
  "7":  ["1"],
  "8":  ["7"],
  "9":  ["7", "8"],
  "10": ["7"],
  "11": ["10"],
  "12": [],
  "13": ["11", "12"],
  "14": ["10"],
  "15": ["11", "13", "14"],
  "16": ["15"],
  "17": ["8", "15"],
  "18": ["8", "9", "12", "13", "14", "15", "16", "17"],
  "19": ["18"],
  "20": ["6", "16", "19"]
}
```

Backend (1→6) and the pure frontend front (7, 12) can start in parallel. Task 12
(reuse refactors) has no deps and de-risks the trickiest integrations
(`RunePageCard` / `SkillOrderView` prop changes) — do it early.

## Optional (skipped by default)

- [ ] * 21.1 Property test: `matchChampions` never returns a non-prefix match and
  never exceeds `MAX_CHAMPION_SUGGESTIONS`, for any query / index.
- [ ] * 21.2 Property test: `readChampionBuildStats` returns a well-formed
  empty-state shape (never throws, never `NaN`) for any malformed body.
- [x] * 21.3 Render the "most popular is also highest win rate" note (done in task 15 — `ChampionBuildPage` passes `note` when the item paths match) (Req 5.4 —
  MAY, not SHALL).
- [ ] * 21.4 `startingItems` row in `ChampionBuildPanel` (Req 11.2 carries the
  field; Req 5.3 does not list it among the required sections).

## Notes

- **Cross-spec dependency:** none blocking. This plan needs `specs/database/`'s
  store-pattern conventions (Interface + `InMemory…` + `createNoop…` + `Mongo…`)
  but not a live DB — the no-op store is the shipped path (Req 14.1).
- **Property-test convention** (matching `live-game` / `clash-scouting`):
  fast-check, ≥100 runs, `* `-tagged and skipped by default.
- **Downstream (separate spec — `champion-build-stats-pipeline`, not this plan):**
  seeder (League-V4 entries + apex lists → ranked PUUIDs, weekly), crawler (match
  detail + timeline, 2 Riot calls/match, shared `RateLimitManager`, capped to a
  fraction of the budget — Req 12.2), extractor (timeline `ITEM_PURCHASED/SOLD/UNDO`
  → purchase order → first 3 completed items + boots; `SKILL_LEVEL_UP` → skill
  order; `perks` + spells from match detail), aggregator (`$inc` upserts into the
  per-`(championKey, role, rankBucket, region, patch)` documents, discard the match),
  and `MongoChampionStatsStore` (task 2.3). Storage: aggregates only, ~60–250 MB,
  fits M0 — the raw match corpus does not and is never stored (Req 12.1).
