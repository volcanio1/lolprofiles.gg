# Design Document

## Overview

This feature is a thin read-only layer over a store that already exists. `specs/database/` builds `looked_up_players` and its `LookedUpPlayerStore.searchByNamePrefix(namePrefix, limit)` method, and covers that data under privacy deletion. This spec adds:

1. **One backend route** — `GET /api/players/suggest` — that calls `searchByNamePrefix` and projects the result to a PUUID-free shape.
2. **One frontend hook** — `usePlayerSuggestions` — that debounces the query, guards against stale responses, and returns the current suggestion list.
3. **Combobox behaviour on the existing `SearchForm`** — a listbox dropdown, keyboard navigation, and "select ⇒ fill ⇒ submit."

No new stored data, no Riot API call, no changes to the lookup pipeline. The whole feature degrades to "the dropdown never appears" whenever the store is disabled, empty, or erroring — which is also its cold-start state on day one.

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

## What this spec explicitly does not do

- **No `tagLine` disambiguation.** If two players share a `gameName` prefix, both rows show; the `tagLine` on each row distinguishes them visually. Matching on `tagLine` is out of scope (Requirement 2.5).
- **No fuzzy / typo-tolerant matching.** Anchored prefix only (Requirement 2.2).
- **No "recent searches" personalisation.** Ordering is global `lastLookedUpAt` desc — the site's popularity signal, not the individual visitor's history (which the backend does not track per-visitor).
- **No region filter or region chip in the dropdown.** `region` is in the response for a future iteration but not rendered as a control now.
- **No prefetch of the suggested player's report on hover.**

## Open Questions For The User

1. **Show `region` on each row?** op.gg shows a small region tag (e.g. "EUW"). The data is in the response; rendering it is a one-line addition. Include it in v1 or keep rows to just icon + name + tag?
2. **`Min_Query_Length` of 2.** Short enough to feel responsive, long enough that `rank_snapshots`-scale traffic won't fan every single keystroke into a query. Comfortable, or prefer 3?
3. **Ordering.** Global `lastLookedUpAt` desc means a heavily-searched pro will always top the list for their prefix. That is probably the desired behaviour for a scouting-adjacent tool, but confirm you don't want plain alphabetical.
4. **`Max_Suggestions` of 8** — reasonable for a dropdown under a search box; say if you want more or fewer.
