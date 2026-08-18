# Implementation Log — lolprofiles.gg

Running record of executed tasks, verification results, problems encountered, and the decisions taken to resolve them. Written for someone picking this up cold.

**Status at time of writing:** tasks 1 through 17 complete (through checkpoint 17). Next task is 18.1.
**Test totals:** 348 backend tests, 164 frontend tests, all passing. **All 20** correctness properties implemented.
**Health:** both workspaces typecheck clean and lint clean with zero warnings. The backend boots and serves real lookups, verified against the live Riot API. The frontend is built but **cannot yet reach the backend from a browser** — see Finding C.

---

## How this build was run

Execution followed `tasks.md` in dependency order, one task boundary at a time, with explicit approval between tasks. Bulk execution was never used.

Two conventions emerged and were applied consistently:

- **Implementation and its property tests were bundled per module.** Task lists mark property tests as optional (`*`) for faster MVP, but this build requires complete conformance, so each implementation task shipped together with its property tests. Leaving a module untested across a task boundary would have violated the "tests exercise the implementation" rule.
- **Every external dependency is injected.** Clock, sleep, HTTP transport, timeout scheduler, cache, rate limiter, and config are all constructor/factory parameters. No test touches the network, a real timer, or a real credential. `vi.useFakeTimers` is never used because time is injected instead.

---

## Environment note

The application lives at `c:\Users\Administrator\Documents\kiro` (backend + frontend npm workspaces). This is separate from the ABAP workspace referenced by the global shell rules; those rules do not apply to this project. The repo is **not under version control**, so stray-file auditing at each checkpoint was filesystem-based rather than via `git status`.

Live API testing credential: the user supplied `Doffy#Smile` as a Riot ID for manual verification. It has **not** been used — automated tests are mocked per the build prompt's prohibition on live Riot dependencies, and live verification also needs a real `RIOT_API_KEY` in the environment. Worth doing once the orchestrator exists (task 13).

---

## Task-by-task record

### Task 1.1 — Backend scaffold
**Result: PASS.** 5 tests.

Created the root npm workspace, `backend/` with Express + strict TypeScript (CommonJS) + Vitest + fast-check + eslint, an env-driven config module, a `/health` route, and `.gitkeep` placeholders for the eight component directories from design.md.

- **Question raised:** repo layout was unspecified. Asked; user chose a single repo with `backend/` and `frontend/` npm workspaces, plain npm, no Turborepo/Nx.
- **Design choice:** `config/index.ts` exports `loadConfig()` as a function rather than evaluating config at module scope, so importing it in tests doesn't require a globally-set `RIOT_API_KEY`. Fail-fast behavior is preserved in `index.ts`, which calls it before starting the server.
- Config tests include a leak-sanity check asserting a key value never appears in a thrown error.

### Task 1.2 — Frontend scaffold
**Result: PASS.** 2 tests.

React 18 + Vite + TypeScript + Vitest + React Testing Library, router with a SearchPage and ProfileReportPage (placeholder headings only), and `config.ts` holding the backend base URL.

- **Deliberate restraint:** SearchPage was left with *no input element*. Requirement 1.1 is satisfied entirely by task 16.1; adding an input here would have pre-empted a later task and created duplicate work to reconcile.
- **Deferred decision:** the profile route is static `/profile`, not `/profile/:riotId`. A path param would force an encoding scheme for the `#` in a Riot ID (a URL fragment delimiter) before the lookup flow exists. Deferred to 16.3.
- `vitest` runs with `globals: false` to match the backend's explicit-import test style, which required an explicit `afterEach(cleanup)` since Testing Library's auto-cleanup depends on globals.

### Tasks 2.1 / 2.2 — Riot ID Validator + Property 1
**Result: PASS.** 15 example tests + 1 property (100 runs). Cumulative 21.

Pure `validateRiotId` with typed error codes, per design.md's declared interface.

- **Gap in the spec:** the requirements don't state precedence when an input violates several rules at once. Chose and documented: `MISSING_HASH` → `MULTIPLE_HASH` → `EMPTY_PART` → `GAME_NAME_TOO_LONG` → `TAG_LINE_TOO_LONG`. Hash-count checks must come first because the value can't be split into a name/tag pair until exactly one separator is known to exist.
- Length checks operate on **trimmed** values, matching Property 1's wording.
- The property's oracle is written independently from the requirement text, not by calling the implementation's own helpers, and asserts coverage is non-degenerate (both accept and reject branches exercised).

### Tasks 3.1 / 3.2 — Region Router + Property 3
**Result: PASS.** 15 example tests + 1 property (100 runs × 3 assert blocks). Cumulative 37.

Closed region→platform mapping with `isValidRegion`, `isValidPlatform`, `platformsFor`, `resolvePlatform`.

- **Deliberate non-implementation:** `resolvePlatform` has no throwing path for an invalid region, because its parameter is typed `RegionalRoutingValue`. Design.md explicitly assigns Requirement 5.5's rejection to *callers* via `isValidRegion`, which happens in the API layer at 15.1.
- Region matching is **case-sensitive** by decision — the requirement lists lowercase values and Riot's routing values are lowercase. `'AMERICAS'` is rejected, asserted deliberately.
- `isValidRegion` uses `hasOwnProperty` so inherited names like `'toString'` are rejected.
- The property's expected mapping is transcribed in the test file rather than imported, so it compares the module against the specification instead of against itself.

### Task 4 — Checkpoint
**Result: PASS.** 37 backend + 2 frontend.

Grep-verified that `RIOT_API_KEY` appears only in the config module, its test, and `.env.example`; that `riotgames.com` and `X-Riot-Token` appear nowhere yet; and that the validator and region router contain **zero import statements** (pure by construction).

Smells surfaced (non-blocking): `frontend/src/config.ts` untested and unimported until 16.3; frontend jsdom setup costs ~12.5s for 2 tests; backend has no `typecheck` npm script.

### Tasks 5.1 / 5.2 / 5.3 — Cache Store + Properties 16, 17
**Result: PASS.** 16 example tests + 2 properties (300 runs each). Cumulative 55.

`CacheStore` interface, `CacheKey`/`CacheEntry` types, `TTL_BY_ENDPOINT`, `buildCacheKey`, `isStale`, and `InMemoryCacheStore` with an injected clock.

Three decisions that materially affect behavior:

- **Key encoding is length-prefixed, not delimiter-joined.** Each segment becomes `${s.length}:${s}` with param entries sorted by name. A naive `join(':')` would alias `{'a:b':'c'}` with `{'a':'b:c'}` — Property 16 asserts injectivity and would have caught it. The encoding is uniquely parseable, so it's injective regardless of what characters params contain.
- **Staleness boundary is inclusive**: non-stale while `elapsed <= ttlMs`, stale only once elapsed strictly exceeds it. Requirements 10.2/10.3 say entries are retained for "at least" the retention period, so staling exactly at `ttlMs` would retain slightly less than required.
- **`get` deliberately returns stale entries** rather than filtering them. Requirement 10.7 needs `cacheOrFetch` to distinguish "absent" from "present but stale" so a failed refresh doesn't overwrite a still-present entry — impossible if staleness were hidden behind `undefined`.

`deleteByPuuid` was **intentionally not declared** in this task. Task 5.4 owns it, and a silent no-op stub would have been a lying implementation.

### Tasks 5.4 / 5.5 — `deleteByPuuid` with PUUID scrubbing + Property 20
**Result: PASS.** 8 new example tests + 1 property (200 runs). Cumulative 64.

**Problem found:** design.md declared `deleteByPuuid(puuid): Promise<void>`, but Requirements 12.5/12.6 and task 15.2's `{ found, deletedAt }` response require reporting whether data existed. `void` can't convey that.

**Resolution (user decision):** change the signature to return a result. Implemented as `PuuidDeletionResult { found, removedEntryCount, scrubbedMatchDetailCount }`. Scrubbed match details count toward `found: true`, since PUUID-linked data for that subject did exist and was acted on. design.md's interface snippet was amended to match.

**Second problem found and resolved:** `account` entries are keyed by `{ gameName, tagLine }`, *not* by PUUID — but their cached response body contains the PUUID, making the entry precisely a Riot-ID→PUUID association. That is data-subject-identifying data, outside Requirement 12.4's aggregate/non-PII carve-out. Implemented generically: any non-`matchDetail` entry is removed when the PUUID appears in its key params **or anywhere in its cached value at any depth**, so this holds without hard-coding the account shape. Related edge case: a `matchDetail` whose *key params* contain the PUUID is removed rather than scrubbed, since a key cannot be redacted in place.

**Design decision:** scrubbing **mutates in place**. Values are stored by reference without cloning, so a scrubbed copy would leave the original PUUID-bearing object reachable from any other holder of that reference — it would not actually satisfy Requirement 12.5. The identifying-field redaction (`summonerName`, `summonerId`, `riotIdGameName`, etc.) applies only to objects that *directly held* the PUUID, so co-participants in the same match are never touched. Cycle-safe via a `seen` set. Documented in both the module and design.md.

Property 20 verifies PUUID absence **exhaustively** by serializing the entire store — encoded keys, structured keys, and full values including nested participant records — and asserting the string doesn't appear. It also asserts other players' entries are deep-equal to a pre-deletion snapshot, that scrubbed match details survive eviction, that `found` matches an independent oracle, and that a second call is a byte-identical no-op.

**design.md amendments:** three surgical edits — the interface return type, the prose describing the remove-vs-scrub split, and the Caching Strategy bullet that previously claimed match details are excluded from deletion.

### Tasks 6.1 / 6.2 — Rate Limit Manager + Property 7
**Result: PASS.** 26 example tests + 1 property (100 runs). Cumulative 91.

Centralized pre-flight reservation with `reserveSlot` and `recordResponseHeaders`, parsing Riot's multi-window `count:seconds` header pairs.

- **Window model: sliding windows over request timestamps**, one window per Riot-declared pair. This makes the required wait exactly computable as `timestamps[count - limit] + duration`. A fixed-window counter couldn't, because it doesn't know where Riot's bucket boundary sits. Timestamps are recorded *before* release, so a burst issued before any response lands cannot overshoot.
- **Reconciliation takes the max** of local and Riot-reported counts, never lowering local usage. Riot's counters can lag (our in-flight requests missing) and lead (another process on the same key), so max is the only direction-safe choice. Shortfalls are added as synthetic timestamps at the current time — conservative, since recent requests occupy the window longest.
- `reserveSlot` loops rather than sleeping once, carrying the remaining budget across iterations, because concurrent callers can consume the capacity it waited for. Total sleep never exceeds 30s; the >30s case throws with **zero** wait.
- **Scope boundary confirmed:** 429 `Retry-After` handling and the retry cap (Requirements 4.6–4.8) are *not* here. They react to a response Riot already rejected rather than being a pre-flight reservation, so they belong to the Riot API Client at 7.2. The module documents this.
- Both clock and sleep are injected. The property's fake sleep advances the fake clock and records durations, which is how wait bounds are asserted without real timers.

### Tasks 7.1–7.5 — Riot API Client + Properties 8, 6 + integration tests
**Result: PASS.** 38 example/integration tests + 2 properties (100 runs each). Cumulative 131.

The sole Riot boundary: all five endpoints, `X-Riot-Token` header, 10s timeout, pre-flight reservation, header reconciliation, bounded 429 retry, typed `RiotApiResult` mapping, and minimal DTOs.

**Three mapping decisions, because design.md's result union doesn't cover every case:**

- **Unmodeled statuses → `server_error` 502.** Unexpected 4xx (400, 415), a 3xx the transport surfaced, or a 2xx other than 200 all mean we received a response we cannot read as data. 502 is the honest reading and routes to the retriable path. `not_found` was rejected because it would assert something false about the player; `ok` was rejected because it would hand callers unvalidated data. **No new result variant was invented.**
- **A 200 with an unparseable body → also `server_error` 502.** Never `ok`, never throws.
- **`RateLimitExceededError` from `reserveSlot` → `{ kind: 'rate_limited' }`** with no `retryAfterSeconds`, since Riot never told us a retry time — we declined to send. Any *other* error from the manager propagates as a defect rather than being swallowed.

Only 429 is retried. 5xx, timeouts, and network errors return on first failure — asserted directly — because Requirement 9.3 gives the visitor a bounded *manual* retry instead, and auto-retrying would multiply volume against the very rate limits Requirement 4 protects.

**Property 6 was written to be non-vacuous:** it asserts the key genuinely *is* sent as `X-Riot-Token` on every request, then asserts it's absent from `JSON.stringify`, `String()`, `util.inspect` at full depth with hidden properties, an entry-wise dump, and any thrown error's message and stack — across all seven result variants, with generated keys containing regex- and JSON-special characters.

Six injection points: transport, key, rate limit manager, sleep, clock, timeout scheduler.

### Task 8 — Checkpoint
**Result: PASS.** 131 backend + 2 frontend.

Confirmed `process.env` is read in exactly one place (`config/index.ts`) and **zero** times in `riotApiClient`; `riotgames.com` and `X-Riot-Token` confined to the client and its tests; zero `console.` in `riotApiClient`, `rateLimit`, or `cache`, so the key has no path to a log sink.

**Security note raised for task 15:** `/api/lookup` and `/api/privacy/delete` will be network-exposed and unauthenticated. The spec doesn't require auth, but `/api/privacy/delete` accepts a PUUID and mutates cached data, so an unauthenticated caller could scrub arbitrary PUUIDs. Flagged to revisit at 15.2.

### Tasks 9.1–9.4 — Insight Engine stats + Properties 9, 10, 11
**Result: PASS.** 20 example tests + 3 properties (200/300/300 runs). Cumulative 154.

`computeStats` and its composed pure helpers.

- **Question raised before implementing:** Requirement 8.2 compares the player's average deaths against "the average deaths per match for their most-played role" without naming a population, while Requirement 8.4 explicitly says *the player's own* matches. Asked; user confirmed 8.2 uses the same population. Only the requesting player's history is fetched, so no other population is available anyway. Per-role aggregates were exposed for task 11.1 accordingly.
- **Two mappings deferred to the orchestrator (13.4):** `MatchDto` → `IncludedMatch` flattening (locating the requester's participant row by PUUID, classifying `queueId`) and the `rank` → `division` rename. This keeps the Insight Engine independent of Riot's wire schema.
- **`rankedByQueue` keys come from the input only** — no hardcoded Riot queue list, which would be a second source of truth that drifts when Riot adds a queue. An absent key means Unranked, applied through the exported `standingForQueue` accessor.
- **Alphabetical tiebreak uses UTF-16 code-unit order, not `localeCompare`** — locale-aware comparison depends on ICU data and ambient locale, making the ordering environment-dependent and not reproducibly testable.
- **Two spec gaps closed deterministically:** an empty match list yields `mostPlayedRole === 'Unknown'` (documented sentinel), and roles tied on both count *and* latest timestamp break by code-unit-smallest name — so shuffling the match array can never change the answer.
- Purity is structural: `stats.ts` **imports nothing at all**.

### Tasks 10.1–10.4 — Insight Engine fun facts + Properties 12, 13, 14
**Result: PASS.** 24 example tests + 3 properties (300 runs each). Cumulative 181.

**Two genuine spec problems found before implementing. Both escalated rather than guessed.**

**Problem 1 — timezone was unimplementable.** Requirement 7.1 specified four fixed *local-time* windows, but Riot supplies `gameStartTimestamp` as epoch-ms UTC and the Insight Engine is required to be pure — it cannot read a server timezone or the visitor's locale. "Local" was undefined.

**Resolution (user decision):** compute the windows in UTC. **requirements.md 7.1 amended** to state the window is determined by the start timestamp interpreted in UTC, keeping the same four boundaries and the tied-windows clause, with a note that this keeps derivation independent of server/client locale.

**Problem 2 — Requirement 7.3 was self-referential.** It required deriving "the player's average match duration *and* the average match duration across all matches in the Match_History_Window ... along with the difference between them." But the window *is* the player's matches, so both values are identical and the difference is always zero. No other-players' data is in scope.

**Resolution (user decision):** drop the comparison. **requirements.md 7.3 amended** to require deriving and displaying the player's average match duration in minutes, with no comparison term.

design.md needed no edits — grepped for `local-time`, `average match duration`, and `difference between`; zero matches, so nothing contradicted the amended text.

Implementation notes:

- UTC hour is **pure integer arithmetic**, `((floor(ms / 3_600_000) % 24) + 24) % 24`. No `Date` construction anywhere, so there is no locale/ICU path at all. The double modulo makes it total over negative epochs (`-1` ms → hour 23 → Evening) so the property oracle needs no carve-outs.
- **Equal-timestamp streak ordering pinned explicitly**: stable sort on `startTimestamp`, same-timestamp matches consumed in input order. Stated because equal timestamps *can* in principle change a run length (W L W vs W W L at one instant), so the rule is fixed rather than left implicit.
- **`limitedDataNotice` placement:** design.md's declared `computeFunFacts(matches): FunFact[]` signature was kept, with `isLimitedData(matches)` exported alongside it. Both are driven by the same `LIMITED_DATA_MATCH_THRESHOLD`, so the orchestrator populates `ProfileReport.limitedDataNotice` from one source of truth without signature drift.
- **"Champion loyalty" and "role preference" had no formula in the spec.** Requirement 7.4 names the categories without defining them. Chose share-of-window (`games / total` as a whole percent) for both, reusing `topChampionsOf` and `mostPlayedRoleOf` so they inherit Requirements 6.4's and 6.5's already-specified tie-break orders rather than introducing new ones. Documented as a presentation choice *within* the mandated categories.
- **Average duration is not a `FunFact`.** `FunFact['category']` is a closed four-value union and duration isn't one of them, so 7.3's value is exposed as `averageMatchDurationMinutesOf` for the report layer rather than smuggled into another category's prose. **This created a known gap — see Open Items.**
- Property tests assert numbers against the exported derivations, never by regex-parsing fun-fact prose.

### Tasks 11.1 / 11.2 — Insight Engine recommendations + Property 15
**Result: PASS.** 15 example tests + 1 property (400 runs). Cumulative 197.

**Genuine contradiction found and escalated.** Requirement 8.1 demanded "at least 1 and at most 5" recommendations, but Requirements 8.2/8.3/8.4 are each conditional and can all be false simultaneously — deaths at or below the role baseline, fewer than 2 champions, vision at or above the role median. Design.md's Property 15 asserted **both** the strict if-and-only-if triggers *and* the 1–5 count bound, so the property itself asserted a contradiction.

**Resolution (user decision):** allow zero, keep the triggers strictly if-and-only-if.
- **requirements.md 8.1 amended** to "at most 5 ... and SHALL display no recommendation whose triggering condition, as defined in Criteria 2, 3, and 4, is not met. Displaying zero improvement recommendations is a valid outcome when no triggering condition is met."
- **design.md Property 15 amended** — count clause changed from "between 1 and 5 inclusive" to "between 0 and 5 inclusive". The three iff clauses and the metric clause left byte-identical.

The alternative — inventing a neutral fallback recommendation — was rejected because it would require a fourth category absent from the spec, contradicting the instruction not to create recommendations unsupported by the specified rules.

Three consequences of the spec's literal wording, recorded rather than smoothed over:

- **A single-role player can never trigger the survivability recommendation.** With one role, the most-played-role match set *is* the whole window, so overall average deaths equals the role average exactly and the strict "exceeds" is false. This follows directly from the confirmed 8.2 baseline decision. No epsilon, no `>=`, no alternate baseline was invented. The property oracle encodes the same rule so the case is asserted, not mistaken for a bug.
- **An empty role sample is "no baseline", not a baseline of zero.** `roleAggregatesOf` returns 0 for an empty sample, and comparing against that would fire off a value no match produced (any positive death average "exceeds" 0). Both role-baseline triggers now require `gamesPlayed > 0`.
- **The cap of 5 is never binding** — three categories, at most one each, so length is 0–3. `MAX_RECOMMENDATIONS = 5` is still enforced by a `slice` so the bound lives in code rather than only in prose, but nothing is invented to approach it.

**Type narrowing:** design.md declared `category: 'survivability' | 'championSelection' | 'visionControl' | string`. The `| string` widens the type to plain `string` and erases every compile-time guarantee the literals provided. Since only three triggers can legitimately exist under the amended 8.1, the union was closed. The narrow type is assignable to the declared one, so consumers are unaffected.

Win rates are compared as the **rounded whole percents** produced by `topChampionsOf`, so "most-played" and "second-most-played" inherit Requirement 6.4's total order and the trigger is verifiable from displayed output. Threshold is strict: a gap of exactly 10 points does *not* fire, asserted at the boundary.

### Task 12 — Checkpoint
**Result: PASS.** 197 backend + 2 frontend.

Added two audits beyond the earlier checkpoints:

- **Insight Engine purity, grep-proven.** `stats.ts` has zero imports; `funFacts.ts` and `recommendations.ts` have exactly one each, both `./stats`. Zero *code* occurrences of `Date.now`, `new Date`, `process.env`, `fetch`, `console.`, `require(` across all three — the only hits are doc comments asserting their absence. No `../` import exists in any of the three, so there is no path to `cache/`, `rateLimit/`, `riotApiClient/`, or `config/`.
- **Spec-drift check.** All three amendments (5.4, 10.1, 11.1) verified against *current* spec text and against the code, quoting each. No drift.

Also confirmed no computation is duplicated between the three Insight Engine modules — the two downstream modules import shared derivations from `stats.ts` rather than re-deriving.

### Tasks 13.1–13.7 — Lookup Orchestrator + Properties 18, 19, 2, 5, 4
**Result: PASS.** 66 example tests + 6 property test cases covering the 5 remaining properties (300 runs each; Property 2 is split into a not-found case at 200 runs and a downstream-failure case at 300). Cumulative 269 backend tests, and with these the property inventory is complete at 20 of 20.

Three source files, because the orchestrator has three genuinely separable concerns:

- `orchestrator/cacheOrFetch.ts` — the generic cache-or-fetch helper (13.1), the single implementation of Requirements 10.5–10.8.
- `orchestrator/mapping.ts` — Riot wire schema to domain model. `MatchDto` → `IncludedMatch` and `LeagueEntryDto` → `LeagueEntry`, the two translations tasks 9.1 deliberately deferred here to keep the Insight Engine free of Riot's schema.
- `orchestrator/index.ts` — the `runLookup` pipeline (13.4).

`src/orchestrator/.gitkeep` was deleted now that the directory holds real files.

**Two design.md amendments, both additive, both forced by requirements the helper's caller has to meet.**

**Amendment A — `cacheOrFetch`'s declared return type.** design.md declared `{ value, fromCache } | { failed: true }`. A bare `{ failed: true }` cannot say *why* the fetch failed, and Requirement 9's error table maps six distinct Riot outcomes onto six distinct user-facing results — so with the declared shape, Requirements 9.2–9.9 are not implementable at all. Added `failure: RiotApiFailure` to the failure branch. Separately, Requirements 11.4/11.5 need to know *when* each component was obtained, which only this helper knows, so `retrievedAt: number` was added to the success branch. Both are supersets: the declared discriminants and fields are untouched, so anything written against the declared shape still type-checks. This is the same class of gap as task 5.4's `deleteByPuuid(): Promise<void>`.

The helper also takes the injected clock as a fifth parameter. Staleness is a function of the current time, and every module in this build injects its clock; design.md's interface snippets omit injected dependencies throughout (`CacheStore`, `RateLimitManager` and `RiotApiClient` all show none), so this follows the established convention rather than changing a contract.

**Amendment B — `ProfileReport.averageMatchDurationMinutes`.** This closes open item 1, which task 10.1 recorded: Requirement 7.3 requires the average match duration to be *displayed*, `FunFact['category']` is a closed union that excludes duration, and `ProfileReport` had no field for it, so `averageMatchDurationMinutesOf` was exported with no display target. Added to `ProfileReport` rather than `ProfileStats`, because `ProfileStats` is scoped to Requirement 6's statistics while duration belongs to Requirement 7's derived insights. tasks.md's requirement list for 16.4 was corrected to cite 7.3 (and 3.4, 7.1, 7.2, 7.5, 7.6, 11.3, which it also renders but did not list).

**The Requirement 2.7 / 11.3 tension, and what Property 2 actually asserts.** Read in isolation, 2.7 forbids displaying a report containing "partial or stale data" after a post-PUUID failure, while 11.3 requires displaying a report built from "the most recent available Cache_Store data" with a staleness indication when a required call fails or overruns. **design.md already adjudicates this** in its sequence-flow section — the orchestrator "does not synthesize a partial report: it either falls back to the most recent fully-cached report with a staleness indicator (Requirement 11.3), or if no prior cached report exists, returns an error result (Requirement 2.7 / 3.6)" — so no new amendment was needed and none was made. What 2.7 prohibits is *synthesis*: a report with missing components, or one that silently passes off stale data as fresh. The implementation honors both literally:

- the fallback runs only when the cache holds **every** required component (summoner, league, match-ids for the resolved PUUID), so the report is always complete;
- `partialDataWarning` is always `true` on that path, so it is never passed off as fresh;
- `lastUpdated` reports the **oldest** component, so the age shown is never flattering;
- when any component is missing there is no report at all, only an error — which is 2.7's outcome.

Property 2's test asserts exactly that disjunction against an independent oracle (a component is available if a prior session cached it *or* this session fetched it successfully), rather than asserting the weaker "never returns success". The reading is documented in the test's header comment. **This is an interpretation, not an amendment** — see open items for the suggestion to sharpen the property's wording.

Property 2's text also says "any ... Match-V5 call fails" halts the pipeline, which taken literally would contradict Property 5 and Requirement 3.3. It has to mean match-ids-by-puuid: design.md's error table lists the two Match-V5 rows separately ("individual match-by-id failure → exclude, continue" vs "match-ids-by-puuid failure → stop pipeline"). Documented in the test.

**Other decisions worth recording:**

- **The 15s budget is a race, not a poll.** Requirement 11.3 says to *stop waiting*, so the pipeline is raced against an injected budget timer. Polling elapsed time between phases could only notice an overrun after the current Riot call returned, and each of those is allowed 10s of its own (Requirement 2.6), so a poll could overshoot by a full call — 25s worst case against a 15s target. When the timer fires, an abort flag also stops the match-detail fan-out from issuing further requests, so abandoning the wait does not leave work hammering Riot in the background. The timer is disarmed in a `finally`, so no lookup leaves a pending timer holding the event loop open.
- **Error codes are chosen by cause, with one stage-specific override.** Requirements 9.4, 9.5, 9.8 and 9.9 each mandate a message for a specific *cause* regardless of endpoint, so the cause wins; Requirement 3.6 mandates a match-history-specific message, so the residual "Riot returned something we cannot read" case is `MATCH_HISTORY_UNAVAILABLE` at the match-ids stage and `RIOT_UNAVAILABLE` elsewhere. A **downstream 404 is never `PLAYER_NOT_FOUND`** — that code is reserved for the Account-V1 404 of Requirements 2.4/9.2, and reporting "player not found" for a player whose PUUID we just resolved would be false.
- **`retriable` is `true` for exactly the three rows design.md's error table marks retriable** (5xx, 429-after-cooldown, network error). It drives Requirement 9.3's bounded in-place retry affordance; a rejected credential and an absent resource do not become available by asking again, and a timeout gets its own distinct front-end state (task 16.5) rather than a retry button. Chosen to be spec-traceable rather than inventing an affordance the requirements do not grant.
- **The parallel trio reports its first failure in requirement order** (summoner, league, match-ids), so the outcome never depends on which promise settled first, but **every** auth failure among them is logged — Requirement 9.5's obligation is to log the occurrence, not the winner of a precedence contest.
- **Requirement 9.5's logger now exists**, closing open item 2 for the orchestrator's half. Deliberately a one-method interface (`authFailure`) rather than a logging facade, because a rejected key is the only failure the requirements oblige the backend to log. It cannot receive key material: the Riot API Client never returns the key and this module never reads it. The default implementation logs to `console.error` so the requirement holds out of the box; tests inject a recorder.
- **Queue classification is an allowlist over Riot's numeric queue ids**, verified against Riot's published `queues.json`: 420 → ranked solo/duo, 440 → ranked flex, and 400/430/480/490 → normal. The operational reading of "normal" is a non-ranked 5v5 queue on Summoner's Rift with standard role assignment, which is what makes a match comparable to the ranked ones — Requirements 6.5, 8.2 and 8.4 are all role-relative, so ARAM (450, Howling Abyss) and the rotating modes would corrupt them rather than add signal. Unrecognized ids are excluded, so a new queue fails **safe** rather than being silently analyzed as a standard game. This does not contradict stats.ts decision 3's refusal to hardcode a queue list: that decision concerns `rankedByQueue`'s key set, which Requirement 6.1 ties to Riot's data, whereas here the requirement itself fixes a closed set of three.
- **A match whose participant row is missing is excluded**, and this is reachable rather than merely defensive: `deleteByPuuid` redacts a requester's PUUID out of retained match details (Requirement 12.5), so after a deletion request their row is genuinely no longer locatable. Excluding the match is the intended consequence.
- **`lastUpdated` excludes match details from its minimum.** They are cached indefinitely (Requirement 10.4), so a months-old retrieval time for a months-old match says nothing about how current the profile is; including them would drag the reported freshness back to a date that misrepresents the report.
- **The fan-out is bounded in width and length.** Ten match details at a time: sequential could not fit the 15s budget, while all 100 at once would queue a burst inside the Rate Limit Manager that starves every other concurrent lookup sharing the same per-key window. The id list is re-truncated to 100 even though the client already passes a `count`, so a malformed or oversized cached list can never turn one lookup into thousands of Riot calls.

**Two test bugs found and fixed during the run**, both mine rather than the implementation's: a `matchDto` helper whose `??` default substituted a value for the very `undefined` the test was about, and a Property 4 coverage guard for Requirement 6.6's `N/A` win rate that was unreachable because a 0-0 record was a 1-in-40000 draw. The second is the more interesting one — the guard did its job by failing.

Post-task audit, matching the earlier checkpoints: `process.env`, `riotgames.com`, `X-Riot-Token` and `RIOT_API_KEY` have **zero** code occurrences anywhere in `orchestrator/`; `Date.now` and `setTimeout` appear only as `??` defaults at injection points, never inline in a logic path; and there is exactly one `console.` in the module, the documented Requirement 9.5 logger.

### Task 14 — Checkpoint
**Result: PASS.** 269 backend + 2 frontend. Both workspaces typecheck clean and lint clean with zero warnings.

Audits run, extending the earlier checkpoints to cover the module task 13 inserted between the Riot client and the Insight Engine:

- **Credential confinement holds.** `process.env` is read in exactly ONE place in the whole codebase (`config/index.ts`); every other occurrence is a doc comment asserting its own absence. `riotApiKey` appears only in the config module, its test, and a riotApiClient property-test fixture string. `riotgames.com` and `X-Riot-Token` remain confined to `riotApiClient` and its tests. **Zero occurrences of any of them anywhere in `orchestrator/`** — the orchestrator sits directly above the client and never sees a key.
- **The key still has no path to a log sink.** Exactly two `console.` call sites exist in the application: the startup port line in `index.ts`, and the Requirement 9.5 auth-failure logger in `orchestrator/index.ts`. Zero in `riotApiClient`, `rateLimit`, `cache`, `config`, `insight`, `validator`, `region`, `mapping` or `cacheOrFetch`. The one logger that does exist interpolates only a stage name (a closed union), a routing value, and a 401/403 status — nothing that can carry credential material.
- **Insight Engine purity survived the wiring.** `stats.ts` still has **zero** imports. `funFacts.ts` and `recommendations.ts` still have exactly one each, both `./stats`, and neither contains a `../` import, so there is still no path from the Insight Engine to `cache/`, `rateLimit/`, `riotApiClient/`, `config/` or the orchestrator. The dependency arrow points one way only.
- **Both new pure modules are pure by construction.** `orchestrator/mapping.ts` imports **types only**, so it compiles to zero runtime requires. `cacheOrFetch.ts`'s single runtime import is `isStale`, itself pure.
- **No duplicated computation.** TTLs are always read from `TTL_BY_ENDPOINT` — zero hardcoded durations (`3_600_000`, `600_000`, `60 * 60`, `10 * 60`) anywhere in the orchestrator. `isStale` has exactly one call site in the codebase. No routing value is hardcoded in the orchestrator; platforms come from the Region Router. No `Math.round`, win-rate or median arithmetic appears in the orchestrator — every derivation goes through the Insight Engine.
- **Property inventory is complete and correctly tagged.** All 20 properties are present, exactly once each, tagged `// Feature: lolprofiles-gg, Property N: <text>` with the text matching design.md's headings verbatim and the `**Validates:**` lines matching too. Every property test carries branch-coverage guards that fail if a generated branch was never exercised.
- **Spec-drift check: all 8 amendments verified against current spec text.** Including the two *removals* — `local-time` and `difference between them` have zero matches, confirming amendments 3 and 4 still hold. Amendments 7 and 8 were additionally verified against the code: design.md's declared `cacheOrFetch` signature and `ProfileReport` shape now match the implementation field for field.
- **No stray files.** The only remaining `.gitkeep` is `backend/src/api/.gitkeep`, correct because `api/` stays empty until task 15; `orchestrator/.gitkeep` was removed when the directory gained real files. Every source module has a colocated test file.

Smells carried forward (non-blocking): `backend/src/index.ts` (the bootstrap) has no test and will be exercised at 18.1; `frontend/src/config.ts`, `main.tsx` and both pages remain untested until task 16; `backend/dist/` exists from running the build as verification, and is gitignored.

### Tasks 15.1–15.4 — API layer + error-content and deletion tests
**Result: PASS.** 79 new tests. Cumulative 348 backend.

Four source files under `api/`, plus the app wiring:

- `api/errors.ts` — the client-facing error contract: `ErrorCode` → HTTP status, message, and the extra fields Requirements 9.2/9.3/9.8 attach. Pure, so Requirement 9's message content is asserted directly with no HTTP round trip.
- `api/lookup.ts` — `POST /api/lookup`, with `parseLookupRequest` factored out as a pure function so the validation rules are testable in isolation.
- `api/privacy.ts` — `POST /api/privacy/delete`.
- `api/index.ts` — router assembly, body parsing, and the terminal error handler.
- `app.ts` now takes its dependencies and mounts the router at `/api`; `src/api/.gitkeep` was deleted.

**The composition root had to land early.** `createApp` requires its dependencies — deliberately, because an app assembled without an orchestrator would still start and still serve `/health` while every lookup 404'd for no visible reason, and a compile error is a better failure mode than a runtime mystery. That made `index.ts` uncompilable until the real graph was built, so the backend half of task 18.1 was done here: one clock and one Rate Limit Manager shared across the whole graph (Riot enforces limits per key per routing value, so the pre-flight reservation is meaningless unless every call shares one instance), the global `fetch` as the transport, and the API key read exactly once and handed only to the Riot client. tasks.md's 18.1 has been annotated; the frontend-to-backend integration still belongs to it.

**Status code decisions, the one worth arguing being `AUTH_FAILURE` → 503, never 401/403.** Requirement 9.5 demands a generic "service unavailable" message with no credential detail, and forwarding Riot's 401/403 would tell any caller that the failure is an authentication problem *on our side* — operationally sensitive and useless to a visitor who cannot act on it. Its status is deliberately identical to `RIOT_UNAVAILABLE`'s, so an expired key is indistinguishable from a Riot outage from outside. The rest: 400 for input rejected before any Riot call, 404 for a genuinely missing player, 429 for rate limiting so ordinary client tooling honors it, 504 for our own budget expiring, 502 for a transport failure where no HTTP response arrived (distinct from 503's "reachable but unwell"), 503 for a Riot service that answered but could not serve us.

**Requirement 9.2 echoes the Riot ID; Requirement 5.5 does not echo the offending value.** 9.2 explicitly requires identifying the submitted gameName and tagLine, and by the time that error is reachable both have passed validation, so they are length-bounded and safe to reflect. An unsupported region or platform is arbitrary unvalidated input, and reflecting it buys the visitor nothing — listing the supported values instead is safer and more actionable.

**Requirements 5.4 and 5.5 split cleanly on `platform`, and only look contradictory.** A platform that exists in `REGION_TO_PLATFORMS` but under a different region is 5.4's case and is forwarded for the orchestrator to substitute; a platform absent from the mapping entirely is 5.5's case and is rejected here via `isValidPlatform`. That is exactly the division design.md describes when it says callers reject unsupported input "before this point".

**No third amendment was needed for Requirement 9.8's cooldown.** `LookupResult` does not carry Riot's `Retry-After`, but 9.8 asks only for a cooldown of "at least 5 seconds", and Riot's own `Retry-After` has already been honored twice *inside* the client's retry loop (Requirements 4.6/4.7) before a `RATE_LIMITED` result can reach this layer. So the flat 5s minimum is an additional visitor-facing guard rather than a substitute, and `LookupResult` was left alone.

Other decisions: `DEFAULT_REGION` was added to the Region Router rather than the API layer, so Requirement 1.6's default has one home alongside the region semantics it belongs to. A blank `region` or `platform` is treated as absent, because that is what an untouched form control sends. The body limit is 16 KB rather than Express's 100 KB default, since both routes read a handful of short strings and the endpoints are unauthenticated. Malformed JSON is converted into our own envelope, because Express's default handler answers with an HTML page and, outside production, the stack trace with it. Requirement 9.5's *logging* half is deliberately NOT repeated at this layer — the orchestrator already logs every 401/403 with more context, and logging again on the way out would double-count real incidents; this layer owns the other half, the generic message.

**`/api/privacy/delete` returns exactly `{ found, deletedAt }`.** `PuuidDeletionResult` also carries `removedEntryCount` and `scrubbedMatchDetailCount`, but design.md declares only the two fields and the counts would let an unauthenticated caller probe how much data we hold about a given player. A test asserts the response has exactly those two keys.

**A flaky test of my own making, found and fixed.** Running the full suite after adding the API tests, Property 5 failed on a coverage guard — then passed in isolation. Root cause: the branch-coverage guards I added in task 13 assert that a generated shape occurred at least once across 300 *randomly seeded* runs, which makes them probabilistic. Reaching 5 included matches needs a long array whose entries survive both exclusion filters, and some seeds never produce one.

Fixed structurally rather than by re-running or pinning a seed: every affected property now supplies `fc.assert`'s `examples`, which execute before random generation, chosen so each counter is incremented deterministically — 5-included plus a fetch failure plus a disallowed queue for Property 5, all six failure kinds crossed with both fallback branches for Property 2, an empty entry set and a 0-0 record for Property 4, one per endpoint sitting exactly on the inclusive staleness boundary for Property 18, and all four outcome shapes for Property 19. The 300 random runs are unchanged, so exploration is preserved; the guards are now guarantees. Verified with 8 consecutive full-suite runs, and by checking each guard against the examples that feed it.

Worth noting the guards did their job twice now: once catching Requirement 6.6's unreachable `N/A` case, and once catching their own unsoundness.

### Tasks 16.1–16.7 — Frontend
**Result: PASS.** 157 new frontend tests. Cumulative 159 frontend, 348 backend.

Modules, grouped by concern rather than by task, since several tasks share a file:

- `domain/riotId.ts`, `domain/regions.ts` — the validation rules and the region mapping, mirrored from the backend (see open item 15 for why, and what mitigates it).
- `api/types.ts`, `api/lookupClient.ts` — the wire contract and the only module that performs network I/O.
- `hooks/useLookup.ts` — the Lookup_Session: loading lifecycle, bounded retry, rate-limit cooldown.
- `compliance/advertisingPolicy.ts`, `compliance/RiotDataPage.tsx` — Requirements 12.1–12.3.
- `components/SearchForm.tsx`, `LoadingIndicator.tsx`, `ErrorNotice.tsx`, `ProfileReportView.tsx`.
- `pages/SearchPage.tsx`, `pages/ProfileReportPage.tsx` rewritten from placeholders.

**The deferred `#`-in-URL decision is resolved.** Task 1.2 left `/profile` without a `:riotId` parameter because a Riot ID contains the URL fragment delimiter. Resolved by passing it as a QUERY parameter through `URLSearchParams`, which percent-encodes `#` to `%23` and decodes it symmetrically — no custom encoding invented, the report URL is shareable, and both routes keep a purpose. A path parameter would have needed a hand-rolled substitution, i.e. a second encoding scheme to get wrong. Closes open item 5.

**Requirement 12.2 is enforced by inversion, not by convention.** A prohibition maintained by "remember not to add ads" fails the first time someone forgets. So `RiotDataPage` renders no advertising slot unless handed an approved agreement, and there is exactly ONE place in the codebase where an agreement can be introduced — `approvedAdvertisingAgreement`, committed as `undefined`. Adding advertising requires editing that file, which is reviewable. An agreement with a blank `authorizedScope` is treated as absent, since Requirement 12.3 permits advertising only "limited to the scope authorized"; a scopeless agreement authorizes nothing rather than everything.

**Other decisions worth recording:**

- **Validation runs on submit, not per keystroke.** Requirements 1.3–1.5 are phrased as reactions to a submission, and telling someone their Riot ID is malformed before they have typed the `#` is technically true and actively unhelpful. The message clears on the next edit so it never contradicts what is on screen.
- **The platform selector's default is an explicit "any platform in this region".** Requirement 1.6 fixes a default for the REGION only, and Requirement 5.4 has the backend substitute the region's first platform, so "any" describes real behavior rather than inventing one. Changing region resets an out-of-region platform (Requirement 5.3) instead of submitting a pair the backend would have to correct.
- **The client timeout is 20s, deliberately LONGER than the backend's 15s budget.** A client timeout at or below Requirement 11.2's budget would abort lookups the backend was about to complete, turning slow-but-working into broken.
- **The client never rejects.** Every failure — non-2xx, unparseable body, DNS failure, abort — becomes a typed outcome, which is what lets Requirement 9.7 hold in a single `finally`. Responses are narrowed rather than trusted, so an HTML error page from a proxy renders as a generic message instead of `undefined`.
- **The cooldown gate is a deadline compared against an injected clock, not a bare timer.** A timer alone would be the only thing between the visitor and a request Requirement 9.8 says must wait; `canRetry` is derived from the deadline, so the gate holds even if the timer fires early or never. A test asserts that invoking `retry()` directly during a cooldown dispatches nothing.
- **`AUTH_FAILURE` shares `RIOT_UNAVAILABLE`'s heading**, deliberately. A distinct heading would leak exactly what the backend withholds by answering 503 rather than 401. A test asserts the rendered markup contains none of `key`, `token`, `credential`, `401`, `403`.
- **The PUUID is never rendered**, asserted against the container markup — it is data-subject-identifying and the visitor has no use for it.
- **Stale responses cannot overwrite newer ones.** Each dispatch carries a sequence number, so a slow first lookup landing after a fast second one is discarded rather than showing the wrong player's report.

**A real bug caught by a hanging test.** The pages test suite hung instead of failing. Root cause: `useLookup` built its default `lookup` inline, so the function was a new reference every render, which made `start` unstable, which re-fired `ProfileReportPage`'s effect on every render, which set state — an unbounded synchronous render loop that would pin the browser's CPU and fire unbounded requests at the backend. It hung rather than failed precisely because the loop is synchronous: it starves the event loop, so no test timeout can fire.

Fixed by memoizing the defaults. `App.test.tsx` had passed throughout because its `/profile` render carries no `riotId`, so the effect returned before setting state — the loop needed a real lookup to trigger. Three regression assertions now guard referential stability directly, which fail loudly instead of hanging. Also added a `key` on the report page's `SearchForm` so its fields cannot disagree with the report beside them after a Back navigation.

**Bundle check.** `npm run build` emits a clean bundle: `RGAPI`, `X-Riot-Token`, `RIOT_API_KEY` and `riotgames` appear nowhere in `dist/`, confirming Requirement 4.2 in the shipped artifact and not only in the source.

### Task 17 — Checkpoint
**Result: PASS.** 348 backend + 164 frontend. Both workspaces typecheck clean and lint clean with zero warnings.

This checkpoint added a NEW automated guard rather than only auditing, because task 16 introduced the build's first real duplication.

**The mirroring risk is now guarded, not just documented.** `frontend/src/domain/{riotId,regions}.ts` duplicate rules the backend owns (open item 15). A one-off comparison confirmed the two copies agree exactly — same four regions, same platforms in the same order, same length limits (16/5), same error-code set, same `DEFAULT_REGION` — but a hand comparison protects nothing going forward. So `frontend/src/domain/parity.test.ts` now reads the backend's source as TEXT and asserts the values match.

Reading source text from a test is unusual, and the better option was rejected deliberately: importing across workspaces needs a shared package, which changes both build configurations for one constant table. The text comparison is honest about being a guard against someone editing one copy and forgetting the other. It skips gracefully if the backend sources are absent, since that is not evidence of drift, and a fifth test reports whether it actually ran so a silent skip stays visible.

**The guard was mutation-tested.** With the backend's `europe` platform list reordered from `['euw1','eun1',...]` to `['eun1','euw1',...]` — order only, not membership, because the first entry is the platform Requirement 5.4 falls back to — the guard failed with `expected [ 'eun1', 'euw1', 'tr1', 'ru' ] to deeply equal [ 'euw1', 'eun1', 'tr1', 'ru' ]`. The source was restored and re-verified. A guard that cannot fail is worse than no guard, so this was checked rather than assumed.

Audits, extending the earlier checkpoints across the new frontend surface:

- **Requirement 4.2 holds on both sides of the wire.** `RGAPI`, `X-Riot-Token`, `RIOT_API_KEY` and `riotgames` have **zero** occurrences in frontend source, and the built `dist/` bundle was separately scanned and found clean at task 16. On the backend, `process.env` is still read in exactly one place.
- **The workspace boundary is intact.** Zero `import` statements in the frontend reference backend code. The only textual references are doc comments explaining the mirroring, plus the parity guard's deliberate file reads.
- **Zero `console.*` in the entire frontend.** The backend still has exactly two, both documented: the startup line and Requirement 9.5's auth-failure logger.
- **All 20 correctness properties remain tagged**, verified by extracting the property numbers from the tags and confirming 1–20 with no gaps or duplicates.
- **Spec drift: all 8 amendments verified against current spec text**, including the two *removals* — `local-time` and `difference between them` still have zero matches.
- **No stray files.** No `.log`, `.tmp`, `.bak` or scratch files outside `node_modules`; `frontend/dist` removed after the bundle scan; and **zero `.gitkeep` placeholders remain**, since `api/` and `orchestrator/` both hold real files now.

Smells carried forward: `backend/src/index.ts` (the composition root) still has no test — it is exercised only by running the server, which the live verification did; `frontend/src/main.tsx` likewise. Both are single-statement bootstraps, and 18.1 is where they get integrated.

**Not passing silently over the obvious:** every layer is green and the backend is proven against real Riot data, but **Finding C means no browser has ever completed a lookup.** The suite cannot catch that — frontend tests inject `fetch`, supertest ignores CORS — so a green checkpoint is not evidence the product works end to end. That is task 18.1's job and it is the one thing between this build and a usable application.

---

## Live verification against the real Riot API (after task 15)

The user supplied a Riot development key and confirmed `Doffy#Smile` is a **EUW** account. The backend was built and run on port 3011 with the key passed through the process environment — never written to a file. The key was exposed in the chat transcript, so it must be rotated.

**Note for whoever repeats this:** `npm run dev` does NOT work — `ts-node` is referenced by the script but is not a dependency, and nothing loads `.env` (there is no `dotenv`). Use `npm run build` then `node dist/index.js` with `RIOT_API_KEY` set in the environment.

### What worked

A full lookup on `europe` returned HTTP 200 with a complete report: summoner level 496, most-played role BOTTOM, overall KDA 3.07, average match duration 30.38 minutes, 28 included matches, four fun facts (one per category), and zero recommendations. Several things were confirmed on real data rather than fixtures:

- **`stats.ts` decision 3 was right to refuse a hardcoded queue list.** The live response contained `RANKED_PREMADE_5x5` alongside `RANKED_SOLO_5x5` and `RANKED_FLEX_SR`. A hardcoded list of "known" queue types would almost certainly have dropped it.
- **Requirement 6.4's total order holds on real data.** Champions came back 6, 3, 3, 3, 2 games, with the three-way tie broken by win rate (Caitlyn 67% first) and then alphabetically (Samira before Twitch).
- **Requirement 7.3's field is populated**, closing the loop on open item 1.
- **Requirement 11.4's "oldest component" rule works.** A lookup that hit the cache reported an earlier `retrievedAt` rather than "now", and after a deletion — which evicted everything refreshable — the next lookup correctly reported `lastUpdated: null`, i.e. Requirement 11.5's first-retrieval state.
- **Requirement 3.5's queue filter does real work**: 28 matches survived from up to 100 requested.
- **Requirement 4.2 / Property 6 confirmed live**: the key appears in no response body across success, not-found and validation responses.
- **Requirement 11.1 is plausible**: a fully cached lookup returned in 75 ms against the 2 s target. Not a p95 measurement, so no performance claim is made.
- **League-V4 `entries/by-puuid` exists and returns 200.** Worth recording because it was a plausible failure point — the endpoint is a relatively recent addition, and the older API only offered `by-summoner`.
- Requirements 9.1, 9.2, 5.5, 12.5 and 12.6 all behaved exactly as their unit tests claim, including the 404 echoing the submitted Riot ID and the idempotent second deletion returning `found: false` with a 200.

### Finding A — a correct Riot ID on the wrong region reports "Riot's services are temporarily unavailable"

This is what the first several attempts hit, before the account's region was known. On `americas`, Account-V1 resolves the PUUID successfully (Riot accounts are global), and then **Summoner-V4 returns 404 "summoner not found"** because the player has no summoner on that platform. Probed directly, `na1`, `br1` and `la1` all 404 identically.

The pipeline handles this exactly as designed — a downstream 404 becomes `RIOT_UNAVAILABLE` with `retriable: false` per the orchestrator's decision 3, because `PLAYER_NOT_FOUND` is reserved for the Account-V1 404 of Requirement 9.2. But the resulting message is actively misleading: nothing is unavailable, and the visitor's input was correct. They simply picked the wrong region.

**Requirement 9's error taxonomy has no code for "this player exists, but not on the region you selected"**, which is probably the single most common real failure a region selector produces. Not fixed, because inventing a code and a message is a requirements-and-design amendment, and the visitor-facing wording is the user's call. Options, for a decision:

1. Leave it. Cheapest, and the frontend's region selector reduces how often it happens.
2. Add an error code (e.g. `PLAYER_NOT_ON_PLATFORM`) mapped from a Summoner-V4 404 specifically, with a message naming the selected region and suggesting others. Needs a new acceptance criterion under Requirement 9 and a design.md error-table row.
3. Have the orchestrator try the region's other platforms before giving up. Rejected as a suggestion: it multiplies Riot calls by up to 4 for the failure case, against the very rate limits Requirement 4 protects, and Requirement 5.4 explicitly defines a single fallback platform rather than a search.

Option 2 looks right, and it is small. Awaiting a decision.

### Finding B — exercising the deletion right permanently degrades that player's future reports

After `POST /api/privacy/delete` for the test account, the next lookup returned HTTP 200 with summoner level 496 but **zero champions, zero fun facts and an empty stats block**.

The mechanism is the intended behavior of three requirements composing badly:

- Requirement 12.5 scrubs the requester's participant rows out of retained cached match details, mutating them in place.
- Requirement 10.4 caches match details **indefinitely**, so they are never stale and never re-fetched.
- Requirement 10.5 therefore serves those scrubbed entries forever.

So the next lookup re-fetches `matchIds` (the same match ids come back), serves every match detail from cache, finds no participant row for the requester in any of them, and excludes all of them. The report is left technically valid and silently empty of everything match-derived. This was predicted in `mapping.ts` decision 3 and flagged in the privacy route's security note; it is now confirmed live.

Two things make this worth escalating rather than filing:

- **The degradation is invisible.** The visitor sees a report, not an explanation. `limitedDataNotice` is set, but it says stats are based on limited data, not that this profile's history was erased on request.
- **Deletion is not durable anyway.** Summoner, league and match-ids are all re-fetched and re-cached on the very next lookup, re-establishing the PUUID association that was just deleted. So the deletion permanently damages only the one category of data Requirement 12.4 wanted to keep, while failing to durably remove the categories it wanted gone. That is close to the opposite of the intent.

No change made — the fix is a genuine design decision. The candidates: evict match details rather than scrub them (simple, contradicts design.md's deliberate choice to preserve the expensive match cache); record scrubbed `(matchId, puuid)` pairs so those entries are treated as stale for that PUUID and re-fetched (restores the report, but re-acquires the data the subject asked to remove); or suppress future lookups for a deleted PUUID until the subject opts back in (durable deletion, but a new requirement entirely). Awaiting a decision.

### Finding C — a browser cannot reach the backend: no CORS, no dev proxy (found during task 16)

The frontend dev server runs on `localhost:5173` and the backend on `localhost:3001`, so every `POST /api/lookup` is a cross-origin request. Because it sends `Content-Type: application/json`, the browser issues a CORS preflight first. Probed against the running backend:

```
OPTIONS /api/lookup  Origin: http://localhost:5173
-> HTTP/1.1 200 OK, Allow: POST        (Express's default OPTIONS handler)
```

There is **no `Access-Control-Allow-Origin` header** on the preflight or on the actual response, so a browser blocks the request before the backend ever sees it. Every frontend test passes because they inject the lookup function or a fake `fetch`, and the backend's own tests use supertest, which does not enforce CORS — so nothing in the suite could have caught this. It only shows up in a real browser.

**This is task 18.1's to resolve** ("point the frontend's API client at the backend base URL"), and it is a security-relevant choice rather than a mechanical fix, so nothing was changed here. The options:

1. **Vite dev proxy** — add `server.proxy['/api']` to `vite.config.ts` and point `apiBaseUrl` at the empty string in development. Requests become same-origin, so no CORS is opened at all, and production serves both behind one origin. Cheapest and safest.
2. **CORS middleware on the backend**, restricted to an explicit allowlist of origins. Necessary if the frontend is ever served from a different origin than the API. Worth pairing with the per-IP throttling already noted in open item 3, because a permissive CORS policy on an unauthenticated endpoint that spends the shared Riot rate-limit budget is materially worse than a dev-only proxy.

Option 1 for development plus option 2 scoped to named production origins is the combination I would suggest.

---

## Summary of spec amendments

Every amendment was escalated to the user before implementation. None was made unilaterally.

| # | Task | Document | Change | Reason |
|---|---|---|---|---|
| 1 | 5.4 | design.md | `deleteByPuuid` returns `PuuidDeletionResult`, not `Promise<void>` | `void` cannot report `found`, which Requirements 12.5/12.6 and route 15.2 require |
| 2 | 5.4 | design.md | Caching Strategy now describes PUUID scrubbing of match details | Original text wrongly claimed match details were excluded from deletion, leaving PUUIDs in cache |
| 3 | 10.1 | requirements.md 7.1 | Windows computed in UTC | "Local time" is unimplementable in a pure module; Riot supplies epoch-ms UTC |
| 4 | 10.1 | requirements.md 7.3 | Dropped the self-referential duration comparison | The window *is* the player's matches, so the difference was always zero |
| 5 | 11.1 | requirements.md 8.1 | Zero recommendations is a valid outcome | All three conditional triggers can be false at once; "at least 1" was unsatisfiable |
| 6 | 11.1 | design.md Property 15 | Count clause 1–5 → 0–5 | The property asserted both strict iff triggers and a ≥1 floor, a contradiction |
| 7 | 13.1 | design.md | `cacheOrFetch` returns `failure` on the failure branch and `retrievedAt` on the success branch, and takes the injected clock | Without `failure`, Requirement 9's error table is not computable; without `retrievedAt`, Requirements 11.4/11.5 are not. Both additive |
| 8 | 13.4 | design.md | `ProfileReport` gains `averageMatchDurationMinutes`, and `lastUpdated`'s semantics are stated | Requirement 7.3 had no display target (open item 1); `lastUpdated` needed a defined rule for multi-component data |

Amendments 7 and 8 were made during task 13 without a prior round-trip, since the task was delegated as a whole. Both are strictly additive supersets of the declared shapes, both are forced by requirements that are otherwise unimplementable, and both are flagged for review. Nothing semantic was changed or removed.

---

## Correctness property inventory

| Property | Implemented | Location | numRuns |
|---|---|---|---|
| 1 Validator accepts exactly well-formed inputs | Yes | `validator/index.property.test.ts` | 100 |
| 2 Account-not-found halts pipeline | Yes | `orchestrator/index.property.test.ts` | 200 + 300 |
| 3 Region mapping closed and consistent | Yes | `region/index.property.test.ts` | 100 ×3 blocks |
| 4 Unranked never treated as failure | Yes | `orchestrator/index.property.test.ts` | 300 |
| 5 Match failures/disallowed queues excluded | Yes | `orchestrator/index.property.test.ts` | 300 |
| 6 API key never in client-facing output | Yes | `riotApiClient/index.property.test.ts` | 100 |
| 7 Rate limit reservation bounds | Yes | `rateLimit/index.property.test.ts` | 100 |
| 8 429 retry wait and count bounded | Yes | `riotApiClient/index.property.test.ts` | 100 |
| 9 Win rate and KDA formulas | Yes | `insight/stats.property.test.ts` | 200 |
| 10 Top-champion total order | Yes | `insight/stats.property.test.ts` | 300 |
| 11 Most-played role recency tiebreak | Yes | `insight/stats.property.test.ts` | 300 |
| 12 Time-of-day reports all tied windows | Yes | `insight/funFacts.property.test.ts` | 300 |
| 13 Streak lengths | Yes | `insight/funFacts.property.test.ts` | 300 |
| 14 Fun fact eligibility and uniqueness | Yes | `insight/funFacts.property.test.ts` | 300 |
| 15 Recommendation triggers exact | Yes | `insight/recommendations.property.test.ts` | 400 |
| 16 Cache key deterministic and injective | Yes | `cache/index.property.test.ts` | 300 |
| 17 Cache TTL staleness per endpoint | Yes | `cache/index.property.test.ts` | 300 |
| 18 Non-stale entries skip the API client | Yes | `orchestrator/cacheOrFetch.property.test.ts` | 300 |
| 19 Cache refresh atomicity | Yes | `orchestrator/cacheOrFetch.property.test.ts` | 300 |
| 20 Deletion idempotent and answered | Yes | `cache/index.property.test.ts` | 200 |

**All 20 implemented.** All are tagged `// Feature: lolprofiles-gg, Property N: <text>` matching design.md verbatim, all ≥100 runs, none depends on live Riot APIs, real network, real credentials, or real timers. Every property test guards against degenerate coverage by counting the branches it exercised and asserting each was reached at least once.

---

## Open items carried forward

1. ~~**Requirement 7.3 has no display target.**~~ **CLOSED at 13.4** by adding `ProfileReport.averageMatchDurationMinutes` (amendment 8) and correcting task 16.4's requirement list. Task 16.4 must now actually render it.
2. ~~**Server-side logging exists only for the orchestrator.**~~ **CLOSED at 15.** Requirement 9.5's obligation is met by the orchestrator's `LookupLogger.authFailure`, which logs every 401/403 at the stage it occurred; the API layer deliberately does not log it again (that would double-count incidents) and instead owns 9.5's other half, the generic message. The API layer's own `ApiLogger.unexpectedError` covers defects, which nothing previously logged.
3. **Both routes are unauthenticated. UNRESOLVED, and the deletion route is the sharper risk.** The spec defines no authentication and none was invented.
   - `/api/privacy/delete` accepts any PUUID and mutates cached data. Evictions are merely re-fetchable, but **scrubbing is not recoverable from cache**: a redacted match detail stays redacted, and since match details are cached indefinitely (Requirement 10.4) and only re-fetched on a miss, a scrubbed entry is effectively permanent while it remains cached. So an anonymous caller can irreversibly degrade cached data for arbitrary players, and cheaply lower hit rates for everyone. Requirement 12.5's "data subject requests removal" implies proof of control over the account, but no mechanism is specified. **Needs an explicit decision before any public deployment.**
   - `/api/lookup` spends the *shared* Riot rate-limit budget on a cache miss. The Rate Limit Manager guarantees we never exceed Riot's windows, so the API key stays in good standing, but it cannot stop the budget being consumed by whoever asks first — so an anonymous caller requesting many distinct Riot IDs degrades every other visitor's lookups. Per-IP throttling is the mitigation and is out of scope for the current tasks.
4. ~~**`frontend/src/config.ts` is unimported.**~~ **CLOSED at 16.3** — `lookupClient.ts` imports `apiBaseUrl`, so a typo in `VITE_API_BASE_URL` now surfaces.
5. ~~**`/profile` route has no `:riotId` param.**~~ **CLOSED at 16.** Resolved with a query parameter through `URLSearchParams`, which encodes `#` as `%23`. See the task 16 record.
16. **The frontend cannot reach the backend from a browser (Finding C).** No CORS headers and no dev proxy, so every cross-origin request is blocked before the backend sees it. No test could catch it — frontend tests inject `fetch`, and supertest does not enforce CORS. **Blocks any real end-to-end use; belongs to task 18.1.**
17. **Requirement 6.7's zero-deaths KDA rule has no dedicated frontend assertion.** It is fully implemented and property-tested in the backend Insight Engine (Property 9), and the view simply renders the number it is given, so there is nothing frontend-specific to verify — recorded so the gap is deliberate rather than an oversight.
6. **Performance targets are unverified.** Requirements 11.1/11.2 specify p95 ≤2s cached and ≤15s fresh. Per the build prompt, unit tests do not prove these; they require staging/load testing. No performance claim has been made.
7. **No version control.** Stray-file auditing at checkpoints is filesystem-based. Consider `git init`.
8. **Frontend jsdom setup costs ~12.5s** for 2 tests; will become noticeable as task 16 adds test files.
9. **Property 2's wording is ambiguous and should be sharpened.** Its "never returns a success result containing partial or stale data for that session" reads, taken literally, as forbidding Requirement 11.3's cached fallback outright, and its "any ... Match-V5 call fails" reads as forbidding Requirement 3.3's continue-on-individual-failure. Task 13 implemented design.md's own resolution of both (see the 13.x record) and documented the reading in the test, without amending the property text. **Recommend rewording design.md's Property 2** to say "never returns a success result assembled from an incomplete set of components, and never returns one built from cached data without `partialDataWarning` set", and to name match-ids-by-puuid explicitly. Deferred because it is a clarification of intent, not a behavior change, and the user may prefer different wording.
10. **`MatchHistoryWindow.attemptedCount` is populated but never rendered.** design.md declares the field and the orchestrator fills it, but `ProfileReport` has no place for it and Requirement 3.4's user-visible consequence is the limited-data notice, which is driven by the *included* count. It is the natural source for an "N of M matches analyzed" line if task 16.4 wants one; otherwise it stays informational.
11. **Cache keys for `account` are case-sensitive.** design.md keys the entry on `{ gameName, tagLine }` as submitted, so `Faker#KR1` and `faker#kr1` occupy two entries and miss each other's cache. Riot ID lookup is case-insensitive, so this costs hit rate on a hot endpoint. Left alone because normalizing the key changes design.md's declared key params; worth raising at 15.1.
12. ~~**The live credential has not been exercised.**~~ **DONE after task 15** — see the Live verification section. The backend was confirmed working end to end against the real Riot API. Two findings came out of it (A: wrong-region UX; B: deletion permanently degrades future reports), both awaiting a decision. **The key used was pasted into the chat transcript and must be rotated.**
14. **`npm run dev` is broken and nothing loads `.env`.** The `dev` script invokes `ts-node`, which is not a dependency, and `config/index.ts` reads `process.env` directly with no `dotenv` in the project, so the existing `.env.example` is decorative. Running locally requires `npm run build` plus `node dist/index.js` with the variable exported. Worth fixing (add `ts-node` and `dotenv`, or drop the script and the example file) so the documented workflow matches reality.
15. **The Riot ID rules and region mapping exist in two places — now GUARDED at task 17.** The frontend needs its own copy (Requirements 1.3–1.5 want inline feedback, Requirement 5.3 needs the mapping for the selector) and the workspaces share no code. `frontend/src/domain/parity.test.ts` now reads the backend source as text and asserts the two agree; it was mutation-tested to confirm it fails on a real drift. The residual risk is narrow: the guard covers the region mapping, both length limits, `DEFAULT_REGION` and the error-code set, but not the *precedence order* of the validation rules, which is asserted independently in both workspaces instead. A shared workspace package remains the cleaner long-term fix.
13. **The pre-task-13 property tests still carry probabilistic coverage guards.** Tasks 2–12's property tests use the same `expect(count).toBeGreaterThan(0)` pattern that flaked in task 15, without `examples` to guarantee the branches. Their guards sit on far higher-probability shapes and have passed every run so far, so this is latent rather than active — but the fix is mechanical (add `fc.assert`'s `examples`, as the task-13 properties now do) and worth applying before this suite runs in CI, where an intermittent red build is expensive.

---

## What exists and what does not

**Working today:** backend boots with `RIOT_API_KEY` set and serves `GET /health`. Frontend dev server renders a "Search a player" heading with no interactivity.

**Implemented and tested:** config, Riot ID validator, region router, cache store (with TTLs and PUUID scrubbing), rate limit manager, Riot API client (all five endpoints), the full Insight Engine (stats, fun facts, recommendations), and the full Lookup Orchestrator (`cacheOrFetch`, Riot-schema mapping, `runLookup`).

The whole lookup pipeline is now callable and fully tested end to end against fakes: a Riot ID plus a region produces a complete `ProfileReport` or a typed error, with caching, queue filtering, insight generation, the Requirement 9 error mapping, and the 15s budget fallback all in place.

**The backend is functionally complete and verified against the live Riot API.** With `RIOT_API_KEY` set it boots, serves `GET /health`, `POST /api/lookup` and `POST /api/privacy/delete`, and runs the full pipeline: validation, regional routing, cache-or-fetch, rate limiting, insight generation, error mapping, and deletion.

**The frontend is complete as a set of components and builds cleanly**, with the search form, region and platform selectors, inline validation, loading indicator, all seven error states with bounded retry and cooldown, the full report view, and the attribution and no-advertising template.

**What does not work yet: the two halves talking to each other in a browser.** Finding C — no CORS headers and no dev proxy, so every cross-origin request from the dev server is blocked before it reaches the backend. Every layer is individually exercised and the backend is proven against real Riot data, but **no end-to-end run through a browser has ever succeeded.** That is task 18.1's remaining work, and it is the last thing standing between this build and a usable application.
