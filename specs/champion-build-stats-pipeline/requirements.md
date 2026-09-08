# Requirements Document

## Introduction

`specs/champion-build-stats/` shipped the champion build page, the search-dropdown
champion rows, and the `GET /api/champions/:championKey/build-stats` endpoint —
all behind a `championStatsStore` that is currently the disabled no-op, so the
page renders "Not enough games recorded" for every champion.

This spec builds the **offline pipeline that fills that store**: a background
worker that seeds a pool of ranked players, crawls their recent ranked matches,
extracts each participant's build, and folds it into pre-aggregated documents on
the same MongoDB Atlas M0 instance the rest of the site's persistence uses. When
it lands, the existing endpoint / page / components start showing real numbers
with **no frontend change** and one composition-root swap (`MongoChampionStatsStore`
for the no-op).

**Hard constraints that shape everything:**

1. **Riot publishes no aggregate endpoint.** Every number is derived from this
   site's own crawl. There is no shortcut.
2. **One shared Riot rate-limit budget.** Live player lookups
   (`POST /api/lookup`, live-game, clash-scouting) and the crawler draw from the
   same `RateLimitManager`. Live traffic must always take precedence — a visitor
   waiting on their profile must never be slowed because the crawler is running.
3. **The M0 tier holds ~512 MB.** The raw crawled match corpus (millions of
   matches × 5 KB projected = many GB) does **not** fit and is **never stored** —
   only the aggregates (estimated 60–250 MB) and small bookkeeping collections.
4. **The tournaments-endpoint precedent.** clash-scouting proved that a
   background worker writing a store, with request paths only ever reading it, is
   the right shape for rate-limited bulk work. This spec follows it.
5. **The dev key cannot run this at volume.** A dev key grants ~100 requests /
   2 min; a full seed+crawl pass is 1–3 weeks of continuous requests at that
   rate, and it competes directly with live lookups. So the crawler is **opt-in
   and off by default**, and even when enabled it is rate-capped to a fixed
   fraction of the budget. Meaningful per-patch freshness needs a production key.

**Scope boundaries:**

- **Backend only.** No frontend change. The endpoint's wire contract
  (`specs/champion-build-stats/` Requirements 10–13) is fixed and this spec must
  satisfy it exactly.
- **v1 crawl scope:** queue 420 (Ranked Solo/Duo) only; rank buckets
  `EMERALD_PLUS` / `DIAMOND_PLUS` / `MASTER_PLUS` plus the implicit `ALL`;
  region `world` only (no per-region seeding). These match the `meta` option
  sets the frontend already renders from.
- **Not in scope:** matchup/counter data, item win-rate deltas, timing data
  ("first item complete at"), a tier list, ARAM/Arena builds, multi-region.

## Glossary

- **Pipeline**: The seeder + crawler + extractor + aggregator, run by one
  background **Crawl_Worker** on a timer.
- **Crawl_Worker**: The single background component (a sibling of clash-scouting's
  Tournament_Refresher) that drives one **Crawl_Cycle** per tick.
- **Crawl_Cycle**: One pass of: refresh seeds if stale → pick the next batch of
  seed PUUIDs → crawl each one's new matches → aggregate → checkpoint.
- **Seed_Player**: A PUUID discovered from a ranked ladder, tagged with the
  **Rank_Bucket** it was found in and a `refreshedAt` timestamp.
- **Rank_Bucket**: `EMERALD_PLUS` / `DIAMOND_PLUS` / `MASTER_PLUS` (the frontend's
  fixed set) plus `ALL`. A player's tier is decided **once, from the ladder they
  were seeded from** — not re-derived per match — and each of their matches is
  folded into **every bucket at or below that tier** so the `_PLUS` labels are
  honest: an Emerald seed → `EMERALD_PLUS`; a Diamond seed → `EMERALD_PLUS` +
  `DIAMOND_PLUS`; a Master/GM/Challenger seed → all three.
- **Crawl_Budget_Fraction** (`CRAWL_BUDGET_FRACTION`, default 0.25): the share of
  a conservative `CRAWL_RPS` estimate the crawler self-limits to, via the
  **Crawl_Gate** token bucket. The gate sits in front of the crawler's client
  calls; `RateLimitManager.reserveSlot` (the real 429 backstop) runs opaquely
  inside `send()` and is the shared counter both crawler and live traffic hit.
- **Processed_Match**: A `matchId` that has already been folded into the
  aggregates. Recorded so a match is counted **exactly once** — double-counting
  would corrupt win rates.
- **Observation**: One participant's extracted build from one match — champion,
  role, win, the item path, skill order, rune page, spell pair, starting items.
- **Item_Path**: The first `Core_Item_Count` (3) completed items + boots a
  participant bought, in purchase order — the key an aggregate row groups by.
- **Aggregate_Doc**: One MongoDB document per `(championKey, role, Rank_Bucket,
  region, patch)`, holding `games` / `wins` counters and capped frequency
  sub-maps for item paths (and, nested under each, skill orders / rune pages /
  spell pairs / starting items).
- **Totals_Doc**: One document per `(role, Rank_Bucket, region, patch)` holding
  the total game count across **all** champions — the denominator for
  `meta.overall.pickRate`.
- **Patch**: `"major.minor"` derived from a match's `gameVersion`
  (`"16.17.412.9999"` → `"16.17"`).
- **Champion_Stats_Store**: The `ChampionStatsStore` interface from
  `specs/champion-build-stats/` task 2. This spec adds `MongoChampionStatsStore`.
- **Resolve_Builds**: The existing pure `resolveBuilds(cell)` from
  `backend/src/db/championStatsStore.ts` — picks `popular` / `highestWinRate`,
  applies the display floor / `MIN_SAMPLE` gate / modal threshold. Reused
  verbatim by the Mongo store.

## Requirements

### Requirement 1: The Crawl Worker

**User Story:** As the operator, I want a single background component that runs
the whole pipeline on a timer, so there is one thing to enable, observe and stop.

#### Acceptance Criteria

1. THE System SHALL expose a `CrawlWorker` with `start()` / `stop()`, constructed
   in the composition root and started at boot / stopped on `SIGTERM` / `SIGINT`,
   exactly as the Tournament_Refresher is.
2. THE Crawl_Worker SHALL run at most one Crawl_Cycle at a time — a tick that
   fires while a cycle is still running SHALL be skipped, not queued.
3. THE Crawl_Worker SHALL be **disabled by default**. It runs only when
   `CRAWLER_ENABLED` is truthy AND `MONGODB_URI` is set. With either unset,
   `start()` is a no-op and the site behaves exactly as it does today.
4. THE scheduler and clock SHALL be injected, so tests drive the worker with no
   real timers, matching every other timed component.
5. A cycle that throws SHALL be caught, logged, and SHALL NOT stop the worker —
   the next tick runs normally.
6. THE Crawl_Worker SHALL never be reachable from a request handler — no route,
   orchestrator or middleware holds a reference to it.

### Requirement 2: Seeding the player pool

**User Story:** As the pipeline, I want a refreshed pool of ranked PUUIDs to crawl
from, drawn from the actual ladders.

#### Acceptance Criteria

1. THE System SHALL discover Seed_Players from League-V4: the apex lists
   (Challenger / Grandmaster / Master) for `MASTER_PLUS`, and paged
   `entries/{queue}/{tier}/{division}` for `EMERALD_PLUS` / `DIAMOND_PLUS`
   (Emerald + Diamond tiers, all four divisions).
2. Seeding SHALL only run when the newest Seed_Player is older than `SEED_TTL`
   (default 7 days), and SHALL be bounded per refresh
   (`MAX_SEED_ENTRIES_PER_REFRESH`, default 1500 entries across all platforms and
   buckets) so one cycle cannot spend the whole budget on seeding.
3. Each Seed_Player SHALL be persisted with its PUUID, Rank_Bucket, and
   `refreshedAt`. A PUUID re-seeded in a different bucket SHALL update to the
   newer bucket.
4. League-V4 apex and entries calls SHALL go through the Crawl_Gate like every
   other crawler request.
5. WHEN seeding fails (network, rate cap, empty ladder), THE cycle SHALL continue
   with whatever seeds already exist — a failed refresh is retried next cycle,
   never fatal.
6. `region='world'` in v1 is a **DB label**, not a routing value. Seeding walks
   the ladders of a fixed constant set of platforms (`SEED_PLATFORMS`, default
   `['euw1', 'na1', 'kr']` — a spread of the big regions, not one) and Match-V5
   calls route via the existing `PLATFORM_TO_REGION` map. `RegionalRoutingValue`
   has no `world`. The platform set is a module constant, flagged for the
   per-region follow-up.

### Requirement 3: Crawling matches

**User Story:** As the pipeline, I want each seed player's *new* ranked matches
fetched, without ever re-fetching one already aggregated.

#### Acceptance Criteria

1. Per Seed_Player selected for a cycle, THE System SHALL fetch recent
   **queue-420** match ids (Match-V5 by-puuid on the seed's platform's regional
   routing value, `queue=420`, `count` = `CRAWL_MATCHES_PER_SEED`, default 20).
2. A match id that is a Processed_Match SHALL be skipped before any detail /
   timeline fetch.
3. For each remaining match id THE System SHALL fetch the **match detail** and
   the **match timeline** (2 Riot calls), both through the Crawl_Gate.
4. THE number of seed players processed per cycle SHALL be bounded
   (`CRAWL_SEEDS_PER_CYCLE`, default 25), so a cycle's Riot cost is bounded to
   roughly `CRAWL_SEEDS_PER_CYCLE × CRAWL_MATCHES_PER_SEED × 2` calls plus
   seeding.
5. A per-match failure — detail or timeline `{ kind: 'not_found' }` / `'error'` /
   `'network_error'`, a malformed body, or the match turning out not to be queue
   420 — SHALL be skipped without marking it Processed. A `{ kind: 'rate_limited' }`
   on any call SHALL abandon the whole cycle (Req 7.3), also without marking
   anything. A transient failure is retried next cycle; a wrong-queue match
   effectively never recurs (it won't re-appear in a 420-filtered id list).
6. Raw match detail and raw timeline SHALL be held only transiently — parsed,
   folded, discarded. Neither is written to any store or the in-memory cache.
7. Match-detail and timeline fetches on the crawl path SHALL **not** populate the
   shared `matchDetail` / request caches (a crawl of thousands of strangers'
   matches would evict every live user's working set). The crawler calls the
   Riot client directly, not `cacheOrFetch`.

### Requirement 4: Extracting an observation (pure)

**User Story:** As the pipeline, I want a pure function from (match detail,
timeline) to one Observation per human participant, testable without I/O.

#### Acceptance Criteria

1. THE extractor SHALL be a pure module — no network, no clock, no store, no
   logging — returning `Observation[]` (one per non-bot participant) or `[]` when
   the match is unusable (not queue 420, no `gameVersion`, no participants).
2. THE participant slot for the timeline SHALL be resolved by joining each
   `match.info.participants[i].puuid` to `timeline.info.participants[]`'s
   `{ participantId, puuid }` — **not** by assuming `participantId = i + 1`
   (`MatchTimelineDto`'s docstring forbids the shortcut). A participant whose
   `puuid` is `''` (a bot, or an unidentified slot) is skipped entirely, in both
   arrays.
3. Per human participant THE extractor SHALL derive:
   1. `championKey` (from `championName`), `role` (raw `teamPosition`; blank →
      folded only into the `role='ALL'` rows, per Req 5.2), `win`.
   2. `Item_Path` — `replayShopEvents(events, participantSlot).buildPath` from
      `insight/buildPath.ts`, filtered to `isCompletedItemId` (Requirement 4 of
      the completed-item module), first `Core_Item_Count`, in purchase order.
      Sold-then-rebought and sold-and-not-replaced completed items still count —
      the path is "what was built toward", not the final inventory.
   3. `skillOrder` — `extractSkillOrder(events, participantSlot)` → reduce to
      `{ maxOrder, perLevel }` via the shared `maxOrderFromSkillOrder` helper.
      `null` when the ability stream is empty.
   4. `runePage` — `runePageOf(participant)` (exported from `mapping.ts`). `null`
      when it comes back all-zeros (`primaryStyle === 0 && primarySelections
      empty`) — the same "unavailable" test the frontend `RunePageCard` applies,
      inlined here (the backend has no `isRunePageUnavailable`).
   5. `spellPair` — `[summoner1Id, summoner2Id]`; `null` if either is `0`/absent.
   6. `startingItems` — completed-item-filtered? **no** — the ids from
      `buildPath` with `timestamp <= STARTING_ITEMS_CUTOFF_MS` (module constant,
      90_000), **excluding** trinkets (3340/3363/3364) and consumables
      (2003 health potion, 2031/2033 refillable, 2055 control ward). A recall-and-
      reshop before 1:30 that pollutes this is accepted noise.
4. `patch` SHALL be `major.minor` of `info.gameVersion`; a match with no parseable
   `gameVersion` yields `[]`.
5. THE extractor SHALL be covered by property tests: every Observation's
   `Item_Path` is a length-≤`Core_Item_Count` subsequence of that participant's
   real completed-item purchases in order; a `puuid===''` slot never produces an
   Observation; a non-420 match produces `[]`.

### Requirement 5: Aggregating observations

**User Story:** As the pipeline, I want each Observation folded into the
`(champion, role, bucket, region, patch)` document via `$inc`, then the match
discarded.

#### Acceptance Criteria

1. Per Observation THE aggregator SHALL upsert the Aggregate_Doc for
   `(championKey, role, Rank_Bucket, region='world', patch)` with `$inc`:
   `games += 1`, `wins += (win ? 1 : 0)`, and, nested under the Observation's
   Item_Path key: that path's `games`/`wins`, and `+1` on the frequency of its
   skill-order / rune-page / spell-pair / starting-items values.
2. Each Observation SHALL be folded into every `(role, bucket)` combination it
   belongs to: role ∈ `{observed role, 'ALL'}` (the observed role only if it is
   one of the five `teamPosition` values, else just `'ALL'`) × bucket ∈ `{every
   bucket at or below the seed player's tier, incl. 'ALL'}` (Glossary). Net: 2–8
   Aggregate_Doc upserts per Observation.
3. Per **match** (not per Observation), THE aggregator SHALL `$inc` a Totals_Doc
   `matches` by 1 for each `(bucket, region='world', patch)` the match's seed
   player contributes to — the `meta.overall.pickRate` denominator is a **match
   count**, so `pickRate = championDoc.games / totalsDoc.matches` lands in the
   conventional "share of games featuring this champion" range, not 1/10 of it.
   (Totals are role-agnostic: pick rate is over all games in the bucket.)
4. Frequency sub-maps SHALL be **capped** (`MAX_FREQ_KEYS`, default 40 per map):
   once a map has that many keys, an unseen key is dropped rather than growing the
   document unbounded. (A build used in < 1/40 of a cohort is not a headline
   build.)
5. Sub-map keys SHALL be `.`-free and `$`-free (MongoDB field-name rules): item
   paths join ids with `-`; skill orders join `maxOrder` + `perLevel` with `_`;
   rune pages / spell pairs / starting items serialize similarly. A deterministic
   `serializeX` / `parseX` pair per value type, unit-tested for round-trip.
6. AFTER an Observation's four upserts succeed, the match SHALL be recorded as a
   Processed_Match. A match is aggregated **atomically per match** where possible
   (all its participants' upserts, then the processed-marker) so a mid-match crash
   does not double-count on retry; where a true transaction is unavailable on M0,
   the processed-marker write is last and a re-run tolerates the rare
   partial-then-reprocessed match as acceptable skew.
7. `lastUpdatedAt` on each touched Aggregate_Doc SHALL be set to the aggregation
   time, so `meta.lastUpdatedAt` reflects real recency.

### Requirement 6: `MongoChampionStatsStore`

**User Story:** As the endpoint, I want a `ChampionStatsStore` backed by the
Aggregate_Docs that satisfies the existing wire contract exactly.

#### Acceptance Criteria

1. THE System SHALL add `MongoChampionStatsStore` implementing
   `ChampionStatsStore` (`getBuildStats(championKey, filters)`), alongside the
   in-memory fake and no-op from `specs/champion-build-stats/` task 2.
2. `getBuildStats` SHALL:
   1. load every Aggregate_Doc for `championKey` (across buckets/roles at the
      latest patch) → `meta.availableRoles` / `availableRanks` (only values with
      `games > 0`, in the frontend's vocabulary order), `meta.defaultRole` (the
      non-`ALL` role with the most games, falling back to `ALL`),
      `meta.defaultRank` (`ALL` — the same constant the in-memory fake returns),
      `meta.availableRegions` (`['world']`), `meta.patch` / `meta.lastUpdatedAt`
      (from the newest doc);
   2. load the one Aggregate_Doc for the requested `(role, rank, world, patch)`,
      deserialize its frequency sub-maps back into the `ChampionAggregate`
      read-model shape (arrays of `{ value, games }` `CohortEntry`s, via the
      `serialize.ts` parsers; `pickRate` synthesized as `0` — `resolveBuilds`
      never reads it), and pass it to the **existing pure `resolveBuilds`** — no
      pick/gate/modal logic re-implemented here;
   3. read the Totals_Doc for `(rank, world, patch)` (role-agnostic) for
      `meta.overall.pickRate` = `cellDoc.games / totalsDoc.matches`;
      `overall.winRate` / `overall.totalGames` from the champion's own cell doc.
3. WHEN the store is reachable but has no doc for `championKey` at all,
   `getBuildStats` SHALL return `null` (→ endpoint empty-state, empty `meta`
   lists). WHEN it has the champion but not the exact filter combination, it
   SHALL return a result with populated `meta` lists and `popular: null` (filters
   still work). WHEN the Mongo read throws or times out, `getBuildStats` SHALL
   return `null` (fail-safe — the endpoint already degrades `null` to a 200
   empty-state and logs).
4. `getBuildStats` SHALL be bounded — a small fixed number of indexed `findOne` /
   `find` calls, no collection scan — and SHALL apply a short timeout so a slow
   Mongo cannot stall the endpoint past its own budget.
5. Startup index creation SHALL provision the Aggregate_Doc `_id` (or a compound
   `{championKey, role, rankBucket, region, patch}` unique index), the Totals_Doc
   key, `crawl_seeds` (`refreshedAt`, `rankBucket`), and `crawl_processed`
   (`matchId` unique + a TTL on `processedAt` so the seen-set is bounded —
   `PROCESSED_TTL`, default 120 days, longer than any match stays in a 20-deep
   recent list).

### Requirement 7: Sharing the rate budget

**User Story:** As a visitor, I want my lookup to be fast even while the crawler
is running.

#### Acceptance Criteria

1. Every crawler Riot call SHALL pass through the **Crawl_Gate** before
   `RateLimitManager.reserveSlot` — a token bucket refilling at
   `Crawl_Budget_Fraction` of a conservative estimate of the app's
   requests-per-second budget, so the crawler self-throttles well below the
   limit even if `reserveSlot` would allow more.
2. `RateLimitManager.reserveSlot` SHALL still be called for every crawler request
   (the Crawl_Gate is *additional*, not a replacement) — one counter of truth for
   Riot's headers.
3. WHEN a crawler Riot call returns `{ kind: 'rate_limited' }` (the client maps
   both a Riot 429 and the internal `RateLimitExceededError` to this — the error
   never escapes `send()`), the crawler SHALL treat it as a **soft stop**: abandon
   the current cycle, and try again next tick. It SHALL NOT retry-loop against a
   saturated limiter. The Crawl_Gate keeps this rare; it is the backstop.
4. Live-lookup requests SHALL NOT pass through the Crawl_Gate — it is
   crawler-only. A live lookup and the crawler share one `RateLimitManager`
   counter, so they contend on equal terms inside `reserveSlot`; the Crawl_Gate
   keeps crawler demand low enough that in practice the remainder is available to
   live traffic. **This is a statistical property, not a hard guarantee** — with
   one shared budget and no request-priority mechanism, a live burst during a
   crawl cycle can still queue briefly behind an in-flight crawler reservation.
   The mitigation is a conservative `CRAWL_RPS` and a low default fraction.
5. The operationally significant knobs — `CRAWLER_ENABLED`,
   `CRAWL_BUDGET_FRACTION`, `CRAWL_INTERVAL_MS`, `CRAWL_SEEDS_PER_CYCLE`,
   `CRAWL_MATCHES_PER_SEED`, `CRAWL_RPS` — SHALL be env vars with safe defaults,
   so the operator can dial the crawler down (or off) without a code change. The
   internal tuning constants (`MAX_FREQ_KEYS`, `KEEP_PATCHES`, `SEED_TTL`,
   `PROCESSED_TTL`, `STARTING_ITEMS_CUTOFF_MS`, `MAX_SEED_ENTRIES_PER_REFRESH`)
   stay as module constants — changing them is a code change with a test.

### Requirement 8: Retention and storage bounds

#### Acceptance Criteria

1. NO raw match, match detail, or timeline SHALL ever be persisted (Requirement
   3.6/3.7) — only Aggregate_Docs, Totals_Docs, `crawl_seeds`, `crawl_processed`.
2. Aggregate_Docs and Totals_Docs are keyed by `patch`. Patch handling is
   deliberately loose (operator does not care about strict per-patch accuracy):
   the store reads whatever the newest patch with data is; old-patch docs are
   pruned **opportunistically** — once per cycle, delete docs for any patch older
   than the newest minus `KEEP_PATCHES` (default 2) — a cheap `deleteMany`, not a
   correctness requirement. If a cycle skips the prune (rate cap, error), nothing
   breaks; storage just grows a little until the next successful prune.
3. `crawl_processed` is TTL-bounded (Requirement 6.5). `crawl_seeds` is bounded by
   the ladder size × buckets (~a few thousand rows) and is overwritten, not
   appended, on refresh.
4. Estimated steady-state footprint SHALL be documented in the README's Database
   section (~60–250 MB) with the calculation, matching
   `specs/champion-build-stats/` design.md's estimate.

### Requirement 9: Observability

#### Acceptance Criteria

1. THE Crawl_Worker SHALL log, per cycle, a single structured summary line:
   seeds refreshed, seed players processed, match ids seen / skipped-as-processed
   / fetched, observations aggregated, Riot calls made, and whether the cycle
   ended early (rate cap) — enough to tell from logs alone whether the crawler is
   making progress.
2. A `crawl_state` singleton document SHALL record `lastCycleAt`,
   `lastCycleSummary`, and a rolling `seedCursor` (which seed players to process
   next), so progress survives a restart and `MAX_SEEDS_PER_CYCLE` iterates the
   pool rather than re-processing the same players.
3. No secret, PUUID, or Riot ID SHALL appear in a log line — counts only. (PUUIDs
   are stored in `crawl_seeds` / `crawl_processed` as data, never logged, and
   cleared by nothing — they are ladder-public identifiers, not looked-up-user
   data, so `POST /api/privacy/delete` does not touch these collections; state
   that in the privacy handler comment.)

### Requirement 10: Rollout ordering

#### Acceptance Criteria

1. This spec SHALL be shippable with `CRAWLER_ENABLED` unset: the
   `MongoChampionStatsStore` is wired (replacing the no-op) but reads empty
   collections and returns `null`, so the endpoint / page behave exactly as they
   do today until the operator turns the crawler on and it has run for a while.
2. Turning the crawler on SHALL require only setting `CRAWLER_ENABLED=1` (and
   having `MONGODB_URI`) — no redeploy of new code, no migration.
3. The composition-root change (no-op → Mongo store) and the Crawl_Worker wiring
   SHALL land together, so there is never a build where the store is Mongo but
   nothing fills it *and* the operator expects data.

---

## Out of scope (candidate follow-ups)

- Per-region crawling and seeding (`meta.availableRegions` beyond `['world']`).
- Finer rank granularity than the three coarse buckets.
- Backfilling historical patches.
- A production-key deployment guide / autoscaling the crawler.
- Matchup / counter / situational-item / build-timing data.
- Deduplicating the ~10× redundancy of crawling a match once per seed participant
  in it (v1 accepts it; `crawl_processed` makes it correct, just not minimal).
