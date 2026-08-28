# Implementation Plan: autofill-search

## Overview

**This plan is blocked on `specs/database/`.** It needs `looked_up_players` being written on every successful lookup, `LookedUpPlayerStore.searchByNamePrefix`, and the store instance already threaded into `createApp`. Do not start until that spec's tasks 1–6 are done.

Everything here is a thin read layer plus combobox UI. No new stored data, no Riot call, no change to the lookup pipeline. The feature is invisible until the store has data, so every task is written to degrade to "no dropdown."

## Tasks

- [ ] 1. Backend: the suggestion endpoint
  - [ ] 1.1 Add `MIN_QUERY_LENGTH = 2` and `MAX_SUGGESTIONS = 8` plus `clampLimit` to a small module under `backend/src/api/` (e.g. `suggest.ts`)
  - [ ] 1.2 Add `GET /api/players/suggest` to `createApiRouter`, taking `lookedUpPlayerStore` as a new router collaborator
    - Trim `q`; return `[]` (200) when `q` is absent, `< MIN_QUERY_LENGTH`, or contains `#`
    - Clamp `limit` to `1..MAX_SUGGESTIONS`, default `MAX_SUGGESTIONS`
    - Call `searchByNamePrefix(q, limit)`; on rejection log via a new `logger.suggestFailed` and return `[]` (200)
    - Project each result to `{ gameName, tagLine, profileIconId, region }` — no `puuid`, no `lastLookedUpAt`
    - _Requirements: 1.1-1.9, 2.4, 6.1_
  - [ ] 1.3 Thread `lookedUpPlayerStore` from `createApp` into `createApiRouter` (the store already reaches `createApp` via `specs/database/` task 5.1/6.1)
  - [ ] 1.4 Endpoint tests against `InMemoryLookedUpPlayerStore`
    - Prefix match, case-insensitive, `lastLookedUpAt` desc ordering
    - `limit` clamping (0, negative, huge, non-numeric, absent)
    - `q` absent / too short / containing `#` ⇒ `[]` 200
    - Disabled (no-op) store ⇒ `[]` 200
    - Throwing store ⇒ `[]` 200, `suggestFailed` logged
    - Response rows never contain `puuid` or `lastLookedUpAt`
    - _Requirements: 7.1_

- [ ] 2. Frontend: data layer
  - [ ] 2.1 Add `PlayerSuggestion` to `frontend/src/api/types.ts`
  - [ ] 2.2 Add `fetchSuggestions(query, { baseUrl?, fetch?, signal? })` to `frontend/src/api/lookupClient.ts`
    - Mirror the endpoint guards client-side (trim, min length, no `#`) and short-circuit to `[]` with no request
    - Never reject; `[]` on non-200, parse failure, or abort
    - Mirror `MIN_QUERY_LENGTH` as a frontend constant with a test asserting it equals the documented value (same pattern as `domain/riotId.ts`)
    - _Requirements: 1.5, 3.7_
  - [ ] 2.3 `fetchSuggestions` tests: happy path, non-200 ⇒ `[]`, malformed body ⇒ `[]`, abort ⇒ `[]`, below-threshold ⇒ no fetch call
    - _Requirements: 7.1_

- [ ] 3. Frontend: the debounced hook
  - [ ] 3.1 `frontend/src/hooks/usePlayerSuggestions.ts`
    - 200 ms debounce timer, reset per `query` change; no timer set below `MIN_QUERY_LENGTH` and `suggestions` cleared immediately
    - `AbortController` per fetch, aborted on query change/unmount; plus a request-id guard so a raced-past-abort response is dropped
    - Returns `{ suggestions, clear }`
    - _Requirements: 3.2, 3.4_
  - [ ] 3.2 Hook tests (fake timers): one request per debounce interval across rapid typing; below-threshold ⇒ no request and empty list; stale response arriving after a newer query ⇒ ignored; `clear()` empties without a request
    - _Requirements: 7.2_

- [ ] 4. Frontend: combobox on SearchForm
  - [ ] 4.1 Wrap the input in `.search-combobox`; add `usePlayerSuggestions(currentGameNamePrefix)` where the prefix is the input value up to any `#`
  - [ ] 4.2 Render the `role="listbox"` dropdown when `focused && !dismissed && suggestions.length > 0`; each row is a `role="option"` with a stable id, profile icon via `<ProfileIcon>`, `gameName`, `#tagLine`
    - No dropdown when there are zero suggestions — no empty state
    - _Requirements: 3.1, 3.3, 3.5_
  - [ ] 4.3 ARIA: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`; `aria-selected` on the active option; no `aria-activedescendant` when closed/empty
    - _Requirements: 4.1, 4.6, 4.7_
  - [ ] 4.4 Keyboard: Arrow Up/Down move active index with wrap and `preventDefault`; Enter selects the active suggestion or else falls through to submit; Escape sets `dismissed` and visually closes without clearing the input; any other key clears `dismissed` and resets active index
    - _Requirements: 4.2, 4.3, 4.4_
  - [ ] 4.5 Pointer: `onMouseEnter` sets active index; `onMouseDown` (with `preventDefault`, not `onClick`) selects — so selection beats input blur
    - _Requirements: 4.5, 3.6_
  - [ ] 4.6 `select(s)`: set input to `gameName#tagLine`, `clear()`, `setDismissed(true)`, reset active index, then run the value through `validateRiotId` and call `onSubmit` on `ok`
    - _Requirements: 5.1-5.5_
  - [ ] 4.7 Close on blur (`dismissed`) and on Escape; reopen on the next keystroke if suggestions still match
    - _Requirements: 3.6_

- [ ] 5. Styling
  - [ ] 5.1 `frontend/src/styles.css`: `.search-combobox`, `.suggestion-list`, `.suggestion` / `.suggestion.active`, `.suggestion-name`, `.suggestion-tag` — black/gold tokens, gold accent for the active row, list flush to input width and below it
    - _Requirements: 3.1 (visual), design-system_

- [ ] 6. SearchForm component tests
  - [ ] 6.1 Dropdown appears only with focus + ≥2 chars + ≥1 result; disappears on blur, Escape, selection, and zero results
  - [ ] 6.2 Keyboard nav wraps; Enter-on-active selects; Enter-with-no-active submits typed value
  - [ ] 6.3 Selecting a suggestion fills `gameName#tagLine` and fires `onSubmit` with that exact payload — asserted equal to the payload produced by typing the same Riot ID
  - [ ] 6.4 A raced/stale suggestion response never renders for a prefix the input has moved past
  - [ ] 6.5 Endpoint error / empty ⇒ no dropdown, manual full-Riot-ID submit unaffected
  - _Requirements: 7.2, 7.3_

- [ ] 7. Documentation
  - [ ] 7.1 README API section: document `GET /api/players/suggest` (params, response shape, that it makes no Riot call and returns `[]` rather than erroring)
  - [ ] 7.2 README "Known gaps": note the suggest endpoint shares `/api/lookup`'s unauthenticated / no-per-IP-throttle gap but is far cheaper (one indexed query, no Riot call, no shared budget); note suggestions are limited to players already looked up on this site (cold start)
  - _Requirements: 6.5_

- [ ] 8. Verification
  - [ ] 8.1 `npm test` backend + frontend, green, no `MONGODB_URI`
  - [ ] 8.2 Manual with a real Atlas M0 URI: look up 3–4 players, then type a shared prefix and confirm the dropdown lists them most-recent-first with icons; arrow-key + Enter runs the lookup; Escape and click-away close it; a full `name#tag` typed by hand still submits normally
  - [ ] 8.3 Manual: unset `MONGODB_URI`, confirm the form behaves exactly as before (no dropdown, no console errors)

## Optional (skipped by default)

- [ ] * 9.1 Property test for `fetchSuggestions` guards: no query `< MIN_QUERY_LENGTH` or containing `#` ever produces a network call
- [ ] * 9.2 Render `region` as a small tag on each row (pending Open Question 1)
- [ ] * 9.3 Prefetch the suggested player's report on sustained hover
