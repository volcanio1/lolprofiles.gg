# Requirements Document

## Introduction

The search form takes a Riot ID and nothing else. A visitor who half-remembers a name — knows the `gameName` but not the `tagLine`, or isn't sure of the spelling — has no way in. Every competing site (op.gg, dpm.lol) offers an as-you-type dropdown that suggests accounts and shows their profile icons, and this feature adds the same.

There is a hard constraint that shapes the entire design: **Riot's API has no name-search endpoint.** Account-V1 resolves a *complete* `gameName#tagLine` to a PUUID and does nothing partial. There is no "players whose name starts with `fak`" call to make. The only material an autocomplete can draw on is **this site's own record of players it has already looked up** — the `looked_up_players` collection introduced by `specs/database/`. That makes this feature strictly downstream of the database work: with no persistent store there is nothing to suggest, and the roadmap sequences it accordingly (DB first, then this).

The scope is deliberately small:

- **Suggestions come only from `looked_up_players`.** A name nobody has ever searched on this site does not appear. This is a cold-start limitation, not a bug — the store fills in as the site is used, exactly like the rank-history graph.
- **One new read-only endpoint, one query.** A single indexed prefix scan, no Riot API call, no new data fetched. The endpoint is cheap enough that it does not need the budget/rate-limit machinery `/api/lookup` carries.
- **The dropdown suggests; it does not replace validation.** Selecting a suggestion fills a known-good Riot ID and submits it through the existing lookup path. Typing a full Riot ID by hand and ignoring the dropdown works exactly as it does today.

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
2. THE feature SHALL store no new data — it only reads `looked_up_players`, which `specs/database/` already writes and already covers under `POST /api/privacy/delete`.
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
