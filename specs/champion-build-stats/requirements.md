# Requirements Document

## Introduction

Today the only thing a visitor can look up is a player. This feature adds the
other half of what every competitor (op.gg, u.gg, Mobalytics) offers: a
**champion build page** — "how is Jinx built, and how does it perform, at my
rank." It has two entry points that share one input box:

1. **Search autofill.** When the value in the existing Search_Form is a champion
   name rather than a Riot ID (no `#`, matches a known champion), the suggestion
   dropdown offers champion rows alongside player rows. Picking one navigates to
   the champion page.
2. **The champion page itself** — a brand-new route showing, for a champion
   filtered by role / rank / region: win rate, pick rate, and two builds — the
   **most popular** build and the **highest-win-rate** build (the latter only
   drawn from builds with at least `Min_Sample` games) — each with its core item
   order, skill order, rune page, and the exact number of games played on that
   build.

**Hard constraint that shapes everything:** Riot publishes no aggregate/stats
endpoint. Every number on this page comes from **this site's own aggregation of
crawled ranked matches** (see `specs/champion-build-stats-pipeline/`, drafted
separately). That makes the page strictly downstream of that pipeline: with no
aggregates there is nothing to show, and the page degrades to an explicit
"not enough data yet" state — its cold-start condition on day one and its
permanent condition for rare champion / rank / region combinations.

**Scope boundaries for this spec:**

- This document specifies the **frontend** in full (Requirements 1–9) and
  **drafts** the backend contract the frontend depends on (Requirements 10–14).
  The crawler, seeder, extractor, aggregate schema, storage budget and worker
  process are a separate spec.
- One new read-only endpoint, one new route, one new page. No change to the
  lookup pipeline, the player profile, or any existing component's behaviour.
- Region filtering is **contract-only** in v1: the frontend renders whatever
  region options the backend advertises, and the backend may advertise only
  `world` at first.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend combined).
- **Search_Form**: The existing `frontend/src/components/SearchForm.tsx` combobox.
- **Suggestion_Dropdown**: The listbox the Search_Form renders while typing
  (`autofill-search` Requirement 3).
- **Player_Suggestion**: An existing dropdown row sourced from `looked_up_players`
  (`autofill-search`). Unchanged by this spec.
- **Champion_Suggestion**: A new dropdown row for a champion whose display name
  prefix-matches the typed query. Sourced entirely from the client-side
  `StaticDataIndex.champions` map — no network call.
- **Champion_Key**: Data Dragon's stable champion identifier, e.g. `MonkeyKing`,
  `Jinx`. Contains no `#` or spaces, so it is URL-path-safe. Distinct from the
  display name (`Wukong`).
- **Champion_Query**: The trimmed Search_Form value when it contains no `#`.
- **Champion_Page**: The new route `/champion/:championKey`.
- **Role**: One of Riot's `teamPosition` values — `TOP`, `JUNGLE`, `MIDDLE`,
  `BOTTOM`, `UTILITY` — or `ALL`.
- **Rank_Bucket**: A coarse rank band the backend aggregates by, e.g.
  `EMERALD_PLUS`, `DIAMOND_PLUS`, `MASTER_PLUS`, or `ALL`. The exact set is
  defined by the backend and delivered in the response `meta`.
- **Region_Filter**: A platform grouping, e.g. `world`, `na`, `euw`, `kr`. The
  exact set is defined by the backend and delivered in the response `meta`.
- **Build_Stats_Endpoint**: The new `GET /api/champions/:championKey/build-stats`
  route.
- **Build_Stats_Response**: The JSON object that endpoint returns (Requirement 11).
- **Build**: One row of the response — a core item path plus the modal skill
  order, rune page and summoner spells among the games that used that item path,
  and the stats for that cohort: `matchCount`, `winRate`, `pickRate`.
- **Popular_Build**: The Build whose item path was used in the most games for the
  selected filters.
- **Best_Build**: The Build with the highest `winRate` among Builds whose
  `matchCount` is at least `Min_Sample`. May be absent.
- **Min_Sample**: The minimum `matchCount` a Build needs to be eligible as the
  Best_Build — **500**. A single shared constant, cross-checked between frontend
  and backend the way `MIN_QUERY_LENGTH` already is (`frontend/src/domain`
  parity test).
- **Core_Items**: The ordered list of completed (legendary/mythic) items plus the
  boots choice that defines a Build's item path — the first `Core_Item_Count`
  such purchases, in purchase order. `Core_Item_Count` = 3.
- **Skill_Order**: The ability max order (e.g. `Q → W → E`) plus the per-level
  leveling grid, in the shape `SkillOrderView` already renders.
- **Rune_Page**: Keystone, primary tree + runes, secondary tree + runes, and the
  three stat shards — the shape `RunesTab`'s `RunePageCard` already renders.
- **RiotDataPage**: The compliance wrapper (`frontend/src/compliance/`) every
  Riot-data view is mounted inside.
- **Not_Enough_Data**: The state where the backend has no aggregate row, or only
  rows below a display floor, for the requested filters.

## Requirements

### Requirement 1: Champion suggestions in the search dropdown

**User Story:** As a visitor who types a champion name into the search box, I want
the champion to appear as a clickable suggestion, so I can reach its build page
without knowing there is a separate URL.

#### Acceptance Criteria

1. WHEN the Search_Form value contains no `#` AND, trimmed, is at least
   `MIN_QUERY_LENGTH` (2) characters, THE System SHALL compute Champion_Suggestions
   by prefix-matching the query, case-insensitively, against each entry's display
   `name` in `StaticDataIndex.champions`.
2. THE match SHALL be an anchored prefix match on the display name, not a
   substring, fuzzy, or Champion_Key match. (`"ja"` → Jax, Janna, Jarvan IV;
   not Rammus.)
3. Champion_Suggestions SHALL be ordered alphabetically by display name and
   capped at `Max_Champion_Suggestions` (5).
4. THE computation SHALL be purely client-side against the already-loaded
   `StaticDataIndex` — no request is issued, and it produces no results until the
   static data index is `ready`.
5. WHEN the static data index is not `ready`, THE System SHALL render no
   Champion_Suggestions and SHALL NOT block or delay the Player_Suggestions.
6. Champion_Suggestions and Player_Suggestions SHALL be able to appear at the same
   time (a champion named like a searched player, e.g. `Lux`), each in its own
   labelled group within the one dropdown.

### Requirement 2: Dropdown layout with both suggestion kinds

**User Story:** As a visitor, I want the dropdown to make it obvious which rows
open a champion page and which open a player profile.

#### Acceptance Criteria

1. WHEN both kinds are present, THE Suggestion_Dropdown SHALL render the
   Champion_Suggestions group first, then the Player_Suggestions group, each under
   a non-interactive group label ("Champions", "Players").
2. Each Champion_Suggestion row SHALL show the champion square icon
   (`ChampionIcon`, degrading to `AssetPlaceholder` exactly as elsewhere) and the
   champion display name.
3. THE combobox keyboard model from `autofill-search` Requirement 4 SHALL extend
   across both groups as one flat sequence: Arrow Down from the last champion row
   moves to the first player row; `aria-activedescendant`, wrapping, Enter-to-select
   and Escape-to-dismiss behave exactly as they do today, over the combined list.
4. Selecting a Champion_Suggestion (click or Enter) SHALL navigate to
   `/champion/{Champion_Key}` and SHALL NOT run Riot ID validation or a lookup.
5. Selecting a Player_Suggestion SHALL behave exactly as it does today
   (`autofill-search` Requirement 5) — unchanged.
6. WHEN there are no suggestions of either kind, THE System SHALL render no
   dropdown — no empty state — exactly as today.

### Requirement 3: The champion page route

**User Story:** As a visitor, I want a shareable, bookmarkable URL for a
champion's build.

#### Acceptance Criteria

1. THE System SHALL register the route `/champion/:championKey` rendering the
   Champion_Page.
2. THE `:championKey` segment SHALL be a Champion_Key. WHEN it is not a key
   present in `StaticDataIndex.champions` (after the index is `ready`), THE
   Champion_Page SHALL render the existing not-found treatment (the `NotFoundPage`
   content or an equivalent in-page "Unknown champion" state), not a blank page
   and not a request to the backend.
3. THE selected Role, Rank_Bucket and Region_Filter SHALL be reflected in the URL
   query string (`?role=BOTTOM&rank=EMERALD_PLUS&region=world`), so the exact view
   is shareable, and SHALL be read back from the query string on load.
4. WHEN a filter query parameter is absent or not a value the backend advertises,
   THE Champion_Page SHALL fall back to that filter's default (Requirement 6.5)
   without erroring.
5. THE Champion_Page SHALL render inside `RiotDataPage` and SHALL set page
   `<title>` / meta via `SEO` to name the champion and the active filters.
6. Navigating between champion pages, or changing a filter, SHALL update the URL
   via the router (history push for a new champion, replace for a filter change)
   so Back returns to the previous champion but not through every filter tweak.

### Requirement 4: Fetching build stats

**User Story:** As the Champion_Page, I want one endpoint call that returns
everything the page shows for the current filters.

#### Acceptance Criteria

1. WHEN the Champion_Page mounts with a valid Champion_Key, OR the Role /
   Rank_Bucket / Region_Filter changes, THE System SHALL request
   `GET /api/champions/{championKey}/build-stats` with `role`, `rank` and `region`
   query parameters (omitting a parameter that is at its `ALL`/`world` default is
   permitted).
2. THE System SHALL show a loading state while the request is in flight, using the
   shared `LoadingIndicator`.
3. WHEN a newer request completes before an older one, OR the filters change while
   a request is in flight, THE System SHALL ignore the stale response (the same
   monotonic-request-id guard `usePlayerSuggestions` and `useLookup` use).
4. WHEN the request fails (network, non-2xx, parse), THE System SHALL render the
   shared `ErrorNotice` with a retry affordance and SHALL NOT crash or leave a
   spinner running.
5. THE System SHALL NOT issue a build-stats request for an unknown Champion_Key
   (Requirement 3.2 short-circuits first).

### Requirement 5: The build stats layout

**User Story:** As a visitor on the champion page, I want the champion's overall
performance and its two headline builds, side by side.

#### Acceptance Criteria

1. THE Champion_Page SHALL show a header with the champion square icon, display
   name, and — for the active filters — the champion's overall `winRate` and
   `pickRate` (`meta.overall`), each formatted as a percentage to one decimal
   place, with the total games behind them shown as a plain integer with a
   thousands separator.
2. Below the header THE Champion_Page SHALL show two Build panels, labelled
   "Most popular" (Popular_Build) and "Highest win rate" (Best_Build), side by
   side on wide viewports and stacked on narrow ones.
3. Each Build panel SHALL show, for that Build:
   1. `winRate` (percentage, one decimal) and `pickRate` (percentage, one
      decimal);
   2. `matchCount` — the exact number of games played on that build — as a plain
      integer with a thousands separator, labelled so it is unambiguous that it
      counts games on *this* build, not on the champion (e.g. "1,240 games");
   3. the Core_Items in order, rendered with `ItemIcon`/`ItemBuildRow`-style
      tiles and hover tooltips exactly as the match Build Path tab does;
   4. the Skill_Order, rendered by the same view `SkillOrderView` uses (ability
      tiles with max-order badges + the per-level grid);
   5. the Rune_Page, rendered by the same `RunePageCard` markup `RunesTab` uses;
   6. the two summoner spells for the build (`SummonerSpellIcon`).
4. WHEN Popular_Build and Best_Build are the same item path, THE Champion_Page
   SHALL still render both panels, and MAY show a note that the most popular build
   is also the highest-win-rate build.
5. Percentages and counts SHALL never render as `NaN`, `undefined`, `Infinity%`,
   or a URL containing an unresolved value — a missing field routes to the
   panel's own empty treatment (Requirement 7), never to a broken figure.

### Requirement 6: The filters

**User Story:** As a visitor, I want to narrow the build to my role, my rank, and
optionally my region.

#### Acceptance Criteria

1. THE Champion_Page SHALL render three filter controls: Role, Rank_Bucket,
   Region_Filter.
2. THE options for each control SHALL come from the response `meta`
   (`meta.availableRoles`, `meta.availableRanks`, `meta.availableRegions`) — the
   frontend SHALL NOT hard-code the option sets, so the backend can add a
   Rank_Bucket or a region without a frontend change.
3. A control SHALL be rendered as disabled (not hidden) when `meta` advertises
   only one option for it (e.g. `region` = `["world"]` in v1).
4. Changing any filter SHALL trigger a new fetch (Requirement 4.1) and update the
   URL query string (Requirement 3.3).
5. Filter defaults, applied when the URL does not specify a valid value:
   1. Role → `meta.defaultRole` (the champion's most-played role for the other
      two filters), falling back to `ALL`;
   2. Rank_Bucket → `meta.defaultRank`, falling back to `ALL`;
   3. Region_Filter → `world`.
6. THE Role control SHALL present role labels in the site's existing role
   vocabulary/icons, not the raw `teamPosition` strings.

### Requirement 7: Insufficient-data states

**User Story:** As a visitor looking at an off-meta champion or a thin rank
bracket, I want to be told the data isn't there rather than shown a misleading
1-game "build."

#### Acceptance Criteria

1. WHEN the response indicates Not_Enough_Data for the whole champion/filter
   combination (`meta.overall.totalGames` below `Display_Floor`, or the endpoint
   returns 200 with `popular: null`), THE Champion_Page SHALL render a single
   explicit "Not enough games recorded for these filters yet" message with a
   suggestion to widen the filters, and SHALL NOT render either Build panel.
2. WHEN Popular_Build exists but no Build reaches `Min_Sample` (Best_Build is
   `null`), THE Champion_Page SHALL render the Popular_Build panel and, in place
   of the Best_Build panel, an explicit "No build has reached 500 games at these
   filters yet" message — NOT the highest-win-rate build from a small sample.
3. WHEN a Build is missing an optional sub-section (no rune data met the modal
   threshold, say), THE panel SHALL render the sections it has and show a small
   "not enough data" line for the missing one, not hide the whole panel.
4. `Display_Floor` and `Min_Sample` SHALL be the only two thresholds the frontend
   applies; every other "is this enough" decision is the backend's, surfaced
   through `null` fields.

### Requirement 8: Data freshness and provenance

**User Story:** As a visitor, I want to know how current and how sound these
numbers are.

#### Acceptance Criteria

1. THE Champion_Page SHALL show the patch the aggregates cover (`meta.patch`) and
   when they were last updated (`meta.lastUpdatedAt`, rendered as a relative
   "updated N ago" like the profile Refresh label).
2. THE Champion_Page SHALL attribute the data as this site's own sample (not
   Riot), consistent with the `RiotDataPage` compliance copy.
3. THE page SHALL NOT expose any control to trigger a crawl or refresh — the
   aggregates update on the backend's own schedule only.

### Requirement 9: No regression to existing search

**User Story:** As a visitor who only ever searches Riot IDs, I want the search
box to work exactly as before.

#### Acceptance Criteria

1. WHEN the Search_Form value contains a `#`, THE System SHALL compute no
   Champion_Suggestions and the dropdown SHALL behave exactly as today.
2. Typing a full Riot ID and pressing Enter with no active row SHALL submit a
   lookup exactly as today, even if the `gameName` part matches a champion.
3. THE Champion_Suggestion computation SHALL add no network request and no
   measurable input latency (it is a bounded scan of ~170 names on each debounced
   query change, reusing the existing debounce).
4. WHEN the persistent store is disabled (no Player_Suggestions) BUT the static
   data index is `ready`, THE dropdown SHALL still offer Champion_Suggestions.

---

## Backend Requirements (draft — full spec: `champion-build-stats-pipeline`)

### Requirement 10: The build-stats endpoint

1. THE System SHALL expose `GET /api/champions/:championKey/build-stats` accepting
   optional `role`, `rank`, `region` query parameters.
2. THE endpoint SHALL be a pure read of pre-aggregated documents — no Riot API
   call, no rate-limit reservation, no lookup orchestration — so it is cheap
   enough to serve uncached and safe to cache at the edge.
3. WHEN `:championKey` is not a known champion, THE endpoint SHALL return 404.
4. WHEN a filter value is not one the aggregates support, THE endpoint SHALL
   clamp it to that filter's default rather than 400, and report the applied
   value in `filtersApplied`.
5. THE endpoint SHALL apply the same CORS allowlist and SPA-fallback exemption as
   every other `/api` route.

### Requirement 11: The response shape

1. THE Build_Stats_Response SHALL be:
   ```
   {
     champion:       { key, name },
     filtersApplied: { role, rank, region },
     meta: {
       patch, lastUpdatedAt,
       availableRoles: Role[], defaultRole: Role,
       availableRanks: RankBucket[], defaultRank: RankBucket,
       availableRegions: string[],
       overall: { winRate, pickRate, totalGames }
     },
     popular:        Build | null,
     highestWinRate: Build | null
   }
   ```
2. A `Build` SHALL be:
   ```
   {
     matchCount, winRate, pickRate,
     coreItems:   number[],          // item ids, purchase order, length ≤ Core_Item_Count
     startingItems: number[] | null,
     skillOrder:  { maxOrder: ('Q'|'W'|'E')[], perLevel: (1|2|3|4)[] } | null,
     runes:       RunePage | null,   // same shape the match RunesTab consumes
     summonerSpells: [number, number] | null
   }
   ```
3. `winRate` and `pickRate` SHALL be numbers in `[0, 1]`. `matchCount` and
   `totalGames` SHALL be non-negative integers.
4. `highestWinRate` SHALL be `null` unless at least one aggregated Build has
   `matchCount ≥ Min_Sample`.
5. `popular` SHALL be `null` when `meta.overall.totalGames` is below the backend's
   display floor.
6. `Build.skillOrder` / `Build.runes` / `Build.summonerSpells` SHALL be the modal
   value **within the cohort of games that used `coreItems`**, or `null` when no
   value clears the backend's modal threshold for that cohort.

### Requirement 12: The aggregate store

1. THE System SHALL persist per-`(championKey, role, rankBucket, region, patch)`
   aggregate documents holding item-path / skill-order / rune-page / spell
   frequency and win counters — **aggregates only, never raw matches** (storage
   budget: the M0 tier cannot hold the crawled match corpus).
2. Aggregates SHALL be built by an offline worker (seeder → crawler → extractor),
   specified separately, that shares the one `RateLimitManager` with the web
   process and is capped to a fixed fraction of the Riot rate budget so live
   lookups always take precedence.
3. WHEN the aggregate store is unavailable or empty, THE endpoint SHALL return
   200 with `popular` and `highestWinRate` `null` and empty `meta` option lists,
   so the frontend shows Not_Enough_Data rather than an error.

### Requirement 13: Shared constants

1. `Min_Sample` (500), `Core_Item_Count` (3), and the Role / Rank_Bucket
   vocabularies SHALL be defined once on the backend and mirrored by a frontend
   parity test, exactly as `MIN_QUERY_LENGTH` / `MAX_SUGGESTIONS` are today.

### Requirement 14: Rollout ordering

1. This feature SHALL be shippable frontend-first behind the endpoint: until the
   pipeline lands, the endpoint returns the empty-state response (12.3) and the
   Champion_Page renders Not_Enough_Data everywhere — the same cold-start
   behaviour `autofill-search` has.

---

## Out of scope (candidate follow-ups)

- Per-tier rank filtering finer than the coarse Rank_Bucket set.
- Real per-region data (v1 is `world` only until the crawler seeds by region).
- Matchup / counter data, item win-rate deltas, "situational" items, timing
  ("first item complete at").
- A champion tier list / meta overview page.
- The player's own history with the champion on the same page.
- Item/rune build data for ARAM, Arena, or other non-ranked queues.
