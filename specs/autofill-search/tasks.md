# Implementation Plan: autofill-search

## Overview

**This plan is blocked on `specs/database/`.** It needs `looked_up_players` being written on every successful lookup, `LookedUpPlayerStore.searchByNamePrefix`, and the store instance already threaded into `createApp`. Do not start until that spec's tasks 1–6 are done.

Tasks 1–8 (the dropdown) are a thin read layer plus combobox UI: no new stored data, no Riot call, no change to the lookup pipeline, and invisible until the store has data.

Tasks 9–14 (the 2026-08-28 addendum: cached full-report snapshots + Refresh, Requirements 8–10) DO add a `profile_reports` collection, a `ProfileSnapshotStore`, a `findByRiotId` store method, a third orchestrator side-effect write, and a `GET /api/players/report` route. Still degrades to "always live" with the store disabled or empty.

## Tasks

- [x] 1. Backend: the suggestion endpoint
  - [x] 1.1 `MIN_QUERY_LENGTH = 2`, `MAX_SUGGESTIONS = 8`, `clampLimit`, `isAnswerableQuery` in `backend/src/api/suggest.ts`
  - [x] 1.2 `GET /api/players/suggest` in `createApiRouter`; trims `q` → `[]` 200 when absent / `< MIN_QUERY_LENGTH` / contains `#` / repeated param; clamps `limit`; projects to `{ gameName, tagLine, profileIconId, region }`; store rejection → `logger.suggestFailed` + `[]` 200. New `ApiLogger.suggestFailed`; `deps.logger` is now `Partial<ApiLogger>` merged over `consoleApiLogger`.
    - _Requirements: 1.1-1.9, 2.4, 6.1_
  - [x] 1.3 No change needed — `createApp` already spreads `ApiDependencies` (incl. `lookedUpPlayerStore`) into `createApiRouter`, and the composition root already passes it, via `specs/database/`.
  - [x] 1.4 `backend/src/api/suggest.test.ts` — 30 tests: prefix/case-insensitive/recency ordering, anchored (no substring), null-icon passthrough, no `puuid`/`lastLookedUpAt` leak, limit clamping (0/neg/huge/NaN/fractional/absent), not-yet-useful queries (absent/blank/1-char/`#`/repeated) → `[]` 200, disabled no-op store → `[]` 200, throwing store → `[]` 200 + logged once, absent store → disabled behaviour, `clampLimit` unit table. Full backend suite green (577 pass), tsc + eslint clean.
    - _Requirements: 7.1_

- [x] 2. Frontend: data layer
  - [x] 2.1 `PlayerSuggestion` added to `frontend/src/api/types.ts`
  - [x] 2.2 `fetchSuggestions(query, { baseUrl?, fetch?, signal? })` + `readSuggestions` narrower in `lookupClient.ts`; guards mirrored via new pure module `frontend/src/domain/suggestions.ts` (`MIN_QUERY_LENGTH`, `MAX_SUGGESTIONS`, `isAnswerableSuggestionQuery`, `namePrefixOf`); below-threshold / `#` ⇒ `[]` with no request; `[]` on non-200 / parse failure / abort; caps at `MAX_SUGGESTIONS`. `parity.test.ts` extended to cross-check `MIN_QUERY_LENGTH`/`MAX_SUGGESTIONS` against `backend/src/api/suggest.ts`.
    - _Requirements: 1.5, 3.7_
  - [x] 2.3 Tests: `domain/suggestions.test.ts` (5) + `fetchSuggestions`/`readSuggestions` blocks in `lookupClient.test.ts` — trimmed+encoded request URL, signal passthrough, below-threshold/`#` ⇒ no fetch, non-200 ⇒ `[]`, malformed/non-array ⇒ `[]`, abort ⇒ `[]`, malformed-row dropping, cap. Full frontend suite green (407), tsc + eslint clean.
    - _Requirements: 7.1_

- [x] 3. Frontend: the debounced hook
  - [x] 3.1 `frontend/src/hooks/usePlayerSuggestions.ts` — `SUGGESTION_DEBOUNCE_MS = 200`, timer reset per `query` change via an injected `DebounceScheduler`; below `MIN_QUERY_LENGTH` or containing `#` ⇒ no timer, list emptied immediately, in-flight request aborted; `AbortController` per fetch aborted on query change / unmount / `clear()`; monotonic `requestId` guard drops a raced-past-abort response; returns `{ suggestions, clear }`; owns no "open" state. Injected `fetchSuggestions` / `schedule` memoised (useLookup decision-6 hazard noted).
    - _Requirements: 3.2, 3.4_
  - [x] 3.2 `usePlayerSuggestions.test.tsx` (7, manual scheduler + deferred fetcher): documented interval; one request per interval across rapid typing; no timer/list below threshold and on shrink-back; no query with `#`; stale response after a newer query ignored (+ old signal aborted); `clear()` empties with no request; unmount aborts.
    - _Requirements: 7.2_

- [x] 4. Frontend: combobox on SearchForm
  - [x] 4.1 Input wrapped in `.search-combobox`; `usePlayerSuggestions(namePrefixOf(riotId), suggestionOptions?)` — new optional `suggestionOptions` prop for test injection.
  - [x] 4.2 `role="listbox"` dropdown rendered only when `focused && !dismissed && suggestions.length > 0`; rows are `role="option"` with stable `${listboxId}-option-${i}` ids, `<ProfileIcon size={24}>`, `gameName`, `#tagLine`. No empty state.
    - _Requirements: 3.1, 3.3, 3.5_
  - [x] 4.3 `role="combobox"` + `aria-expanded` + `aria-controls` + `aria-autocomplete="list"` on the input; `aria-activedescendant` only when a row is active; `aria-selected` on the active option; active index clamped to `suggestions.length` so a shrunk list can't leave a stale descendant.
    - _Requirements: 4.1, 4.6, 4.7_
  - [x] 4.4 Keyboard: Arrow Down/Up wrap with `preventDefault`; Enter with an active row selects (`preventDefault`), Enter with none falls through to the form submit; Escape sets `dismissed` + clears active (preventDefault only while open); a keystroke (`onChange`) clears `dismissed` and resets active index.
    - _Requirements: 4.2, 4.3, 4.4_
  - [x] 4.5 `onMouseEnter` sets active index; `onMouseDown` + `preventDefault` (not `onClick`) selects, so selection beats blur.
    - _Requirements: 4.5, 3.6_
  - [x] 4.6 `select(s)` → set input to `gameName#tagLine`, `clear()`, `setDismissed(true)`, reset active, then shared `dispatch()` runs `validateRiotId` and calls `onSubmit` on `ok` (same path as a typed submit).
    - _Requirements: 5.1-5.5_
  - [x] 4.7 Closes on blur (`focused=false`) and Escape (`dismissed`); reopens on the next keystroke. Existing 16 SearchForm tests + full suite (414) green; tsc + eslint clean. Dedicated combobox tests are task 6.
    - _Requirements: 3.6_

- [x] 5. Styling
  - [x] 5.1 `frontend/src/styles.css`: `.search-combobox` (relative wrapper, `.field-input` → `width:100%`), `.suggestion-list` (absolute, flush to input width, `top: calc(100% + 4px)`, `z-index: 20`, `--surface` bg + `--line` border + drop shadow), `.suggestion` (flex row), `.suggestion--active` (`--surface-2` bg + inset 2px gold-tick — the existing selection cue, no new colour), `.suggestion-icon` / `.suggestion-name` (ellipsis) / `.suggestion-tag` (`--dim`). `vite build` clean. Not visually verified in a browser (no automation on Node 18) — covered by task 6 tests + task 8.2 manual.
    - _Requirements: 3.1 (visual), design-system_

- [x] 6. SearchForm component tests — 8 new tests in `SearchForm.test.tsx` (manual scheduler + controllable fetcher via the `suggestionOptions` prop):
  - [x] 6.1 appears only with focus + ≥2 chars + ≥1 result (`aria-expanded` asserted); closes on blur, Escape (+ re-opens on next keystroke), and selection; no dropdown for an empty response.
  - [x] 6.2 arrow keys wrap the active row; Enter-on-active selects + fills the input; Enter with no active row submits the typed value.
  - [x] 6.3 selecting a suggestion (`click` on the `option`) fires `onSubmit` with a payload `toEqual` the one produced by typing the same Riot ID.
  - [x] 6.4 a stale response resolving after the prefix moved on is never rendered; the fresh one is.
  - [x] 6.5 a failed/empty suggestion request is invisible and a subsequent typed full-Riot-ID submit is unaffected.
  - Full frontend suite green (422); tsc + eslint clean.
  - _Requirements: 7.2, 7.3_

- [x] 7. Documentation
  - [x] 7.1 README API section: new `### GET /api/players/suggest` — params, `limit` clamp, bare-array response, `puuid`/`lastLookedUpAt` omitted, always-200 (short/`#`/disabled/failing all → `[]`), no Riot call / no shared budget, cold-start note.
  - [x] 7.2 README "Known gaps": reworded the suggest bullet (endpoint now exists, not "forthcoming") — shares the unauthenticated posture but far cheaper and can only echo names already looked up here. Database table row for `looked_up_players` now links the endpoint.
  - _Requirements: 6.5_

- [x] 8. Verification
  - [x] 8.1 `npm run test:backend` (577 pass / 6 skip, no `MONGODB_URI`) + `npm run test:frontend` (422 pass) + both lints clean.
  - [x] 8.2 Live against the real Atlas M0 in `backend/.env` (rebuilt backend). 5 live lookups populated `looked_up_players`; `GET /api/players/suggest` verified over HTTP: prefix match, case-insensitivity (`q=hi` == `q=HI`), `#`/1-char → `[]` 200, `limit=1` caps to 1 row, response carries no `puuid`/`lastLookedUpAt`, region present. Recency ordering (`lastLookedUpAt` desc) confirmed by direct query (`^b` → `["broxãh","bwipö"]`, newest first) — couldn't get a 2+ char shared ASCII prefix over HTTP, and it's already covered by the in-memory + mongo-integration store tests. `POST /api/privacy/delete` exercised live to clean up the 5 test rows. **Frontend browser interaction (arrow-key/Enter/Escape/click-away/typed-fallthrough) NOT manually run** — no browser automation on Node 18; covered by the 8 `SearchForm.test.tsx` cases.
  - [x] 8.3 Restarted the backend with `MONGODB_URI=` forced empty: no "persistent store connected" line, `GET /api/players/suggest?q=…` → `[]` 200, nothing logged. Backend then restored to the rebuilt + Mongo-enabled state.

## Cached full-report snapshots + manual refresh (Requirements 8–10)

Depends on tasks 1–3 (the store threading) and, for task 12, on `specs/database/` being landed. Independent of the dropdown UI tasks 4–6.

- [x] 9. Backend: storage layer
  - [x] 9.1 `PROFILE_REPORTS_COLLECTION` + `PROFILE_REPORT_TTL_SECONDS` (15 d) in `collections.ts`; `ensureIndexes` (client.ts) provisions `{ fetchedAt: 1 }` `ttl_fetchedAt` with `expireAfterSeconds: PROFILE_REPORT_TTL_SECONDS`.
  - [x] 9.2 `backend/src/db/profileSnapshotStore.ts` — `ProfileSnapshotStore` (`save` / `get` / `deleteByPuuid`) + `StoredReport`, `InMemoryProfileSnapshotStore` (+`createInMemory…`), `createNoopProfileSnapshotStore`, `MongoProfileSnapshotStore` (`_id` = PUUID upsert, BSON `Date`, epoch ms at the boundary). `ProfileReport` is `import type`-only from `../orchestrator` — no runtime cycle.
    - _Requirements: 8.2, 8.3, 8.6, 9.3_
  - [x] 9.3 `findByRiotId(gameName, tagLine)` added to the interface + all four impls; `remember` now also writes `tagLineLower`; `LookedUpPlayerDoc` gains `tagLineLower`; Mongo impl `findOne({ gameNameLower, tagLineLower })`; shared `toLookedUpPlayer` mapper. Two `LookedUpPlayerStore` object-literal test doubles updated.
    - _Requirements: 9.2_
  - [x] 9.4 `profileSnapshotStore.test.ts` (5) + `findByRiotId` block in `lookedUpPlayerStore.test.ts` (4) + noop coverage. `get` returns the raw snapshot (age is the endpoint's to judge, per design).
    - _Requirements: 7.5_
  - [x] 9.5 `mongo.integration.test.ts` extended: `findByRiotId` exact/case-insensitive/null, `profile_reports` TTL-index assertion, snapshot-store upsert + `fetchedAt` round-trip + delete. **Verified green against a real `mongo:7` container** (9/9). Full backend suite 586 pass / 9 skip; tsc + eslint clean.

- [x] 10. Backend: wiring + the cached-report endpoint
  - [x] 10.1 `backend/src/api/cachedReport.ts` — `SNAPSHOT_MAX_AGE_MS` (= `PROFILE_REPORT_TTL_SECONDS * 1000`, single source), `REFRESH_COOLDOWN_MS = 5 min`, `CachedReportResponse` union; `ApiLogger.cachedReportFailed` + console impl.
  - [x] 10.2 `GET /api/players/report` in `createApiRouter`: trim params → blank ⇒ miss; `findByRiotId` null ⇒ miss; `get` null or `now - fetchedAt >= SNAPSHOT_MAX_AGE_MS` ⇒ miss; hit ⇒ `{ source:'cache', report, fetchedAt:<ISO> }`; any throw ⇒ `cachedReportFailed` + miss; always 200.
    - _Requirements: 9.1–9.7_
  - [x] 10.3 `profileSnapshotStore` threaded through `index.ts` (`databaseClient.enabled ? new MongoProfileSnapshotStore : noop`), `createLookupOrchestrator`, `createApp` (auto via `ApiDependencies`), `createApiRouter`, `createPrivacyDeleteHandler`.
  - [x] 10.4 `recordLookupSideEffects` gains `guard(() => profileSnapshotStore.save(report.puuid, report, observedAt))` in the `Promise.allSettled`; `LookupOrchestratorOptions.profileSnapshotStore?` → no-op default.
    - _Requirements: 8.1, 8.4, 8.5, 8.6_
  - [x] 10.5 `POST /api/privacy/delete`: `profileSnapshotStore.deleteByPuuid(puuid).catch(() => 0)` added to the `Promise.all`, folded into `found`.
    - _Requirements: 8.7_
  - [x] 10.6 `cachedReport.test.ts` (10): hit shape + ISO fetchedAt + case-insensitive resolve + exact age boundary (`-1` hit / `==` miss); miss on unknown name / no snapshot / blank params / disabled store / no stores; throwing store ⇒ miss + logged once, no detail leak.
    - _Requirements: 7.6_
  - [x] 10.7 Orchestrator tests (3 new): snapshot saved on fresh success (`fetchedAt` == clock, report deep-equal); NOT saved on the 11.3 stale fallback; a rejecting snapshot store is logged via `storeWriteFailed` and never fails the lookup.
    - _Requirements: 7.7_
  - [x] 10.8 Privacy-delete tests (2 new): snapshot cleared alongside the other collections (`found: true`); a snapshot-store `deleteByPuuid` rejection alone still yields 200 with no logged defect.
    - _Requirements: 7.9_
  - Full backend suite 601 pass / 9 skip; mongo integration 9/9 vs `mongo:7`; tsc + eslint clean. Backend rebuilt + restarted (job `b3m5e42mj`); `GET /api/players/report` live (returns `{source:"miss"}` with no snapshots yet).

- [x] 11. Frontend: data layer
  - [x] 11.1 `CachedReportResponse` union in `frontend/src/api/types.ts`; `frontend/src/domain/cachedReport.ts` mirrors `SNAPSHOT_MAX_AGE_MS` / `REFRESH_COOLDOWN_MS`; both sides pin the literals (`domain/cachedReport.test.ts` + a `cached-report constants` case in the backend `cachedReport.test.ts`).
  - [x] 11.2 `fetchCachedReport(gameName, tagLine, { baseUrl?, fetch?, signal? })` + `readCachedReport` narrower in `lookupClient.ts` — trims, blank part ⇒ `{ source: 'miss' }` with no request; `{ source: 'miss' }` on non-200 / malformed body / abort / report-shaped hole; a cache hit requires `source==='cache'` + string `fetchedAt` + `isProfileReport(report)`.
  - [x] 11.3 Tests in `lookupClient.test.ts`: request URL + hit parse, blank ⇒ no request, non-200/malformed/abort ⇒ miss, server-said-miss ⇒ miss, `readCachedReport` downgrade cases. Frontend suite 429 pass; tsc + eslint clean.

- [x] 12. Frontend: session + refresh
  - [x] 12.1 `useLookup` rewritten: `seedFromSnapshot(request, report, fetchedAt)` (success, no network, bumps `sequence` to invalidate any in-flight, sets `lastRequest`); `refresh()` runs `run(lastRequest, 0, 'refresh')` — no-op while `loading`/`refreshing`/within cooldown; state gains `fetchedAt: number|null`, `source: 'live'|'snapshot'|null`, `refreshing`, `refreshError`; `'refresh'` mode keeps the report on a failed refresh (decision 5); `refreshCooldownRemainingMs` folded into the existing cooldown scheduler effect; `refreshDisabled` derived.
    - _Requirements: 10.3, 10.4, 10.5_
  - [x] 12.2 `SearchForm` gains optional `onSelectSuggestion` prop (defaults to `onSubmit`); `dispatch(value, viaSuggestion)` routes a suggestion pick to it. `SearchPage` wires `onSelectSuggestion` → `navigate(reportPathFor(s, true))`; `reportPathFor` adds `&src=suggest`. `ProfileReportPage`'s prefilled form still uses `onSubmit` only (a resubmit is a fresh live lookup).
  - [x] 12.3 `ProfileReportPage`: `fromSuggestion = searchParams.get('src') === 'suggest'` read **fresh** (not an effect dep), so stripping `src` after the first render doesn't re-run the effect — only a changed `riotId` does. Effect calls `fetchCachedReport(gameName, tagLine)` → `cache` ⇒ `seedFromSnapshot`, `miss` ⇒ `start`, then strips `src` with a `replace` nav; a `cancelled` flag makes it StrictMode-safe. The prefilled `/profile` form also wires `onSelectSuggestion` (→ `?riotId=…&src=suggest`). `fetchCachedReport` injectable via a new prop.
    - **Fix (post-review):** the first cut used a `handledRiotId` ref to block the src-strip re-run; under React `StrictMode` its double-invoked effect skipped the retained run's dispatch entirely, leaving a blank page. Replaced with the fresh-read + `cancelled` pattern; `pages.test.tsx` gained a StrictMode regression case.
    - _Requirements: 9.8, 9.9, 9.10_
  - [x] 12.4 `RefreshControl` component (freshness label + `.btn-ghost` button) rendered by `ProfileReportPage` above `ProfileReportView`; label = `relativeAge(fetchedAt, now)` ("Updated 3d ago"), or "Updated just now" when `fetchedAt` is null; `disabled={refreshDisabled}`; `refreshError.message` shown as a `notice-warning` above the report. New `domain/format.ts` `relativeAge` helper.
    - **Loading states (post-review):** `LoadingIndicator` now also shows during the pre-dispatch window — `preparing = riotId && status === 'idle'` covers the mount tick and the `fetchCachedReport` round trip on a suggestion pick, so the page is never blank while it decides snapshot-vs-lookup (label "Loading profile…"). During a refresh, a `LoadingIndicator label="Refreshing…"` shows and the report is wrapped in `.report-refreshing` (opacity 0.5, `pointer-events: none`, `aria-busy`). 2 new `pages.test.tsx` cases.
    - _Requirements: 10.1, 10.2, 10.6_
  - [x] 12.5 `useLookup.test.tsx` (4 new): `seedFromSnapshot` → success, no fetch, `source: 'snapshot'`; `refresh` no-op under cooldown then re-runs + overwrites + `source: 'live'` after advancing past 5 min; failed refresh keeps report + sets `refreshError`; refresh no-op while `loading`.
    - _Requirements: 7.8_
  - [x] 12.6 `pages.test.tsx` (5 new): `src=suggest` + cache hit renders without `lookup`, `src` stripped from the URL; `src=suggest` + miss falls through to live `lookup`; no `src` ⇒ `fetchCachedReport` never called; Refresh disabled in-cooldown then enabled + re-runs `lookup` after advancing.
    - _Requirements: 7.8_
  - Frontend suite 445 pass (+16); tsc + eslint clean. Existing `useLookup` (17) / `SearchForm` (24) / `pages` (17) all still green after the `useLookup` refactor.

- [x] 13. Styling
  - [x] 13.1 `styles.css`: `.report-refresh` (baseline-aligned space-between row, wraps), `.report-refresh-age` (Chakra Petch caps in `--dim`, matching the other rail labels), compact `.report-refresh .btn-ghost`. Disabled state reuses the existing `.btn-ghost:disabled`. No new colour. `vite build` clean.

- [x] 14. Documentation + verification (cached-report)
  - [x] 14.1 README: new `### GET /api/players/report` section (params, `{ source: "cache" | "miss" }` union, always-200 miss cases, no Riot call, suggestion-only / `src=suggest` / Refresh notes); Database table gains the `profile_reports` row + `tagLineLower`; "fire-and-forget" paragraph now covers all three writes + the 15-day TTL; privacy-delete line updated.
  - [x] 14.2 Live against Atlas M0 (backend job `b3m5e42mj`): a lookup wrote the `profile_reports` snapshot; `GET /api/players/report` returned `{ source: "cache", report: <full ProfileReport>, fetchedAt: <ISO> }`, case-insensitive resolve worked, unknown/blank → `{ source: "miss" }`; a repeat lookup **overwrote** the snapshot (new `fetchedAt`); `POST /api/privacy/delete` cleared it (→ miss). Test rows removed. Frontend dropdown-click / 5-min Refresh grey-out / hand-typed-stays-live are covered by the `pages.test.tsx` + `useLookup.test.tsx` cases (no browser automation on Node 18).
  - [x] 14.3 Disabled-store behaviour covered by `cachedReport.test.ts` ("misses with a disabled store" / "no stores configured") and by task 8.3's clean `MONGODB_URI=`-empty startup (same no-op stores back the report route); the frontend then falls through to a live lookup via the `source: 'miss'` path (tested in 12.6).

## Optional (skipped by default)

- [ ] * 15.1 Property test for `fetchSuggestions` guards: no query `< MIN_QUERY_LENGTH` or containing `#` ever produces a network call
- [ ] * 15.2 Render `region` as a small tag on each row (pending Open Question 1)
- [ ] * 15.3 Prefetch the suggested player's report on sustained hover
- [ ] * 15.4 Property test: `now - fetchedAt >= SNAPSHOT_MAX_AGE_MS` is the exact hit/miss boundary for the cached-report endpoint
