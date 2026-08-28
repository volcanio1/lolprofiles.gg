# Requirements Document

## Introduction

The search form takes a Riot ID and nothing else. A visitor who half-remembers a name — knows the `gameName` but not the `tagLine`, or isn't sure of the spelling — has no way in. Every competing site (op.gg, dpm.lol) offers an as-you-type dropdown that suggests accounts and shows their profile icons, and this feature adds the same.

There is a hard constraint that shapes the entire design: **Riot's API has no name-search endpoint.** Account-V1 resolves a *complete* `gameName#tagLine` to a PUUID and does nothing partial. There is no "players whose name starts with `fak`" call to make. The only material an autocomplete can draw on is **this site's own record of players it has already looked up** — the `looked_up_players` collection introduced by `specs/database/`. That makes this feature strictly downstream of the database work: with no persistent store there is nothing to suggest, and the roadmap sequences it accordingly (DB first, then this).

The scope is deliberately small:

- **Suggestions come only from `looked_up_players`.** A name nobody has ever searched on this site does not appear. This is a cold-start limitation, not a bug — the store fills in as the site is used, exactly like the rank-history graph.
- **One new read-only endpoint, one query.** A single indexed prefix scan, no Riot API call, no new data fetched. The endpoint is cheap enough that it does not need the budget/rate-limit machinery `/api/lookup` carries.
- **The dropdown suggests; it does not replace validation.** Selecting a suggestion fills a known-good Riot ID and submits it through the existing lookup path. Typing a full Riot ID by hand and ignoring the dropdown works exactly as it does today.

## Addendum (2026-08-28): cached full-report snapshots + manual refresh

A second capability was folded into this spec after the initial draft, because it builds on the same `looked_up_players` record the dropdown does: **a player picked from the dropdown should render from storage instantly, with an explicit Refresh to pull live data.** This requires persisting the whole `ProfileReport` — not just the identity row `looked_up_players` already holds — so it is a larger change than the rest of this spec. It is scoped by three decisions the user made on 2026-08-28:

- **Full snapshot.** Every successful lookup stores its complete `ProfileReport`, one document per player, newest replacing any prior one (Requirement 8).
- **Suggestion selections only.** Typing a Riot ID by hand still runs a live lookup, unchanged. Only choosing a dropdown suggestion reads a snapshot, and only when it is younger than 15 days; otherwise it falls through to a live lookup (Requirement 9).
- **Always-visible Refresh.** Every profile view carries a Refresh button and an "updated N ago" label; Refresh re-runs the live lookup and overwrites the snapshot, and is disabled while a refresh is in flight and for 5 minutes after the data was last fetched (Requirement 10).

Like the rest of the feature, all of this degrades to "no snapshot, always live" whenever the persistent store is disabled or empty — which is also its cold-start state.

## Glossary

- **System**: The lolprofiles.gg web application (frontend and backend combined).
- **Riot_ID**: A `gameName` and `tagLine` separated by `#`.
- **Search_Form**: The existing `frontend/src/components/SearchForm.tsx` — a Riot ID text input and a submit button.
- **Looked_Up_Player**: A record in the `looked_up_players` collection (`specs/database/` Requirement 3): `{ puuid, gameName, tagLine, profileIconId, region, lastLookedUpAt }`.
- **LookedUpPlayerStore**: The storage-agnostic interface from `specs/database/` design.md, whose `searchByNamePrefix(namePrefix, limit)` method this feature consumes.
- **Suggestion**: One entry in the dropdown — a Looked_Up_Player projected to what the UI shows: `gameName`, `tagLine`, `profileIconId`, `region`. The PUUID is **not** included in the response.
- **Suggestion_Endpoint**: The new `GET /api/players/suggest` route.
- **Suggestion_Query**: The `gameName` prefix the visitor has typed, extracted from the Search_Form input up to (but not including) any `#`.
- **Suggestion_Dropdown**: The listbox rendered below the Search_Form input when there are Suggestions to show.
- **Min_Query_Length**: The shortest Suggestion_Query that triggers a request — 2 characters.
- **Max_Suggestions**: The most Suggestions returned or rendered — 8.
- **Debounce_Interval**: The idle time after the last keystroke before a request is issued — 200 ms.
- **Persistent_Store_Disabled**: The state (`specs/database/` Requirement 1.3/1.4) in which `MONGODB_URI` is unset or unreachable and every store method is a no-op returning empty results.
- **Profile_Report**: The `ProfileReport` object `POST /api/lookup` returns on success (`backend/src/orchestrator/index.ts`).
- **Report_Snapshot**: A stored copy of a player's most recent Profile_Report — `{ puuid, report, fetchedAt }`, one per player.
- **ProfileSnapshotStore**: The storage-agnostic interface owning Report_Snapshots, mirroring the `CacheStore` / `LookedUpPlayerStore` pattern (`save` / `get` / `deleteByPuuid`).
- **Snapshot_Max_Age**: 15 days. A Report_Snapshot at least this old is treated as absent.
- **Refresh_Cooldown**: 5 minutes. The Refresh_Control is disabled while the displayed data was fetched less than this ago.
- **Cached_Report_Endpoint**: The new `GET /api/players/report` route.
- **Suggestion_Selection**: Choosing a Suggestion from the Suggestion_Dropdown (Requirement 5), as opposed to typing a full Riot_ID by hand.
- **Refresh_Control**: The button on the profile report view that re-runs the live Lookup_Session for the displayed Riot_ID.

## Requirements

### Requirement 1: The Suggestion Endpoint

**User Story:** As the frontend, I want a single cheap endpoint that returns players matching a name prefix, so I can populate an autocomplete without any Riot API involvement.

#### Acceptance Criteria

1. THE System SHALL expose `GET /api/players/suggest` accepting a query-string parameter `q` (the Suggestion_Query) and an optional `limit`.
2. THE Suggestion_Endpoint SHALL answer by calling `LookedUpPlayerStore.searchByNamePrefix(q, limit)` and nothing else — no Riot API call, no Cache_Store access, no lookup orchestration.
3. THE Suggestion_Endpoint SHALL return a JSON array of Suggestions, each carrying exactly `gameName`, `tagLine`, `profileIconId` (number or null), and `region`, ordered most-recently-looked-up first, as the store returns them.
4. THE Suggestion_Endpoint SHALL NOT include `puuid` or `lastLookedUpAt` in any Suggestion.
5. WHEN `q` is absent, is shorter than Min_Query_Length after trimming, or contains a `#`, THE Suggestion_Endpoint SHALL return an empty array with HTTP 200, not a 400 — a too-short or not-yet-relevant query is a normal state of a field being typed into.
6. THE Suggestion_Endpoint SHALL clamp `limit` to the range 1..Max_Suggestions, defaulting to Max_Suggestions when it is absent or unparseable.
7. WHEN the Persistent_Store is in the Persistent_Store_Disabled state, THE Suggestion_Endpoint SHALL return an empty array with HTTP 200.
8. WHEN `searchByNamePrefix` rejects, THE Suggestion_Endpoint SHALL log the failure and return an empty array with HTTP 200, so a database problem degrades the autocomplete to "no suggestions" rather than surfacing an error in the Search_Form.
9. THE Suggestion_Endpoint SHALL apply the same CORS allowlist as every other `/api` route and SHALL be exempted, like `/health`, from the SPA history fallback.

### Requirement 2: Query Semantics

**User Story:** As a visitor, I want the suggestions to match what I've typed in the obvious way — a prefix of the name, ignoring case.

#### Acceptance Criteria

1. THE store's `searchByNamePrefix` SHALL match Looked_Up_Players whose `gameName`, lowercased, starts with the Suggestion_Query lowercased.
2. THE match SHALL be a prefix match anchored at the start of `gameName`, not a substring or fuzzy match.
3. THE Suggestion_Query SHALL be treated as a literal string: regex metacharacters in it SHALL NOT be interpreted (they are escaped before the store builds its query).
4. Results SHALL be ordered by `lastLookedUpAt` descending, so the players this site sees most often surface first, and capped at the clamped `limit`.
5. THE `tagLine` SHALL NOT participate in matching in this feature; a visitor who types `name#ta` gets suggestions for the `name` prefix only (the endpoint ignores everything from `#` onward, per Requirement 1.5).

### Requirement 3: The Dropdown

**User Story:** As a visitor typing a name, I want a list of matching players to appear under the field, each with its profile icon, updating as I type.

#### Acceptance Criteria

1. WHEN the Search_Form input has focus AND the Suggestion_Query is at least Min_Query_Length AND at least one Suggestion is available, THE System SHALL render the Suggestion_Dropdown directly below the input.
2. THE System SHALL issue a Suggestion_Endpoint request no more often than once per Debounce_Interval of typing, and SHALL NOT issue one while the Suggestion_Query is below Min_Query_Length.
3. Each Suggestion row SHALL show the player's profile icon, `gameName`, and `tagLine`, with the icon degrading to the shared `AssetPlaceholder` on a missing or failed image exactly as every other profile icon on the site does.
4. WHEN a newer request completes before an older one, OR the input changes while a request is in flight, THE System SHALL ignore the stale response so the dropdown never shows results for a prefix the visitor has moved past.
5. WHEN there are no Suggestions for the current Suggestion_Query, THE System SHALL render no dropdown at all — no empty-state box, no "no results" row.
6. THE Suggestion_Dropdown SHALL close when the input loses focus, when the visitor presses Escape, and after a Suggestion is selected.
7. THE Suggestion_Endpoint request failing or returning an error SHALL be silent to the visitor: the dropdown simply does not appear, and typing a full Riot ID and submitting still works.

### Requirement 4: Keyboard and Accessibility

**User Story:** As a keyboard or screen-reader user, I want the autocomplete to behave like a standard combobox.

#### Acceptance Criteria

1. THE Search_Form input SHALL be marked up as an ARIA combobox controlling the Suggestion_Dropdown listbox (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`), and each row SHALL be an `option` with a stable id.
2. THE Down and Up arrow keys SHALL move the active Suggestion through the list, wrapping at the ends, without moving the text cursor.
3. Enter SHALL select the active Suggestion when one is active; when none is active, Enter SHALL submit the form with whatever is typed, as today.
4. Escape SHALL close the dropdown without changing the input value.
5. Pointer hover SHALL set the active Suggestion, and a click SHALL select it.
6. THE active Suggestion SHALL be visually distinct and referenced by `aria-activedescendant` so assistive technology announces it.
7. WHEN the dropdown is closed or empty, `aria-expanded` SHALL be `false` and no `aria-activedescendant` SHALL be set.

### Requirement 5: Selecting a Suggestion

**User Story:** As a visitor, I want picking a suggestion to just run the search for that player.

#### Acceptance Criteria

1. WHEN a Suggestion is selected, THE System SHALL set the Search_Form input to `gameName#tagLine` for that Suggestion.
2. THE System SHALL then initiate a Lookup_Session for that exact Riot_ID through the existing submission path, without requiring a second keystroke or click.
3. THE selected Riot_ID SHALL pass the existing client-side Riot ID validation by construction (both parts present, within length limits, exactly one `#`); no Suggestion SHALL be able to populate a value the validator would reject.
4. A Lookup_Session initiated from a Suggestion SHALL be indistinguishable downstream from one initiated by typing — same request shape, same `POST /api/lookup` body.
5. THE Suggestion_Dropdown SHALL close on selection and SHALL NOT reopen for the now-complete Riot_ID (which contains a `#`, so no further Suggestion_Query is produced).

### Requirement 6: No New Data, No Riot Calls, No Compliance Surface

**User Story:** As the operator, I want this feature to add no Riot API load and no new category of stored or displayed data.

#### Acceptance Criteria

1. THE Suggestion_Endpoint SHALL make zero Riot API calls and SHALL NOT touch the Rate_Limit_Manager.
2. THE Suggestion_Endpoint and dropdown SHALL store no new data — they only read `looked_up_players`, which `specs/database/` already writes and already covers under `POST /api/privacy/delete`. (The cached-report capability in Requirements 8–10 DOES introduce one new collection, `profile_reports`; it is covered under `POST /api/privacy/delete` by Requirement 8.7 and adds zero Riot API load by Requirement 9.7.)
3. Profile icons in the dropdown SHALL be hot-linked from Data Dragon through the existing `ProfileIcon` / `CdnImage` components, never proxied or rehosted, keyed to the pinned `DDRAGON_VERSION`.
4. A player removed via `POST /api/privacy/delete` SHALL stop appearing in Suggestions immediately, because the deletion removes their `looked_up_players` row (no additional work in this spec).
5. THE Suggestion_Endpoint SHALL carry the same "unauthenticated, no per-IP throttle" caveat already documented for `/api/lookup` in the README's "Known gaps"; the README SHALL note that the suggest endpoint shares that gap but is far cheaper to serve (one indexed query, no Riot call, no shared budget).

### Requirement 7: Testing

**User Story:** As a maintainer, I want the endpoint and the dropdown behaviour covered without a live database.

#### Acceptance Criteria

1. THE Suggestion_Endpoint SHALL be tested against the `InMemoryLookedUpPlayerStore` fake: prefix matching, case-insensitivity, ordering, `limit` clamping, the `#`/too-short/absent `q` empty-array cases, the disabled-store empty-array case, and the throwing-store empty-array case.
2. THE dropdown SHALL have component tests covering: debounce (one request per interval), Min_Query_Length gating, stale-response rejection, keyboard navigation and selection, Escape/blur close, the no-results no-render rule, and combobox ARIA attributes.
3. Selecting a Suggestion SHALL be tested to produce the same submission payload as typing the equivalent Riot_ID.
4. THE existing backend and frontend suites SHALL remain green with no database configured.
5. THE ProfileSnapshotStore SHALL be tested against an in-memory fake: upsert-by-PUUID, age filtering at Snapshot_Max_Age, `deleteByPuuid`, and the disabled/throwing no-op behaviour.
6. THE Cached_Report_Endpoint SHALL be tested: the cache-hit response shape, `source: "miss"` on unknown name / no snapshot / stale snapshot / blank params, the disabled-store miss, and the throwing-store miss — all HTTP 200.
7. THE Requirement 8 side-effect write SHALL be tested to fire on a fresh successful lookup and NOT on the Requirement 11.3 stale-cache fallback nor on a Suggestion_Selection served from a snapshot.
8. THE frontend SHALL test: a Suggestion_Selection with a cache hit renders the report without calling `POST /api/lookup`; a miss falls through to the live lookup; a typed Riot_ID never calls the Cached_Report_Endpoint; and the Refresh_Control disables in flight and under Refresh_Cooldown and re-runs the lookup when activated.
9. `POST /api/privacy/delete` SHALL be tested to clear the ProfileSnapshotStore alongside the other two collections.

### Requirement 8: Persisting the full report snapshot

**User Story:** As the operator, I want every successful lookup's full report saved, so a later visit to that player can render instantly from storage.

#### Acceptance Criteria

1. WHEN a Lookup_Session completes through the fresh pipeline with `kind: 'success'`, THE System SHALL write a Report_Snapshot for that player's PUUID to the ProfileSnapshotStore as an unawaited side effect, alongside the existing rank-snapshot and looked-up-player writes (`recordLookupSideEffects`).
2. THE write SHALL be an upsert keyed by PUUID — one Report_Snapshot per player, the newest replacing any prior one.
3. THE Report_Snapshot SHALL store the Profile_Report exactly as returned to the client, plus `fetchedAt` (epoch ms from the injected clock).
4. THE write SHALL NOT occur on the Requirement 11.3 stale-cache fallback path, nor when a Lookup_Session was served from a Report_Snapshot (Requirement 9) — only a genuine fresh success writes.
5. A ProfileSnapshotStore failure (synchronous throw or rejected promise) SHALL be logged via the existing `logger.storeWriteFailed` seam and swallowed; it SHALL never delay or fail a Lookup_Session, and SHALL issue no Riot API call.
6. WHEN the Persistent_Store is in the Persistent_Store_Disabled state, the write SHALL be a silent no-op.
7. `POST /api/privacy/delete` SHALL clear a PUUID's Report_Snapshot, best-effort, alongside `rank_snapshots` and `looked_up_players`, with the same "a store failure cannot fail the request" guarantee (`specs/database/` Requirement 5.3) and the same `found`-folding (no per-collection count in the body).
8. THE stored Report_Snapshot SHALL carry a database-level TTL of Snapshot_Max_Age so abandoned snapshots are reclaimed without application code; the endpoint SHALL still verify age itself (Requirement 9.4) rather than depend on TTL-sweep timing.

### Requirement 9: Serving a cached report to a suggestion selection

**User Story:** As a visitor who picked a player from the dropdown, I want their profile to appear immediately from what the site already knows, without waiting on Riot.

#### Acceptance Criteria

1. THE System SHALL expose `GET /api/players/report` accepting `gameName` and `tagLine` query-string parameters.
2. THE Cached_Report_Endpoint SHALL resolve the PUUID by an exact, case-insensitive match of `gameName` + `tagLine` against `looked_up_players` (a new `LookedUpPlayerStore.findByRiotId`) — no Riot API call, no lookup orchestration, no Cache_Store access.
3. WHEN a PUUID resolves AND a Report_Snapshot exists for it AND `now - fetchedAt` is less than Snapshot_Max_Age, THE endpoint SHALL return `200` with `{ source: "cache", report, fetchedAt }`, where `report` is the stored Profile_Report and `fetchedAt` is an ISO timestamp.
4. WHEN no PUUID resolves, OR no Report_Snapshot exists, OR the snapshot is at least Snapshot_Max_Age old, THE endpoint SHALL return `200` with `{ source: "miss" }` — never a 404, never an error envelope.
5. WHEN the Persistent_Store is disabled, OR `findByRiotId` or the snapshot read rejects, THE endpoint SHALL log the failure and return `200 { source: "miss" }`.
6. WHEN `gameName` or `tagLine` is absent or blank after trimming, THE endpoint SHALL return `200 { source: "miss" }`.
7. THE Cached_Report_Endpoint SHALL make zero Riot API calls, SHALL NOT touch the Rate_Limit_Manager, SHALL apply the same CORS allowlist as every other `/api` route, and SHALL be exempt from the SPA history fallback exactly as `/api/players/suggest` is.
8. Only a Suggestion_Selection SHALL consult the Cached_Report_Endpoint. A Riot_ID typed and submitted by hand SHALL run the live Lookup_Session as it does today, never reading a Report_Snapshot.
9. WHEN a Suggestion_Selection yields `source: "cache"`, THE System SHALL render that Profile_Report without issuing `POST /api/lookup`.
10. WHEN a Suggestion_Selection yields `source: "miss"`, THE System SHALL fall through to the normal live Lookup_Session for that Riot_ID, with no visible difference from a typed lookup (same loading indicator, same error affordances).
11. A report shown from a snapshot SHALL be visually indistinguishable from a live one except for the freshness label and Refresh affordance (Requirement 10); every existing report section SHALL render from the stored data.
12. THE lazily-loaded per-match tabs (build path, and any future match-detail tab) SHALL continue to fetch on demand through their own endpoints; the Report_Snapshot covers only the Profile_Report body.

### Requirement 10: The Refresh control

**User Story:** As a visitor looking at a profile, I want to pull the latest data on demand and see how old what I'm looking at is.

#### Acceptance Criteria

1. THE profile report view SHALL always render a Refresh_Control and a freshness label, whether the report was served from a snapshot or from a live lookup.
2. THE freshness label SHALL show the age of the displayed data as a relative time (e.g. "Updated 3d ago"), derived from `fetchedAt` when the report came from a snapshot, or from the moment the live report was received in the current session otherwise.
3. WHEN the Refresh_Control is activated, THE System SHALL run a live Lookup_Session for the currently displayed Riot_ID through `POST /api/lookup` and replace the displayed report with the result; the overwrite of the Report_Snapshot happens as the normal Requirement 8 side effect of that lookup.
4. THE Refresh_Control SHALL be disabled while a refresh is in flight AND while the displayed data is less than Refresh_Cooldown old, and enabled otherwise.
5. A refresh that fails SHALL surface the same error affordance as any Lookup_Session failure and SHALL leave the previously displayed report in place until the visitor retries or navigates.
6. Activating the Refresh_Control SHALL NOT change the page URL.
