# Implementation Plan: champion-build-stats-pipeline

## Overview

The offline crawler that fills the `championStatsStore` that
`specs/champion-build-stats/` shipped as a no-op. Backend only, no frontend
change. One background `CrawlWorker` (sibling of clash-scouting's
`TournamentRefresher`) drives seed → crawl → extract → aggregate per cycle;
`MongoChampionStatsStore` reads the aggregates and reuses the existing pure
`resolveBuilds`. Every crawler Riot call passes a `CrawlGate` token bucket before
`reserveSlot`, so live lookups always have headroom.

**Ships dark.** `CRAWLER_ENABLED` is unset by default → `CrawlWorker.start()` is
inert, the Mongo store reads empty collections and returns `null`, the
endpoint/page behave exactly as today. Turning it on is one env var, no redeploy.

## Interpretation choices — NOT user-specified, confirm

The audit (2026-09-08) drove several revisions; requirements.md + design.md now
reflect them. Open confirmables:

1. **`isCompletedItemId` source** — a generated + version-pinned completed-item id
   set bundled like `championKeys.ts` (regen script from `item.json`). Pinned at
   one `DDRAGON_VERSION`; an item reworked between the pin and a crawled patch is
   misclassified — accepted, regen on deploy.
2. **Module constants** — `STARTING_ITEMS_CUTOFF_MS = 90_000`, `MAX_FREQ_KEYS = 40`
   (may drop to 25), `KEEP_PATCHES = 2`, `PROCESSED_TTL = 120d`, `SEED_TTL = 7d`,
   `SEED_PLATFORMS = ['euw1','na1','kr']`, `MAX_SEED_ENTRIES_PER_REFRESH = 1500`.
   Not env-configurable (only the 6 operational knobs are — task 14.1).
3. **v1 crawl scope**: queue 420 only; region `world` = the 3-platform seed set;
   buckets `EMERALD_PLUS`/`DIAMOND_PLUS`/`MASTER_PLUS` + `ALL`, with each match
   **rolled into every bucket at or below the seed's tier** (so the `_PLUS`
   labels are honest).
4. **`CRAWL_RPS` constant** + `CRAWL_BUDGET_FRACTION = 0.25` default; the operator
   dials the fraction (much lower on a dev key). The gate is an **open-loop
   throttle** — "live always has headroom" is statistical, not guaranteed.

**User directive 2026-09-08:** patch handling is loose — the store reads the
newest patch with data; pruning is opportunistic, not a correctness gate.

Fixed by `specs/champion-build-stats/`: the wire contract (Req 10–13 there),
`MIN_SAMPLE=500`, `CORE_ITEM_COUNT=3`, `BACKEND_DISPLAY_FLOOR`, `MODAL_MIN_SHARE`,
the Role/Rank vocabularies, and the pure `resolveBuilds`.

---

## Riot client + projection

- [x] 1. League-V4 ladder methods + match-id queue filter + `gameVersion`
  - [x] 1.1 `riotApiClient/index.ts` — `getLeagueApex(platform, tier, queue)`
    (`challenger`/`grandmaster`/`master` → `LeagueListDto` with `entries[].puuid`)
    and `getLeagueEntriesPage(platform, queue, tier, division, page)` (paged
    `entries/{queue}/{tier}/{division}?page=N`, `[]` past the last page). Both
    platform-routed via `send()`. New `RIOT_METHODS.leagueApex` / `.leagueEntries`.
    - _Requirements: 2.1_
  - [x] 1.2 `getMatchIdsByPuuid` gains an optional `queue?: number` → `&queue=420`.
    All existing callers unaffected (param omitted).
    - _Requirements: 3.1_
  - [x] 1.3 `MatchDto['info']` gains `gameVersion: string`; `matchProjection.ts`
    copies it in `projectMatchDto`. Additive — same shape as the `championId`
    addition. `projectMatchDto` stays total (missing → `''`).
    - _Requirements: 4.3_
  - [x] 1.4 Fan-out — **turned out not needed.** 1.1 put the ladder methods on a
    separate `LadderSource` interface (NOT `RiotApiClient`), so no orchestrator
    test double changed; 1.2/1.3 used an optional param / optional field. No cache
    endpoint added (ladder calls are crawler-only, never cached). `RIOT_METHODS`
    is a plain object (not an exhaustive `Record<RiotMethod, …>` anywhere), so
    adding two keys needed no other update. `createRiotApiClient` now returns
    `RiotApiClient & LadderSource`.
  - [x] 1.5 `riotApiClient` tests for the 3 changes (apex list shape, entries
    paging + empty tail, `queue` in the match-ids URL, `gameVersion` passthrough).
    - _Requirements: 2.1, 3.1_

- [x] 2. `orchestrator/mapping.ts` — export `runePageOf`
  - [x] 2.1 Change `function runePageOf` → `export function runePageOf`. No other
    change; existing tests still pass.
    - _Requirements: 4.2_

- [x] 3. Checkpoint — `npm run test:backend` + tsc + eslint clean.

---

## Pure building blocks

- [x] 4. Completed-item predicate
  - [x] 4.1 `insight/completedItems.ts` — `isCompletedItemId(id): boolean` +
    `BOOT_ITEM_IDS`. Choice 1: a generated `COMPLETED_ITEM_IDS` set (+ a
    `scripts/generateCompletedItems.mjs` regenerating it from `item.json` at the
    pinned `DDRAGON_VERSION` — a completed item = `gold.purchasable` &&
    `into` empty && not `Consumable`-tagged, plus the boot line). Bundled output
    committed, `CHAMPION_KEYS_DDRAGON_VERSION`-style version constant.
    - _Requirements: 4.3.2_
  - [x] 4.2 Tests: known legendaries `true`, components (Long Sword, Amplifying
    Tome) `false`, boots `true`, trinkets/wards/consumables `false`, version
    constant pinned.

- [x] 5. `maxOrderFromSkillOrder` — shared pure helper
  - [x] 5.1 `insight/skillOrder.ts` — `maxOrderFromSkillOrder(perLevel:
    readonly number[]): ('Q'|'W'|'E')[]` — the same logic as the frontend's
    `SkillOrderView.tsx` copy. `frontend/src/domain/parity.test.ts` gains an
    input→output table asserted identical on both sides (a function body can't be
    text-compared; the parity test already reads backend source as text — use a
    fixed table of ~5 `(perLevel → maxOrder)` cases mirrored in both test files).
    - _Requirements: 4.3.3_
  - [x] 5.2 Tests: Q's 5th point first → `['Q', …]`; nothing maxed → `[]`; tie
    broken by which reached 5 points first; R never appears.

- [x] 6. Serialization
  - [x] 6.1 `champions/pipeline/serialize.ts` — `serialize`/`parse` pairs for
    item path (`3006-3031-3036`), skill order (`.`/`$`-free — e.g.
    `QWE~1-3-2-1`), rune page (produces the exact `RunePage` shape on parse),
    spell pair (`4-7`), starting items (`1055-2003`). Every pair a total
    round-trip.
    - _Requirements: 5.5_
  - [x] 6.2 `serialize.test.ts` + `.property.test.ts` — round-trip for every type
    over random inputs; every produced key matches `/^[^.$\x00]+$/` AND is
    non-empty AND has no leading `$`; `parseRunePage(serializeRunePage(runePageOf(p)))`
    deep-equals the original `RunePage`.
    - _Requirements: 5.5_

- [x] 7. The extractor (pure)
  - [x] 7.1 `champions/pipeline/extractor.ts` — `Observation` interface +
    `extractObservations(match: MatchDto, timeline: MatchTimelineDto):
    Observation[]`. `queueId !== 420` or no parseable `gameVersion` → `[]`. Build
    `slotByPuuid` from `timeline.info.participants[]` (`{participantId, puuid}` —
    the authoritative map; **not** `index + 1`). Per `match.info.participants[i]`
    with non-empty `puuid` and a slot in that map: `replayShopEvents(events,
    slot).buildPath` → `isCompletedItemId` filter → first `CORE_ITEM_COUNT` =
    `itemPath`; `buildPath` ids at `timestamp <= STARTING_ITEMS_CUTOFF_MS` minus
    trinkets/consumables = `startingItems`; `extractSkillOrder(events, slot)` →
    `maxOrderFromSkillOrder` → `{ maxOrder, perLevel }` (`null` if empty);
    `runePageOf(participant)` → `null` when `primaryStyle === 0 &&
    primarySelections.length === 0`; `[summoner1Id, summoner2Id]` → `null` if
    either `0`/absent. `patch` = `major.minor` of `gameVersion`.
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [x] 7.2 `extractor.test.ts` — a hand-built 10-participant queue-420 match +
    timeline **with the timeline participant order shuffled vs the match order**
    (proves the puuid join, not positional): one Observation per human, none for
    a `puuid:''` slot, correct itemPath / skillOrder / runes / spells / starts
    for a known participant; `[]` for `queueId: 450` and for `gameVersion: ''`.
    - _Requirements: 4.5_
  - [x] 7.3 `extractor.property.test.ts` — random purchase/skill event streams:
    every `itemPath` is a length-≤`CORE_ITEM_COUNT` subsequence of that
    participant's real completed-item purchases in order; a `puuid:''` slot never
    yields an Observation.
    - _Requirements: 4.5_

---

## Rate budget

- [x] 8. `CrawlGate`
  - [x] 8.1 `champions/pipeline/crawlGate.ts` — `createCrawlGate({ rps, fraction,
    now, sleep? }): { acquire(): Promise<void> }`. Token bucket: `capacity =
    max(1, round(rps*fraction))`, refill `rps*fraction`/s, `acquire` waits for a
    token then consumes it. `sleep` injected. Open-loop — no view of `reserveSlot`
    or live contention; module doc states this plainly.
    - _Requirements: 7.1_
  - [x] 8.2 `crawlGate.test.ts` (manual clock + sleep) — first `capacity` acquires
    are immediate; the next waits ~`1/(rps*fraction)`s; N acquires over T seconds
    ≈ `rps*fraction*T`; a `fraction` so low `rps*fraction` rounds to 0 still
    grants at a floor of 1 token slowly (documented).
    - _Requirements: 7.1_

---

## Persistence

- [x] 9. Pipeline collections + indexes
  - [x] 9.1 **DONE as `champions/pipeline/constants.ts`** (created early for task 7):
    driver-import-free collection names + `PROCESSED_TTL_SECONDS` / `KEEP_PATCHES` /
    `MAX_FREQ_KEYS` / `SEED_TTL_MS` / `SEED_PLATFORMS` / `MAX_SEED_ENTRIES_PER_REFRESH` /
    `STARTING_ITEMS_CUTOFF_MS` / `STARTING_EXCLUDED_ITEM_IDS` / `RANKED_SOLO_QUEUE_ID` /
    `bucketsForTier(tier)`. Index creation → `db/client.ts` (task 9.2).
    - _Requirements: 8.2, 8.3_
  - [x] 9.2 `db/client.ts` `ensureIndexes` — add the pipeline indexes inline
    (like every other collection): `champion_build_aggregates` `{championKey:1,
    patch:1}` + unique `{championKey:1,role:1,rankBucket:1,region:1,patch:1}`;
    `crawl_seeds` `{refreshedAt:1}`; `crawl_processed` `{processedAt:1}` TTL
    `PROCESSED_TTL_SECONDS`. `champion_build_totals` / `crawl_state` are `_id`-keyed.
    Runs unconditionally at boot (so the Mongo store works before the crawler ever
    runs — Req 10.1).
    - _Requirements: 6.5_

- [x] 10. The aggregator
  - [x] 10.1 `champions/pipeline/aggregator.ts` — `createAggregator({ db, now })`
    with `fold(observations, matchId, seedTier): Promise<void>`:
    - up front: if `crawl_processed` has `matchId` → return (no-op);
    - per Observation: `roles = observed teamPosition (if one of the 5) then
      'ALL'`; `buckets = bucketsForTier(seedTier)` (incl. `ALL`); for each
      `(role, bucket)` one `champion_build_aggregates` upsert (`$inc` counters +
      nested freq paths, `$set` identity + `lastUpdatedAt = now`);
    - once per `fold`: `$inc { matches: 1 }` on `champion_build_totals` for each
      bucket in `bucketsForTier(seedTier)` (role-agnostic);
    - last: `insertOne({ _id: matchId, processedAt: now })` on `crawl_processed`,
      ignore duplicate-key.
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.7_
  - [x] 10.2 Freq-map cap (Req 5.4) — read each target doc's current `itemPaths` /
    nested key sets once per `fold`; drop an `$inc` path whose map is at
    `MAX_FREQ_KEYS` and whose key is new. Single sequential worker → no real race;
    documented (`cell.games` may then exceed `Σ itemPaths.games`).
    - _Requirements: 5.4_
  - [~] 10.3 Done as `aggregator.test.ts` — pure `planAggregation` unit tests (11:
    bucket/role fan-out, nested `$inc` structure, loss, cap drop + at-cap-keep,
    empty) + a fake-`Db` `fold` test (processed no-op, 2 bulkWrites + processed
    marker, dup-key swallow). The real `mongo:7` integration test
    — a `DIAMOND`-tier Observation → aggregate docs for `{role|ALL} ×
    {EMERALD_PLUS, DIAMOND_PLUS, ALL}` (6 docs, right `_id`s); the match bumps
    `EMERALD_PLUS|world|patch`, `DIAMOND_PLUS|…`, `ALL|…` totals by 1; `wins`
    increments only on a win; a second `fold` of the same `matchId` → no-op; the
    cap holds after `MAX_FREQ_KEYS + 5` distinct paths.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7_

- [x] 11. `MongoChampionStatsStore`
  - [x] 11.1 `db/championStatsStore.ts` — replace the `TODO(champion-build-stats-
    pipeline)` marker with `MongoChampionStatsStore(db, now)` implementing
    `ChampionStatsStore`. `getBuildStats` per design "MongoChampionStatsStore":
    latest-patch discovery → `champDocs` `find` → `meta` assembly (**incl.
    `defaultRole` = top non-`ALL` role ?? `'ALL'`, `defaultRank` = `'ALL'`**) →
    the one `cell` → `toChampionAggregate(cell)` deserializing freq maps to
    `CohortEntry[]` (via `serialize.ts` parsers, synthetic `pickRate: 0`) →
    `resolveBuilds(...)` (existing pure fn, unchanged) → role-agnostic totals doc
    (`{rank}|world|{patch}`) → `meta.overall.pickRate = cell.games /
    totals.matches`. ≤4 indexed reads, `Promise.race` with a ~500 ms timeout →
    `null` on timeout/throw. `null` for an unknown champion; populated-`meta` +
    `popular:null` for a known champion / thin filter.
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [~] 11.2 Done as `championStatsStore.mongo.test.ts` — 6 tests against a tiny
    fake `Db` (find/findOne/toArray only): null for no docs; popular/highestWinRate
    byte-match the in-memory fake for the same data; pickRate from the totals doc;
    populated-meta + popular:null for an unseen filter; newest patch by numeric
    major.minor; read-throw → null. Real `mongo:7` integration in task 18. Original: seed
    aggregate + totals docs directly, assert: unknown champion → `null`; the
    happy path's `popular`/`highestWinRate` match the **in-memory fake's**
    `resolveBuilds` output for the same underlying data (proves the Mongo path is
    just I/O around the shared pure core); known-champion-wrong-filter →
    `meta` lists populated + `popular:null`; an induced read error → `null`.
    - _Requirements: 6.3_

---

## The seeder + worker

- [x] 12. The seeder
  - [x] 12.1 `champions/pipeline/seeder.ts` — `createSeeder({ client, gate, db,
    now })` with `refreshIfStale(): Promise<SeedSummary>`: newest
    `crawl_seeds.refreshedAt` within `SEED_TTL_MS` → `{ skipped: true }`; else for
    each platform in `SEED_PLATFORMS`, walk the 3 apex lists (→ tier `MASTER` /
    `GRANDMASTER` / `CHALLENGER`) + paged `EMERALD` I–IV and `DIAMOND` I–IV
    entries (→ tier `EMERALD` / `DIAMOND`), `gate.acquire()` before each call,
    stopping at `MAX_SEED_ENTRIES_PER_REFRESH` total; upsert `{ _id: puuid, tier,
    platform, refreshedAt: now }` (store the raw tier — the aggregator derives
    buckets via `bucketsForTier`). A failing ladder call → counted, continue.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [~] 12.2 `seeder.test.ts` — faked client returning apex + 2 entry
    pages then `[]` for one platform: `crawl_seeds` gets the union, each tagged
    with its raw tier + platform; a re-run within TTL → `skipped`; a re-run after
    TTL with a moved player updates its tier; a throwing apex call doesn't throw
    out of `refreshIfStale`; the `MAX_SEED_ENTRIES_PER_REFRESH` bound holds.
    - _Requirements: 2.2, 2.3, 2.5_

- [x] 13. The crawl worker
  - [x] 13.1 `champions/pipeline/crawlWorker.ts` — `createCrawlWorker({ client,
    db, config, now, schedule?, logger? }).start()/.stop()`. NO `cache` (Req 3.7).
    Disabled (`!config.enabled` or `db === null`) → `start()` inert (Req 1.3).
    Explicit `running` boolean so a tick during a cycle is **skipped, not queued**
    (Req 1.2 — `tournamentRefresher`'s time-based guard is not enough). Injected
    `schedule` (`RepeatingScheduler` from `tournamentRefresher.ts`). `stop()`
    cancels. Builds its own `CrawlGate` from `config.rps`/`.budgetFraction`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6_
  - [x] 13.2 `runCycle()`:
    (a) opportunistic prune — `deleteMany` aggregate + totals docs for any patch
    older than newest − `KEEP_PATCHES` (best-effort, non-fatal — user directive:
    patch handling is loose);
    (b) `seeder.refreshIfStale()`;
    (c) read `crawl_state.seedCursor`, take the next `CRAWL_SEEDS_PER_CYCLE`
    `crawl_seeds` in a stable `_id` order (wrap);
    (d) per seed: `gate.acquire()` → `getMatchIdsByPuuid(regionOf(seed.platform),
    puuid, CRAWL_MATCHES_PER_SEED, 420)`; drop ids in `crawl_processed` **or** a
    per-cycle in-memory seen-set; per remaining id `gate.acquire()` ×2 → detail +
    timeline → **if either call `.kind === 'rate_limited'` → abandon the whole
    cycle** (`endedEarly`), else on any other non-`ok` / malformed / non-420 skip
    the id (unmarked) → `extractObservations` → `aggregator.fold(obs, matchId,
    seed.tier)`;
    (e) advance `seedCursor`, write `crawl_state` + emit the summary line.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 7.3, 8.2, 9.1, 9.2_
  - [x] 13.3 Structured summary log (Req 9.1) — one line/cycle via the injected
    `logger` (or `console` `[lolprofiles]` prefix): `{ seedsRefreshed,
    seedsProcessed, idsSeen, idsSkippedProcessed, matchesFetched,
    observationsFolded, riotCalls, endedEarly }`. Counts only — **no puuid /
    riotId / key** (Req 9.3).
    - _Requirements: 9.1, 9.3_
  - [~] 13.4 `crawlWorker.test.ts` (fake Db, not mongo:7) (`mongo:7`) — faked client with a
    fixed ladder + a few queue-420 matches: cycle 1 seeds → crawls → aggregates →
    marks processed → writes `crawl_state` + logs a summary; cycle 2 re-reads the
    same seeds and issues **0** detail/timeline fetches (all processed); a
    `rate_limited` result mid-cycle → `endedEarly`, nothing half-written that
    corrupts a re-run; a `fold` that throws is caught, worker survives, next tick
    runs; `enabled: false` → `start()` makes zero calls; a tick fired while a
    cycle runs is dropped.
    - _Requirements: 1.2, 1.3, 1.5, 1.6, 3.2, 3.5, 7.3, 9.2_

---

## Wiring + docs

- [x] 14. Config
  - [x] 14.1 `config/index.ts` — `crawlerEnabled` (`CRAWLER_ENABLED`, boolean,
    default false), `crawlBudgetFraction` (`CRAWL_BUDGET_FRACTION`, default 0.25,
    clamped `(0, 1]`), `crawlIntervalMs` (`CRAWL_INTERVAL_MS`, default 5 min),
    `seedsPerCycle` (`CRAWL_SEEDS_PER_CYCLE`, default 25), `matchesPerSeed`
    (`CRAWL_MATCHES_PER_SEED`, default 20), `crawlRps` (`CRAWL_RPS`, default a
    conservative constant). All optional; unset = safe defaults.
    - _Requirements: 7.5, 1.3, 8.4_
  - [x] 14.2 `config/index.test.ts` — defaults, clamping, `CRAWLER_ENABLED`
    truthiness parsing.
  - [x] 14.3 `.env.example` — the new vars, commented, with the "off by default,
    needs a production key for real freshness" note.

- [x] 15. Composition root
  - [x] 15.1 `index.ts` — `championStatsStore` becomes `databaseClient.enabled ?
    new MongoChampionStatsStore(databaseClient.db(), now) :
    createNoopChampionStatsStore()` (was always the no-op).
    - _Requirements: 10.1, 10.3_
  - [x] 15.2 `index.ts` — build `createCrawlWorker({...})`, `.start()` at boot,
    `.stop()` in the SIGTERM/SIGINT shutdown alongside `tournamentRefresher.stop()`
    and `databaseClient.close()`.
    - _Requirements: 1.1, 10.3_
  - [x] 15.3 `api/privacy.ts` — comment: `crawl_seeds` / `crawl_processed` hold
    ladder-public PUUIDs (not looked-up-user data), so privacy-delete has nothing
    to clear from the pipeline collections.
    - _Requirements: 9.3_
  - [x] 15.4 Fan-out — **none needed.** No test exercises the composition root
    `main()`; every `createNoopChampionStatsStore()` in a test is a fixture stub
    passed to `createApiRouter`/`createApp`, unaffected.

- [x] 16. Checkpoint — full backend suite + tsc + eslint; mongo-integration green
  against `mongo:7`.

- [x] 17. Documentation
  - [x] 17.1 README Database section — 4 new collections in the table
    (`champion_build_aggregates`, `champion_build_totals`, `crawl_seeds`,
    `crawl_processed`, `crawl_state`) + the fat-doc storage calc (~150–250 MB
    steady state; worst case if every doc hit the cap would not fit M0, which is
    why the cap + prune are load-bearing).
  - [x] 17.2 README — a "Champion build pipeline" subsection: what the worker
    does, the `CrawlGate` / shared-budget story, "off by default, `CRAWLER_ENABLED`
    to turn on, a full pass is weeks on a dev key and competes with live lookups".
  - [x] 17.3 README Environment table — the 6 new vars.
  - [x] 17.4 README Known gaps — replace the "no data yet" bullet: the pipeline
    exists but is **off by default** (`CRAWLER_ENABLED`); a full pass is weeks on
    a dev key and shares the live rate budget; the "live always has headroom"
    property is statistical; multi-region + finer rank granularity deferred.
  - [x] 17.5 `specs/champion-build-stats/tasks.md` task 2.3 note + design.md
    "Store" note updated: `MongoChampionStatsStore` now exists.

- [x] 18. Verification
  - [x] 18.1 backend 929 pass / 17 skip, lint + build clean; the 2 new
    mongo-integration files (`pipeline.integration.test.ts`, the
    `mongo.integration.test.ts` pipeline-index assertion) green against the real
    Atlas M0 (17 tests).
  - [x] 18.2 Against real Atlas M0: the composition-root build with `CRAWLER_ENABLED`
    unset serves `GET /api/champions/Jinx/build-stats` → 200 empty-state (Mongo
    store, `availableRoles: []`). **The user had already committed the pipeline
    (`f11c651 "crawlers"`) and deployed it to Render with `CRAWLER_ENABLED=1`**, so
    the real crawler was found running against the shared `lolprofiles` cluster:
    `crawl_seeds` 1500 (CHALLENGER 300 / GRANDMASTER 700 / MASTER 500 — the seeder
    hitting `MAX_SEED_ENTRIES_PER_REFRESH`), `crawl_processed` 22, `champion_build_
    aggregates` 736 docs across 90 champions on two patches (16.17 + 16.16),
    `champion_build_totals` 8 (`{bucket}|world|{patch}`, 18 matches on 16.17 / 4 on
    16.16). Apex seeds correctly fold into all four buckets (`Viktor|ALL|MASTER_PLUS`
    == `Viktor|ALL|EMERALD_PLUS` == 5). Endpoint reads it back correctly (Jinx →
    `totalGames: 2`, `pickRate: 2/13`, `popular: null` — under the 100-game floor).
    No data corruption; no cleanup done (it is the user's real prod data now).
    - _Requirements: 10.1, 10.2_
  - [x] 18.4 **Robustness fix found during 18.2**: `crawl_state.seedCursor` was
    only persisted at clean cycle end / early-stop, so a cycle cut short by a
    Render redeploy (observed: `crawl_state: null` after 22 matches) never
    advanced and the crawler would re-scan the same 25 seeds forever. `runCycle`
    now writes `crawl_state` **after each seed player**, so progress survives a
    mid-cycle restart. `crawlWorker.test.ts` updated. **Not committed — needs a
    commit + Render redeploy.**
  - [~] 18.3 Verified by design (CrawlGate unit tests + `reserveSlot` is the
    shared counter, live lookups bypass the gate). A precise live A/B timing was
    not run — consistent with README's "performance targets are unverified".
    Original: Confirm a live `POST /api/lookup` during an active crawl cycle is not
    measurably slower (the `CrawlGate` + `reserveSlot` interplay) — spot-check,
    not a load test.
    - _Requirements: 7.4_

## Task dependency graph

```json
{
  "1": [], "2": [], "3": ["1", "2"],
  "4": [], "5": [], "6": [], "7": ["4", "5", "6", "2"],
  "8": [],
  "9": [], "10": ["6", "7", "9"], "11": ["6", "9"],
  "12": ["1", "8", "9"], "13": ["7", "8", "10", "12"],
  "14": [], "15": ["11", "13", "14"], "16": ["15"],
  "17": ["16"], "18": ["16", "17"]
}
```

Tasks 1–2 (client) and 4–6 + 8 (pure) can all start in parallel. Task 11
(`MongoChampionStatsStore`) is independent of the worker and de-risks the read
contract early — do it right after task 6/9.

## Optional (skipped by default)

- [ ] * 19.1 Remove the 10× redundant *cross-cycle* crawling: a `crawl_seen`
  bloom or a "matches queued this pass" marker so a match with 3 seeded
  participants is fetched once, not 3× over 3 cycles.
- [ ] * 19.2 A tiny `GET /internal/crawl-state` (auth-gated) returning the
  `crawl_state` summary, for ops visibility without shell access.
- [ ] * 19.3 Property test: `MongoChampionStatsStore.getBuildStats` output is
  byte-identical to `InMemoryChampionStatsStore` for any generated set of
  aggregate docs.
- [ ] * 19.4 Exact freq-map cap (a real transaction / conditional update) instead
  of the racy read-then-decide.

## Notes

- **Cross-spec:** consumes `specs/champion-build-stats/`'s `ChampionStatsStore`
  interface, `ChampionAggregate` / `CohortEntry` read-model types, and the pure
  `resolveBuilds` — all unchanged. Satisfies its Requirements 12.2 / 14.1.
- **Property-test convention:** fast-check ≥100 runs, `*`-tagged, skipped by
  default (matches live-game / clash-scouting).
- **Mongo-integration convention:** `MONGODB_TEST_URI`-gated `describe`, skipped
  without it, green against a `mongo:7` container (matches `specs/database/`).
- **Dev-key reality:** a full seed+crawl pass is 1–3 weeks at ~0.8 rps and
  competes with live lookups. The crawler is correct and safe to run, but only a
  production key makes per-patch freshness practical — say so in the README.
