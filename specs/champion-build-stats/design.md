# Design Document

## Overview

Two layers, deliberately split so the frontend can ship first:

1. **Frontend** — champion rows in the existing search dropdown + a new
   `/champion/:championKey` page that renders one endpoint's response through
   components that already exist (`SkillOrderView`, `RunesTab`'s `RunePageCard`,
   `ItemBuildRow`, `SummonerSpellIcon`, `SEO`, `RiotDataPage`, `LoadingIndicator`,
   `ErrorNotice`).
2. **Backend** — one read-only endpoint over a new aggregate collection, fed by an
   offline crawler. The crawler/seeder/extractor/schema/storage are their own
   spec (`champion-build-stats-pipeline`); this document only fixes the wire
   contract the frontend codes against.

Everything degrades to a single "not enough data" state whenever the aggregates
are missing — the cold-start condition and the permanent condition for rare
champion/filter combinations.

---

## Frontend

### New / changed files

| File | Change |
|---|---|
| `frontend/src/domain/championSuggestions.ts` | **new** — pure: `matchChampions(query, index, limit)`, `MAX_CHAMPION_SUGGESTIONS`, `championPathFor(key, filters)`. Parity-tested against backend constants. |
| `frontend/src/hooks/usePlayerSuggestions.ts` | unchanged; champion matching is synchronous and lives in the component, not this hook. |
| `frontend/src/components/SearchForm.tsx` | render a "Champions" group above the "Players" group; extend the flat keyboard index across both; a champion row calls a new `onSelectChampion(key)` prop. |
| `frontend/src/pages/SearchPage.tsx` | pass `onSelectChampion={(key) => navigate(championPathFor(key))}`. |
| `frontend/src/pages/ChampionBuildPage.tsx` | **new** — reads `:championKey` + query-string filters, guards unknown keys against `StaticDataIndex`, calls the hook below, renders header + two Build panels + filter bar + freshness line, all inside `RiotDataPage` + `SEO`. |
| `frontend/src/hooks/useChampionBuildStats.ts` | **new** — `useChampionBuildStats(championKey, filters)`: debounce-free fetch of `/api/champions/:key/build-stats`, monotonic request-id guard (copy `useLookup`'s), `{ data, status, error, retry }`. |
| `frontend/src/components/ChampionBuildPanel.tsx` | **new** — one `Build` → stat row + `CoreItemsRow` + `SkillOrderView` + `RunePageCard` + spells; owns the per-section "not enough data" fallbacks (Req 7.3). |
| `frontend/src/components/ChampionStatsFilters.tsx` | **new** — three selects driven by `meta.available*`; disabled when a list has one entry; emits filter changes upward. |
| `frontend/src/api/types.ts` | **new** types `ChampionBuildStats`, `ChampionBuild`, `ChampionStatsMeta`; `readChampionBuildStats` narrower in `lookupClient.ts` (drop malformed → treated as empty-state, never throw past the hook). |
| `frontend/src/App.tsx` | add `<Route path="/champion/:championKey" element={<ChampionBuildPage />} />`. |
| `frontend/src/styles.css` | `.champion-build-*` classes; reuse existing tokens (black/gold, gold = win). |

### Component reuse notes

- **`SkillOrderView`** currently takes match-timeline-derived props. Factor its
  presentational core (ability tiles + grid) to accept
  `{ championKey, maxOrder, perLevel }` directly so both the match tab and this
  page feed it. No behaviour change to the match tab.
- **`RunePageCard`** in `RunesTab.tsx` is defined inline. Lift it to
  `frontend/src/components/RunePageCard.tsx`, unchanged, and import it in both
  places.
- **`CoreItemsRow`** — a thin wrapper over the same item tile + `Tooltip` the
  Build Path tab uses; ids resolved via `useStaticData().itemIconUrl`.

### Champion suggestion matching

Pure, synchronous, no network:

```ts
export function matchChampions(query: string, index: StaticDataIndex | null, limit = MAX_CHAMPION_SUGGESTIONS) {
  if (!index || query.includes('#')) return [];
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LENGTH) return [];
  return Object.entries(index.champions)
    .filter(([, e]) => e.name.toLowerCase().startsWith(q))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(([key, e]) => ({ key, name: e.name }));
}
```

`SearchForm` composes `[...champions, ...players]` into one array for
`activeIndex` / `aria-activedescendant` so `autofill-search` Requirement 4's
keyboard model needs no rethink — only the render splits into two groups and
`select(row)` branches on `row.kind`.

### Routing & filter state

- Path carries the Champion_Key only (`/champion/Jinx`) — no `#`, so none of the
  `SearchPage` query-encoding gymnastics apply.
- `role` / `rank` / `region` live in `useSearchParams`. A filter change is
  `setSearchParams(next, { replace: true })`; a new champion is a `navigate`
  push. Defaults come from `meta` after the first response, so the initial fetch
  goes out with whatever the URL says (or bare), and the controls populate from
  the response.

### States

`useChampionBuildStats` status → render:

| status | render |
|---|---|
| `loading` | `LoadingIndicator` |
| `error` | `ErrorNotice` + `retry()` |
| `ready`, `overall.totalGames < floor` or `popular == null` | single Not_Enough_Data notice, no panels |
| `ready`, `popular` set, `highestWinRate == null` | Popular panel + "no build ≥ 500 games" card |
| `ready`, both set | both panels |

---

## Backend contract (draft)

### Endpoint

`GET /api/champions/:championKey/build-stats?role=&rank=&region=`

- Added to `createApiRouter` alongside `/api/lookup`,
  `/api/match/:matchId/build-path`, `/api/players/suggest`, `/api/static-data`.
- New collaborator: `championStatsStore` (interface + in-memory fake + no-op +
  Mongo impl, mirroring `MatchStore` / `LookedUpPlayerStore`).
- 404 for an unknown key (validated against a backend champion-key set derived
  from Data Dragon `champion.json`, cached like `static-data`).
- Unknown filter value → clamp to default, echo in `filtersApplied` (Req 10.4).
- No `RateLimitManager`, no Riot client injected into this route.

### Response

See requirements Req 11. `Build.runes` is emitted in the exact
`MatchParticipant['runes']` shape the frontend already parses, so `RunePageCard`
needs no adapter.

### Store

- One document per `(championKey, role, rankBucket, region, patch)`.
- Fields: `games`, `wins`, and capped frequency maps — `itemPaths` (key =
  joined core item ids), `skillOrders`, `runePages`, `spellPairs`,
  `startingItems` — each entry `{ games, wins }`.
- The endpoint: load the doc(s) for the filters, pick `popular` = max `games`
  item path, `highestWinRate` = max `wins/games` among item paths with
  `games ≥ Min_Sample`, and for each resolve the modal skill order / rune page /
  spells **restricted to that item path's cohort** (so those sub-maps are nested
  under each `itemPaths` entry, not global).
- Aggregates-only. Estimated ~60–250 MB depending on rank/region granularity —
  fits M0; the raw match corpus (3–4 GB+) does not and is never stored.

### Pipeline (separate spec — `champion-build-stats-pipeline`)

- **Seeder**: League-V4 `/entries/{queue}/{tier}/{division}` + apex lists → PUUIDs
  tagged with a rank bucket, refreshed weekly.
- **Crawler**: match-ids → match detail + **timeline** (2 Riot calls/match).
  Long-running worker; runs in the web process (shared `RateLimitManager`) or
  behind a Redis-backed limiter; hard-capped to a fraction of the app rate
  budget.
- **Extractor**: from timeline `ITEM_PURCHASED/SOLD/UNDO` rebuild purchase order →
  first 3 completed items + boots = the item path; `SKILL_LEVEL_UP` → skill
  order; `perks` + `summoner{1,2}Id` from match detail; bucket by seed player's
  rank; `teamPosition` for role; `gameVersion` for patch.
- **Aggregator**: fold each participant observation into the store via `$inc`
  upserts, discard the match.
- v1 scope recommendation: all champions, 3 rank buckets (`EMERALD_PLUS`,
  `DIAMOND_PLUS`, `MASTER_PLUS`) + `ALL`, region `world` only. First full pass
  ~1–3 weeks on the current dev key; per-patch freshness needs a production key.

---

## Testing

- `championSuggestions.test.ts` — prefix/case/anchor/limit/ordering, `#` short-
  circuit, null index.
- `SearchForm.test.tsx` — champion group renders, combined keyboard traversal,
  champion row navigates without validation, player rows unchanged, no dropdown
  when empty.
- `ChampionBuildPage.test.tsx` — unknown key → not-found (no fetch); filters
  round-trip through the URL; stale-response guard; the five state rows above;
  `Min_Sample` gate on the Best_Build panel.
- `parity.test.ts` — `MIN_SAMPLE`, `CORE_ITEM_COUNT`, Role/RankBucket vocab vs
  backend.
- Backend: endpoint tests (404 unknown key, filter clamping, empty-store →
  200 empty-state, modal-within-cohort selection, `Min_Sample` gate).
