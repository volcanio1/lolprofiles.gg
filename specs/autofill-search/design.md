# Design Document

## Overview

This feature is a thin read-only layer over a store that already exists. `specs/database/` builds `looked_up_players` and its `LookedUpPlayerStore.searchByNamePrefix(namePrefix, limit)` method, and covers that data under privacy deletion. This spec adds:

1. **One backend route** — `GET /api/players/suggest` — that calls `searchByNamePrefix` and projects the result to a PUUID-free shape.
2. **One frontend hook** — `usePlayerSuggestions` — that debounces the query, guards against stale responses, and returns the current suggestion list.
3. **Combobox behaviour on the existing `SearchForm`** — a listbox dropdown, keyboard navigation, and "select ⇒ fill ⇒ submit."

No new stored data, no Riot API call, no changes to the lookup pipeline. The whole feature degrades to "the dropdown never appears" whenever the store is disabled, empty, or erroring — which is also its cold-start state on day one.

**Addendum (2026-08-28):** a second capability — persisting the full `ProfileReport` so a dropdown selection renders instantly, plus an always-visible Refresh — is specified in Requirements 8–10 and designed in **[Cached full-report snapshots + manual refresh](#cached-full-report-snapshots--manual-refresh-requirements-810)** below. That part *does* add a stored collection (`profile_reports`) and a store; the rest of this overview describes the original dropdown-only scope.

## Dependency on `specs/database/`

This spec cannot be implemented until `specs/database/` lands. Specifically it needs:

- The `looked_up_players` collection being written on every successful lookup (`specs/database/` Requirement 3).
- `LookedUpPlayerStore.searchByNamePrefix` — defined in that spec's design.md, implemented there for both the in-memory fake and MongoDB, including the anchored, regex-escaped, case-insensitive prefix scan backed by the `{ gameNameLower, lastLookedUpAt: -1 }` index.
- The `LookedUpPlayerStore` instance already being constructed in the composition root and threaded into `createApp` (that spec passes it to `createApp` for the privacy route; this spec uses the same instance for the new route).

If `searchByNamePrefix` turns out not to exist yet when this work starts, adding it belongs in `specs/database/`, not here.

## Backend: the Suggestion Endpoint

Added to `createApiRouter` in `backend/src/api/index.ts`, alongside the existing `/api/lookup`, `/api/match/:matchId/build-path`, `/api/privacy/delete`, and `/api/static-data` routes. The router already receives collaborators by parameter; it gains `lookedUpPlayerStore`.

```typescript
// GET /api/players/suggest?q=<prefix>&limit=<n>

router.get('/api/players/suggest', async (req, res) => {
  const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  // Requirement 1.5 — a not-yet-useful query is an empty result, never a 400.
  if (raw.length < MIN_QUERY_LENGTH || raw.includes('#')) {
    return res.json([]);
  }

  const limit = clampLimit(req.query.limit);   // Requirement 1.6 → 1..8, default 8

  let players: LookedUpPlayer[];
  try {
    players = await lookedUpPlayerStore.searchByNamePrefix(raw, limit);
  } catch (err) {
    logger.suggestFailed(err);                 // Requirement 1.8
    return res.json([]);
  }

  // Requirements 1.3 / 1.4 — PUUID and lastLookedUpAt are dropped here.
  res.json(
    players.map((p) => ({
      gameName: p.gameName,
      tagLine: p.tagLine,
      profileIconId: p.profileIconId,
      region: p.region,
    })),
  );
});
```

Constants (module-level, mirrored by the frontend's own copy the way `domain/riotId.ts` mirrors the backend validator):

```typescript
export const MIN_QUERY_LENGTH = 2;
export const MAX_SUGGESTIONS = 8;
```

Notes tied to requirements:

- **Disabled store (1.7).** The no-op `LookedUpPlayerStore` returns `[]` from `searchByNamePrefix`, so the endpoint returns `[]` with no special-casing.
- **No budget, no rate limiter (6.1).** This route does not construct a `BudgetGate` or call the orchestrator. It is one indexed query.
- **History-fallback exemption (1.9).** `backend/src/app.ts`'s SPA fallback already excludes `req.path === '/api' || req.path.startsWith('/api/')`, so `/api/players/suggest` is covered with no change.
- **Response shape.** A bare JSON array, matching how the endpoint is consumed. No envelope.

### Response type (shared shape)

```typescript
// frontend/src/api/types.ts
export interface PlayerSuggestion {
  gameName: string;
  tagLine: string;
  profileIconId: number | null;
  region: string;
}
```

## Frontend

### `frontend/src/api/lookupClient.ts` — `fetchSuggestions`

A sibling of the existing `fetchBuildPath` / `lookupProfile`: never rejects, always settles, returns `PlayerSuggestion[]` (empty on any failure or non-200). Takes an `AbortSignal` so the hook can cancel an in-flight request when the query changes.

```typescript
export async function fetchSuggestions(
  query: string,
  options: { baseUrl?: string; fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<PlayerSuggestion[]>;
```

It applies the same client-side guards as the endpoint (trim, `MIN_QUERY_LENGTH`, no `#`) and returns `[]` without a request when they fail — so a below-threshold query costs nothing.

### `frontend/src/hooks/usePlayerSuggestions.ts`

```typescript
export function usePlayerSuggestions(query: string): {
  suggestions: PlayerSuggestion[];
  clear: () => void;
};
```

Responsibilities, each mapped to a requirement:

- **Debounce (3.2).** A 200 ms timer resets on every `query` change; the fetch fires only when it elapses. Below `MIN_QUERY_LENGTH`, the timer is not even set and `suggestions` is emptied immediately.
- **Stale-response rejection (3.4).** Each fetch runs under an `AbortController`; a new query aborts the previous request. A monotonically increasing request id is also captured in the closure and checked on resolution, so a response that races past the abort is still discarded.
- **`clear()`** empties the list without issuing a request — called on selection and on Escape.
- The hook owns no "open" state; whether the dropdown is *shown* is a render-time function of `suggestions.length > 0`, input focus, and a local `dismissed` flag (set by Escape/blur, cleared on the next keystroke) held in `SearchForm`.

### `frontend/src/components/SearchForm.tsx` changes

The form keeps its submit-time validation (unchanged — decision 1 in its existing docblock still holds) and gains combobox wiring around the input. New local state: `activeIndex` (which suggestion is highlighted, `-1` for none) and `dismissed`.

```
<div class="search-combobox">
  <input
    role="combobox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
    aria-autocomplete="list"
    onKeyDown={handleKeyDown}
    … existing props …
  />
  {open && (
    <ul role="listbox" id={listboxId} class="suggestion-list">
      {suggestions.map((s, i) => (
        <li
          role="option"
          id={optionId(i)}
          aria-selected={i === activeIndex}
          class={i === activeIndex ? 'suggestion active' : 'suggestion'}
          onMouseEnter={() => setActiveIndex(i)}
          onMouseDown={(e) => { e.preventDefault(); select(s); }}   // mousedown, not click:
        >                                                            // fires before input blur
          <ProfileIcon iconId={s.profileIconId} size={24} />
          <span class="suggestion-name">{s.gameName}</span>
          <span class="suggestion-tag">#{s.tagLine}</span>
        </li>
      ))}
    </ul>
  )}
</div>
```

`open` = input has focus AND `!dismissed` AND `suggestions.length > 0` (Requirements 3.1, 3.5, 4.7).

`handleKeyDown`:

| Key | Behaviour |
|---|---|
| `ArrowDown` / `ArrowUp` | `preventDefault`; move `activeIndex` with wrap (`-1` counts as "before first"). Requirement 4.2. |
| `Enter` | If `open && activeIndex >= 0`: `preventDefault`, `select(suggestions[activeIndex])`. Else: fall through to the form's normal submit. Requirement 4.3. |
| `Escape` | `preventDefault`, `setDismissed(true)`, `clear()` is *not* called (keep the list cached for a re-focus) — just visually closed. Requirement 4.4. |
| anything else | `setDismissed(false)`, `setActiveIndex(-1)`. |

`select(s)`:

1. `setRiotId(`${s.gameName}#${s.tagLine}`)` (Requirement 5.1).
2. `clear()` + `setDismissed(true)` + `setActiveIndex(-1)` (Requirement 5.5).
3. `onSubmit({ riotId: `${s.gameName}#${s.tagLine}` })` directly — bypassing `handleSubmit`'s re-validation is safe because the value is well-formed by construction, but calling the same validation is cheap and keeps one path; **the implementation runs it through `validateRiotId` anyway** and only dispatches on `ok`, so Requirement 5.3 holds even if a malformed row somehow arrived (Requirement 5.4 — identical downstream payload).

`onMouseDown` with `preventDefault` rather than `onClick`: a click on the list would first blur the input (closing `open` before the click lands). `mousedown` fires first and `preventDefault` keeps focus on the input through the selection.

### Styling

`frontend/src/styles.css` gains `.search-combobox` (position: relative wrapper), `.suggestion-list` (absolutely positioned, full input width, elevated), `.suggestion` / `.suggestion.active`, `.suggestion-name` / `.suggestion-tag`. Follows the existing black/gold token system ([[design-system]]) — the active row uses the gold accent already used for selection elsewhere, not a new colour. The list matches the input's width and sits flush below it.

## Cold start and degradation

| Situation | Result |
|---|---|
| Day one, `looked_up_players` empty | Every query returns `[]`, `open` is always false, the form is exactly as it is today. |
| `MONGODB_URI` unset (local dev) | Same — no-op store, `[]`, no dropdown, nothing logged. |
| Mongo unreachable at request time | Endpoint catches, logs once, returns `[]`. Dropdown silently absent. |
| Query `< 2` chars or contains `#` | No request issued (client guard), `[]` if one somehow reaches the endpoint. |
| Visitor types a full `name#tag` and ignores the dropdown | Normal submit path, unchanged. |

## Cached full-report snapshots + manual refresh (Requirements 8–10)

Added 2026-08-28. Architecturally this is a `specs/database/` concern — a new persistent collection and store — but the user directed it be co-located here because it is consumed only by a Suggestion_Selection. Treat the store additions below as an extension of that spec's storage layer, built in this feature's tasks.

### New collection: `profile_reports`

```typescript
// backend/src/db/collections.ts
export const PROFILE_REPORTS_COLLECTION = 'profile_reports';
```

```typescript
interface ProfileReportDoc {
  _id: string;                 // the player's PUUID — upsert keyed for free
  report: ProfileReport;       // stored exactly as POST /api/lookup returns it
  fetchedAt: Date;             // BSON Date at rest, epoch ms across the interface
}
```

One document per player. A `ProfileReport` with ~30 recent matches serialises to a few tens of KB — comfortably inside Mongo's 16 MB document cap, and `rank_snapshots` continues to hold the historical rank series separately.

`ensureIndexes` (`backend/src/db/client.ts`) gains:

```typescript
await db
  .collection(PROFILE_REPORTS_COLLECTION)
  .createIndexes([
    // Requirement 8.8: reclaim abandoned snapshots without application code.
    // 15 days === Snapshot_Max_Age, so a snapshot the endpoint would reject as
    // stale is usually already gone; the endpoint still checks age (9.4) because
    // the TTL monitor only runs about once a minute.
    { key: { fetchedAt: 1 }, name: 'ttl_fetchedAt', expireAfterSeconds: 15 * 24 * 60 * 60 },
  ]);
```

Reads are by `_id` only, so no other index is needed.

### `ProfileSnapshotStore`

New module `backend/src/db/profileSnapshotStore.ts`, same shape as the other two stores — pure interface, an in-memory implementation, a no-op for the disabled state, and a Mongo implementation.

```typescript
export interface StoredReport {
  report: ProfileReport;
  fetchedAt: number; // epoch ms
}

export interface ProfileSnapshotStore {
  /** Requirement 8.1/8.2. Upsert keyed by `puuid`. */
  save(puuid: string, report: ProfileReport, fetchedAt: number): Promise<void>;
  /** Requirement 9.3. The stored snapshot, or `null` when none exists. Age is the caller's to judge. */
  get(puuid: string): Promise<StoredReport | null>;
  /** Requirement 8.7. Removes `puuid`'s snapshot; resolves 1 if one existed, else 0. */
  deleteByPuuid(puuid: string): Promise<number>;
}
```

- `InMemoryProfileSnapshotStore` — a `Map<string, StoredReport>`; `save` is an upsert by construction.
- `createNoopProfileSnapshotStore()` — `save` no-ops, `get` returns `null`, `deleteByPuuid` returns 0. This is the `MONGODB_URI`-unset runtime state and the endpoint's cold start.
- `MongoProfileSnapshotStore` — `updateOne({ _id: puuid }, { $set: { report, fetchedAt: new Date(fetchedAt) } }, { upsert: true })`; `get` is `findOne({ _id: puuid })`; `deleteByPuuid` is `deleteOne`.

Threaded through the composition root (`backend/src/index.ts`) exactly like `rankHistoryStore` / `lookedUpPlayerStore`: constructed once from `databaseClient.enabled`, passed to `createLookupOrchestrator`, `createApp`, and on into `createApiRouter` and `createPrivacyDeleteHandler`.

### `LookedUpPlayerStore.findByRiotId`

The endpoint resolves a name to a PUUID with no Riot call, so `LookedUpPlayerStore` gains:

```typescript
/** Requirement 9.2. Exact, case-insensitive match on gameName + tagLine. `null` when unknown or the store is disabled. */
findByRiotId(gameName: string, tagLine: string): Promise<LookedUpPlayer | null>;
```

`remember` already writes `gameNameLower`; it also starts writing `tagLineLower = tagLine.toLowerCase()`. The Mongo implementation is `findOne({ gameNameLower, tagLineLower })` — the existing `gameNameLower_recency` index already narrows the `gameNameLower` equality to a handful of documents, so no new index is required. In-memory: a linear scan comparing both fields lowercased. The no-op store returns `null`.

(`profile_reports` is keyed by PUUID, not by name, so a rename between snapshots is handled for free: `findByRiotId` finds the current `looked_up_players` row — whose `puuid` is stable — and that PUUID keys the snapshot.)

### Orchestrator: the third side-effect write

`recordLookupSideEffects` (`backend/src/orchestrator/index.ts`) gains a third entry in its `Promise.allSettled`, guarded the same way as the other two:

```typescript
guard(() => this.profileSnapshotStore.save(report.puuid, report, observedAt)),
```

`LookupOrchestratorOptions` gains `profileSnapshotStore?: ProfileSnapshotStore`, defaulting to `createNoopProfileSnapshotStore()`. Requirement 8.4 holds structurally: this method is called only from the fresh-success branch of `runPipeline`, never from `buildFallbackReport`, and never when the report came from a snapshot (that path never enters the orchestrator — see the frontend flow below).

### Backend: the cached-report endpoint

```typescript
// GET /api/players/report?gameName=<g>&tagLine=<t>
router.get('/players/report', async (req, res) => {
  const gameName = typeof req.query.gameName === 'string' ? req.query.gameName.trim() : '';
  const tagLine = typeof req.query.tagLine === 'string' ? req.query.tagLine.trim() : '';
  if (gameName === '' || tagLine === '') {
    return res.json({ source: 'miss' });           // Requirement 9.6
  }

  try {
    const player = await lookedUpPlayerStore.findByRiotId(gameName, tagLine);
    if (player === null) {
      return res.json({ source: 'miss' });         // Requirement 9.2/9.4
    }
    const stored = await profileSnapshotStore.get(player.puuid);
    if (stored === null || now() - stored.fetchedAt >= SNAPSHOT_MAX_AGE_MS) {
      return res.json({ source: 'miss' });         // Requirement 9.4
    }
    return res.json({
      source: 'cache',
      report: stored.report,
      fetchedAt: new Date(stored.fetchedAt).toISOString(),
    });
  } catch (err) {
    logger.cachedReportFailed(err);                // Requirement 9.5
    return res.json({ source: 'miss' });
  }
});
```

```typescript
// module-level, mirrored by the frontend
export const SNAPSHOT_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;
export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
```

- No budget gate, no orchestrator, no Riot client — like `/api/players/suggest`.
- History-fallback exemption: covered by the existing `/api/` prefix check, no change (design.md's Suggestion-endpoint note applies verbatim).
- The `ApiLogger` / `LookupLogger` gains `cachedReportFailed` next to `suggestFailed`; default is one `console.warn`.

### Response type (shared shape)

```typescript
// frontend/src/api/types.ts
export type CachedReportResponse =
  | { source: 'cache'; report: ProfileReport; fetchedAt: string }
  | { source: 'miss' };
```

### Frontend flow

**`fetchCachedReport`** — a sibling of `fetchSuggestions` in `lookupClient.ts`: never rejects, always settles, returns `{ source: 'miss' }` on any non-200, parse failure, or abort.

```typescript
export async function fetchCachedReport(
  gameName: string,
  tagLine: string,
  options: { baseUrl?: string; fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<CachedReportResponse>;
```

**Signalling "this came from a suggestion".** The two entry points differ:

- On the search page (`/`), `SearchForm.select(s)` currently builds a URL and navigates. It now navigates to `reportPathFor(submission)` **plus `&src=suggest`**.
- On the prefilled form on `/profile`, `select(s)` calls `setSearchParams` — it adds `src=suggest` the same way.

`ProfileReportPage` reads `src`. When it is `suggest`:

1. Call `fetchCachedReport(gameName, tagLine)`.
2. `source: 'cache'` → seed the session with the stored report (new `useLookup` entry point `seedFromSnapshot(request, report, fetchedAt)` that sets `status: 'success'`, records `lastRequest` so Refresh works, and stores `fetchedAt`).
3. `source: 'miss'` → `start({ riotId })` exactly as a typed lookup.
4. Either way, strip `src` from the URL with a `replace` navigation, so a manual page reload of that URL re-runs live (Requirement 9.8 — only the act of selecting a suggestion is cache-first, not the resulting URL).

A typed submit (`handleResubmit` / the search page's plain `onSubmit`) never sets `src`, so it never touches `fetchCachedReport`.

**`useLookup` additions:**

- `seedFromSnapshot(request, report, fetchedAt)` — sets a success state without a network call; `lastRequest.current = request` so `refresh` has a target.
- `refresh()` — re-runs `run(lastRequest.current, 0)` (a fresh live lookup, retry budget reset). No-op while `loading` or while `now() - fetchedAt < REFRESH_COOLDOWN_MS`.
- State gains `fetchedAt: number | null` and `source: 'snapshot' | 'live' | null`. On a live success `fetchedAt` is set to `now()` (the moment the report landed — the honest anchor, since `POST /api/lookup` does not return the snapshot's write time); on a seeded success it is the snapshot's `fetchedAt`.
- Derived `refreshDisabled = loading || (fetchedAt !== null && now() - fetchedAt < REFRESH_COOLDOWN_MS)`, re-evaluated on a scheduler tick the same way the rate-limit cooldown already is (`useLookup` decision 3).

**`RefreshControl`** — a small new component rendered by `ProfileReportView` (or the page, above it): the freshness label ("Updated {relative}") + a button wired to `refresh`, `disabled={refreshDisabled}`. The existing `report.lastUpdated` / `partialDataWarning` block in `ProfileReportView.tsx` stays as-is — it describes the Requirement 11.3 stale-fallback case, which is orthogonal; the new label is about snapshot vs live freshness. (Open question 6 below: whether to merge the two.)

**Styling** — `styles.css` gains `.report-refresh` (the label + button row) and a disabled-button treatment, black/gold tokens, no new colour ([[design-system]]).

### Cold start and degradation (additions to the table above)

| Situation | Result |
|---|---|
| Day one / `MONGODB_URI` unset | `profile_reports` empty or store disabled ⇒ every `GET /api/players/report` is `source: "miss"` ⇒ every suggestion selection runs a live lookup. Refresh button still shows; its cooldown anchors on the live receipt time. |
| Snapshot older than 15 days | Endpoint returns `miss` (age check, and usually TTL-deleted already) ⇒ live lookup ⇒ fresh snapshot written. |
| Mongo unreachable at request time | Endpoint catches, logs once, `miss` ⇒ live lookup. |
| Player renamed since the snapshot | `findByRiotId` matches the current `looked_up_players` row; its stable PUUID keys the (still valid) snapshot. |
| Snapshot references an old patch's assets | Champion/item names are stable; a brand-new asset id 404s to `AssetPlaceholder` as everywhere else. Refresh re-fetches against the current `DDRAGON_VERSION`. |
| Refresh clicked, live lookup fails | Previous report stays on screen; the standard `ErrorNotice` shows; snapshot is not overwritten. |

## What this spec explicitly does not do

- **No `tagLine` disambiguation.** If two players share a `gameName` prefix, both rows show; the `tagLine` on each row distinguishes them visually. Matching on `tagLine` is out of scope (Requirement 2.5).
- **No fuzzy / typo-tolerant matching.** Anchored prefix only (Requirement 2.2).
- **No "recent searches" personalisation.** Ordering is global `lastLookedUpAt` desc — the site's popularity signal, not the individual visitor's history (which the backend does not track per-visitor).
- **No region filter or region chip in the dropdown.** `region` is in the response for a future iteration but not rendered as a control now.
- **No prefetch of the suggested player's report on hover.**
- **No snapshot for typed lookups.** A Riot ID typed by hand always runs a live lookup and never reads `profile_reports` (Requirement 9.8). The snapshot is still *written* after any successful lookup, typed or not — only the *read* is gated to suggestion selections.
- **The snapshot is the `ProfileReport` body only** — not the lazily-loaded per-match tab data (build path etc.), which keeps its own on-demand endpoints and caches.
- **No per-visitor snapshot history.** One document per player, newest wins; the historical rank series in `rank_snapshots` is the only time-series kept.
- **No "force bust every cache" refresh.** Refresh re-runs the pipeline, which may still serve sub-calls from the in-memory `CacheStore` within their per-endpoint TTLs. It overwrites the snapshot; it does not invalidate the request-level cache.

## Open Questions For The User

1. **Show `region` on each row?** op.gg shows a small region tag (e.g. "EUW"). The data is in the response; rendering it is a one-line addition. Include it in v1 or keep rows to just icon + name + tag?
2. **`Min_Query_Length` of 2.** Short enough to feel responsive, long enough that `rank_snapshots`-scale traffic won't fan every single keystroke into a query. Comfortable, or prefer 3?
3. **Ordering.** Global `lastLookedUpAt` desc means a heavily-searched pro will always top the list for their prefix. That is probably the desired behaviour for a scouting-adjacent tool, but confirm you don't want plain alphabetical.
4. **`Max_Suggestions` of 8** — reasonable for a dropdown under a search box; say if you want more or fewer.

### On the cached-report addendum (Requirements 8–10)

5. **`Snapshot_Max_Age` and the TTL both at 15 days.** Your instruction was "refresh on search if data > 15 days old". Setting the DB TTL to the same 15 days means a stale snapshot is usually already deleted, so the endpoint returns `miss` for one clean reason. Keeping them equal, or want the TTL longer (e.g. 30 days) so a "stale but present" state is observable for debugging?
6. **Two freshness lines.** `ProfileReportView` already renders "Last updated …" from `report.lastUpdated` (the Requirement 11.3 stale-fallback signal). The new Refresh label is a *different* fact (snapshot age vs. live). Keep both, or fold `report.lastUpdated` into the new Refresh label so there's only one "how old is this" line?
7. **`src=suggest` in the URL.** The plan strips it after the first render so a shared or reloaded link runs live. Alternative: leave it, making the cache-first behaviour part of the shareable URL. Strip (current plan) or keep?
8. **`Refresh_Cooldown` of 5 minutes**, anchored on when the data was last fetched (which also covers "just clicked Refresh", since a completed refresh resets the anchor to ~now). Comfortable, or a different window?
