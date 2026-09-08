# Design Document

## Overview

One background `CrawlWorker` (a sibling of clash-scouting's `TournamentRefresher`)
drives the pipeline on a timer. Each cycle: prune old-patch docs → refresh seeds
if stale → take the next `SEEDS_PER_CYCLE` seed players → per player, fetch new
queue-420 match ids, then per unprocessed match fetch detail + timeline, extract
one `Observation` per human participant (pure), fold each into four
`(champion, role, bucket, region, patch)` aggregate rows via `$inc`, mark the
match processed. All crawler Riot calls pass a `CrawlGate` token bucket *before*
`RateLimitManager.reserveSlot`, so the crawler self-throttles below its budget
fraction and live lookups always have headroom.

`MongoChampionStatsStore` reads those aggregate rows, deserializes one row into
the `ChampionAggregate` read-model shape, and hands it to the **existing pure
`resolveBuilds`** — no pick/gate/modal logic is re-implemented.

Nothing here is reachable from a request handler. The endpoint / page / dropdown
from `specs/champion-build-stats/` are unchanged.

---

## New / changed files

| File | Change |
|---|---|
| `backend/src/riotApiClient/index.ts` | **DONE (task 1).** New `LadderSource` interface (`getLeagueApex`, `getLeagueEntriesPage`) kept OFF `RiotApiClient`; `HttpRiotApiClient` implements both; `createRiotApiClient` → `RiotApiClient & LadderSource`. `getMatchIdsByPuuid` +optional `queue?`. `MatchDto['info']` +optional `gameVersion?`. `RIOT_METHODS.leagueApex`/`.leagueEntries`. |
| `backend/src/riotApiClient/matchProjection.ts` | **DONE (task 1).** copies `info.gameVersion` when a string. |
| `backend/src/orchestrator/mapping.ts` | **DONE (task 2).** `runePageOf` exported. |
| `backend/src/insight/completedItems.ts` | **new** — `isCompletedItemId(id)` + `BOOT_ITEM_IDS` over a bundled `COMPLETED_ITEM_IDS` set (generated from `item.json` at the pinned `DDRAGON_VERSION`, version-constant, regen script — the `championKeys.ts` pattern). |
| `backend/src/insight/skillOrder.ts` | **new** — `maxOrderFromSkillOrder(perLevel): ('Q'\|'W'\|'E')[]`, shared with the extractor; frontend copy cross-checked by an i/o table in `parity.test.ts`. |
| `backend/src/champions/pipeline/serialize.ts` | **new** — `.`/`$`-free `serialize`/`parse` for item paths, skill orders, rune pages, spell pairs, starting items; round-trip property-tested. |
| `backend/src/champions/pipeline/extractor.ts` | **new** — pure `extractObservations(matchDto, timelineDto): Observation[]`. |
| `backend/src/champions/pipeline/aggregator.ts` | **new** — `createAggregator({ db, now }).fold(observations, matchId): Promise<void>` — the `$inc` upserts + processed-marker + freq-map capping. |
| `backend/src/champions/pipeline/seeder.ts` | **new** — `createSeeder({ client, gate, db, now }).refreshIfStale(): Promise<SeedSummary>`. |
| `backend/src/champions/pipeline/crawlGate.ts` | **new** — `createCrawlGate({ rps, fraction, now, sleep? })`: `acquire(): Promise<void>` token bucket. |
| `backend/src/champions/pipeline/crawlWorker.ts` | **new** — `createCrawlWorker({ client, db, config, now, schedule?, logger? }).start()/.stop()`, runs one `runCycle()` per tick, one-at-a-time. NO `cache` — Req 3.7 forbids the crawl path touching any cache; it calls the client directly. |
| `backend/src/champions/pipeline/collections.ts` | **new** — collection names + `ensurePipelineIndexes(db)`. |
| `backend/src/db/championStatsStore.ts` | **+`MongoChampionStatsStore`** (replaces the `TODO` marker from `specs/champion-build-stats/` task 2.3). |
| `backend/src/db/client.ts` | `ensureIndexes` also calls `ensurePipelineIndexes`. |
| `backend/src/config/index.ts` | **+** `crawlerEnabled`, `crawlBudgetFraction`, `crawlIntervalMs`, `seedsPerCycle`, `matchesPerSeed` (all optional, defaulted). |
| `backend/src/index.ts` | wire `MongoChampionStatsStore` (was no-op); build + `.start()` the `CrawlWorker`; `.stop()` in the shutdown handler. |
| `backend/src/api/privacy.ts` | one-line comment: `crawl_seeds` / `crawl_processed` hold ladder-public PUUIDs, not looked-up-user data — nothing to delete. |
| `README.md` | Database section: 4 new collections + the storage calc; Environment table: the new vars; a short "Champion build pipeline" subsection; Known-gaps: the dev-key ceiling. |

---

## Riot client additions

```ts
// League-V4 apex — platform-routed, one call returns the whole list
getLeagueApex(platform, tier: 'challenger' | 'grandmaster' | 'master', queue: 'RANKED_SOLO_5x5')
  : Promise<RiotApiResult<LeagueListDto>>   // { entries: [{ puuid, ... }] }

// League-V4 paged entries — platform-routed
getLeagueEntriesPage(platform, queue, tier: 'EMERALD' | 'DIAMOND', division: 'I'|'II'|'III'|'IV', page: number)
  : Promise<RiotApiResult<LeagueEntryDto[]>>  // [] past the last page

// existing, +queue
getMatchIdsByPuuid(region, puuid, count, queue?: number)   // ?queue=420
```

`gameVersion` added to `MatchDto['info']` + `projectMatchDto` — a small additive
change, same shape as `championId` being added for clash-scouting.

All four go through the same `send()` policy. New `RIOT_METHODS.leagueApex` /
`.leagueEntries` for the rate-limiter's per-method tracking.

---

## The CrawlGate

A token bucket, crawler-only, sitting **in front of the crawler's client
calls**. It is an **open-loop throttle** — it has no view of live contention and
no view of `reserveSlot` (which runs privately inside `send()`). It bounds
crawler *demand* to a known rate; it does not and cannot guarantee live traffic
is never delayed. The real 429 backstop is `reserveSlot` + the shared counter.

```ts
createCrawlGate({ rps, fraction, now, sleep }): { acquire(): Promise<void> }
```

- `capacity = max(1, round(rps * fraction))`, refill `rps * fraction` tokens/sec.
- `acquire()` waits until a token is available, then consumes one.
- `rps` = `CRAWL_RPS`, a **conservative constant** for the app's sustained budget
  — deliberately an underestimate, so `fraction` of it is genuinely spare.

Every seeder / crawler Riot call: `await gate.acquire()` then the client call.
**The soft stop keys on the result, not an exception:** the client maps a Riot
429 (and its own internal `RateLimitExceededError`) to `{ kind: 'rate_limited' }`
— it never throws that error out of `send()`. So `runCycle` checks
`result.kind === 'rate_limited'` after *every* crawler call and, on a hit,
abandons the cycle (`endedEarly: true`); the worker logs it and waits for the
next tick. An optional extra brake: after an early stop, the next cycle's
interval is doubled (capped) until a clean cycle.

---

## Data model (MongoDB — this spec owns these shapes)

### `champion_build_aggregates`

```
_id: "<championKey>|<role>|<rankBucket>|<region>|<patch>"   // role/rankBucket may be "ALL"
championKey, role, rankBucket, region, patch                 // also as fields, for find()
games: <int>, wins: <int>
lastUpdatedAt: <Date>
itemPaths: {
  "3006-3031-3036": {
    games: <int>, wins: <int>,
    skills:  { "QWE_1.3.2.1": <int>, ... },     // serialize.ts keys, capped at MAX_FREQ_KEYS
    runes:   { "<serialized rune page>": <int>, ... },
    spells:  { "4-7": <int>, ... },
    starts:  { "1055-2003": <int>, ... }
  },
  ...   // capped at MAX_FREQ_KEYS item paths
}
```

Aggregation write per Observation — one `updateOne(..., { upsert: true })` per
`(role, rankBucket)` the Observation rolls into (Req 5.2: role ∈ {observed,
`ALL`}, bucket ∈ {every bucket ≤ the seed's tier} ∪ {`ALL`} → 2–8 writes):

```
$inc: {
  games: 1, wins: <0|1>,
  "itemPaths.<pk>.games": 1, "itemPaths.<pk>.wins": <0|1>,
  "itemPaths.<pk>.skills.<sk>": 1,
  "itemPaths.<pk>.runes.<rk>": 1,
  "itemPaths.<pk>.spells.<spk>": 1,
  "itemPaths.<pk>.starts.<stk>": 1
}
$set: { championKey, role, rankBucket, region, patch, lastUpdatedAt: now }
```

The seed player's tier → buckets: `EMERALD → [EMERALD_PLUS]`; `DIAMOND →
[EMERALD_PLUS, DIAMOND_PLUS]`; `MASTER|GRANDMASTER|CHALLENGER → [EMERALD_PLUS,
DIAMOND_PLUS, MASTER_PLUS]`. Every list also gets `ALL`.

**Cap enforcement** can't be expressed in one `$inc`. Two-step per doc per cycle
batch: read the doc's current key sets once, and for a key that would be new when
the map is already at `MAX_FREQ_KEYS`, drop that `$inc` path from the update.
Approximate (a race can momentarily exceed the cap by the batch size); acceptable
— the cap is a storage guard, not a correctness invariant.

### `champion_build_totals`

```
_id: "<rankBucket>|<region>|<patch>"      // role-agnostic
rankBucket, region, patch, matches: <int>
```

`$inc: { matches: 1 }` **once per crawled match** per bucket the match's seed
player rolls into (e.g. a Diamond seed's match bumps `EMERALD_PLUS`,
`DIAMOND_PLUS` and `ALL`). Denominator for `meta.overall.pickRate =
cellDoc.games / totalsDoc.matches` — a match count, so the ratio is the
conventional "share of games featuring this champion", not 1/10 of it (a champion
appears in ≈1 participant slot per match it's in).

### `crawl_seeds`

```
_id: <puuid>
rankBucket: "EMERALD_PLUS" | "DIAMOND_PLUS" | "MASTER_PLUS"
refreshedAt: <Date>
```

Overwritten on refresh (`updateOne({_id:puuid}, {$set:{rankBucket, refreshedAt}}, {upsert:true})`).

### `crawl_processed`

```
_id: <matchId>
processedAt: <Date>    // TTL index, PROCESSED_TTL (120 d)
```

### `crawl_state`

```
_id: "singleton"
lastCycleAt: <Date>
lastCycleSummary: { ... the log line's fields ... }
seedCursor: <int>     // index into an ordered seed scan, wraps
patchesSeen: [ "16.17", "16.16" ]
```

### Indexes (`ensurePipelineIndexes`)

- `champion_build_aggregates`: `{ championKey: 1, patch: 1 }` (the "all docs for a
  champion" read), unique `{ championKey:1, role:1, rankBucket:1, region:1, patch:1 }`.
- `champion_build_totals`: `_id` is the key.
- `crawl_seeds`: `{ refreshedAt: 1 }`, `{ rankBucket: 1 }`.
- `crawl_processed`: `{ processedAt: 1 }` TTL `expireAfterSeconds: PROCESSED_TTL`.

---

## The extractor (pure)

```ts
interface Observation {
  championKey: string;
  role: string;            // raw teamPosition; '' allowed
  win: boolean;
  patch: string;           // "16.17"
  itemPath: readonly number[];        // ≤ 3, completed items + boots, purchase order
  skillOrder: { maxOrder: ('Q'|'W'|'E')[]; perLevel: (1|2|3|4)[] } | null;
  runePage: RunePage | null;
  spellPair: readonly [number, number] | null;
  startingItems: readonly number[] | null;
}

function extractObservations(match: MatchDto, timeline: MatchTimelineDto): Observation[]
```

- `match.info.queueId !== 420` → `[]`. No `gameVersion` → `[]`.
- Build `slotByPuuid` from `timeline.info.participants[]` (`{participantId,
  puuid}`) — the **authoritative** slot map (`MatchTimelineDto`'s docstring
  forbids `i + 1`).
- Per `match.info.participants[i]` with a non-empty `puuid`:
  - `slot = slotByPuuid.get(participant.puuid)`; skip if absent.
  - `events = timeline.info.frames.flatMap(f => f.events)`.
  - `replayShopEvents(events, slot).buildPath` → filter to `isCompletedItemId`,
    take first 3 → `itemPath`.
  - `startingItems` = `buildPath` ids with `timestamp <= STARTING_ITEMS_CUTOFF_MS`
    (90_000), minus trinkets (3340/3363/3364) and consumables
    (2003/2031/2033/2055).
  - `extractSkillOrder(events, slot)` → `number[]` → `maxOrderFromSkillOrder` →
    `{ maxOrder, perLevel }`; `null` if the ability stream is empty.
  - `runePageOf(participant)` → `null` when `primaryStyle === 0 &&
    primarySelections.length === 0` (inline the frontend's `isRunePageUnavailable`
    check — the backend has no such function).
  - `spellPair = [summoner1Id, summoner2Id]`; `null` if either is `0`/absent.

Reuses `replayShopEvents`, `extractSkillOrder` (both in `insight/buildPath.ts`),
`runePageOf` (now exported from `mapping.ts`). `maxOrderFromSkillOrder` is a new
shared pure helper (`insight/skillOrder.ts`); the frontend's copy in
`SkillOrderView.tsx` is cross-checked by an input→output table in
`frontend/src/domain/parity.test.ts` (a function body can't be text-compared).

---

## `MongoChampionStatsStore.getBuildStats`

```
1. latestPatch = max patch across this champion's docs  (find({championKey}).project({patch}))
   — if none, return null.
2. champDocs = find({ championKey, patch: latestPatch })            // small: ≤ roles×buckets
   meta.availableRoles  = distinct roles with games>0, ordered ROLE_VALUES
   meta.availableRanks   = distinct rankBuckets with games>0, ordered RANK_BUCKET_VALUES
   meta.defaultRole      = (non-ALL role with max games) ?? 'ALL'
   meta.defaultRank      = 'ALL'                       // same as the in-memory fake
   meta.availableRegions = ['world']
   meta.patch, meta.lastUpdatedAt = from newest champDoc
3. cell = champDocs.find(d => d.role===filters.role && d.rankBucket===filters.rank)
   toChampionAggregate(cell): deserialize cell.itemPaths -> ItemPathAggregate[]
     (each { coreItems: parseItemPath(key), games, wins,
       skillOrders/runePages/spellPairs/startingItems:
         Object.entries(map).map(([k,g]) => ({ value: parseX(k), games: g })) }),
     plus games/wins from the cell and pickRate: 0 (resolveBuilds never reads it)
   { popular, highestWinRate } = resolveBuilds(cell ? toChampionAggregate(cell) : null)  // EXISTING pure fn
4. totalsDoc = findOne({ _id: `${filters.rank}|world|${latestPatch}` })   // role-agnostic
   meta.overall = {
     winRate:  cell && cell.games>0 ? cell.wins/cell.games : 0,
     pickRate: totalsDoc && totalsDoc.matches>0 && cell ? cell.games / totalsDoc.matches : 0,
     totalGames: cell ? cell.games : 0,
   }
5. return { meta, popular, highestWinRate }
```

`toChampionAggregate` needs `ChampionAggregate` to permit a synthetic
`pickRate: 0` — it already declares `pickRate: number`, so this is just supplying
it; `resolveBuilds` uses `cell.games` (not `cell.pickRate`) for the display-floor
gate and the per-build `pickRate = pathGames / cell.games`.

- 3–4 indexed reads, all `findOne` / a bounded `find`. Wrap in
  `Promise.race([..., timeout])` (~500 ms) → on timeout/throw, `return null`.
- The `ChampionAggregate` / `resolveBuilds` / `CohortEntry` types are imported
  from `championStatsStore.ts` — nothing new in the read model.

---

## Composition root

```ts
const championStatsStore: ChampionStatsStore = databaseClient.enabled
  ? new MongoChampionStatsStore(databaseClient.db(), now)      // was createNoopChampionStatsStore()
  : createNoopChampionStatsStore();

const crawlWorker = createCrawlWorker({
  client: riotApiClient,   // RiotApiClient & LadderSource
  db: databaseClient.enabled ? databaseClient.db() : null,
  config: {
    enabled: config.crawlerEnabled && databaseClient.enabled,
    intervalMs: config.crawlIntervalMs,
    budgetFraction: config.crawlBudgetFraction,
    rps: config.crawlRps,
    seedsPerCycle: config.seedsPerCycle,
    matchesPerSeed: config.matchesPerSeed,
  },
  now,
});
crawlWorker.start();     // no-op unless enabled  (no `cache` — Req 3.7)

// shutdown handler (alongside tournamentRefresher.stop() + databaseClient.close())
crawlWorker.stop();
```

---

## Testing

- `crawlGate.test.ts` — capacity, refill rate, `acquire` waits then proceeds
  (injected `sleep`/`now`); N acquires over T seconds ≈ `rps*fraction*T`.
- `serialize.test.ts` — round-trip for every value type; keys are `.`/`$`-free;
  property test over random builds.
- `extractor.test.ts` + `.property.test.ts` — real Match-V5 + timeline shaped
  fixture: one Observation per human, none for bots, `[]` for non-420 / no
  gameVersion; property: itemPath ⊆ real purchases, prefix-bounded.
- `aggregator.integration.test.ts` (mongo-integration, `mongo:7`) — a Diamond-tier
  Observation writes the `{role, EMERALD_PLUS/DIAMOND_PLUS/ALL}` + `{ALL, …}` rows
  (2×3 = 6 aggregate docs), the match bumps the 3 bucket totals by 1, the
  processed marker is written; a re-fold of the same match is a no-op; the
  freq-map cap holds after `MAX_FREQ_KEYS + 5` distinct paths.
- `seeder.test.ts` — apex + entries paging into `crawl_seeds`; stale check;
  bounded per cycle; a failed ladder call doesn't throw.
- `crawlWorker.test.ts` — one cycle end to end with a faked client + in-memory
  Mongo double (or mongo-integration): seeds → crawl → aggregate → processed →
  summary; a second cycle skips processed matches; a throwing cycle doesn't stop
  the worker; disabled → `start()` is inert.
- `championStatsStore.test.ts` (extend) — `MongoChampionStatsStore` against
  `mongo:7`: unknown champion → `null`; champion-but-not-filter → `meta` +
  `popular:null`; a seeded doc → `resolveBuilds` output matches the in-memory
  fake for the same data; a read timeout → `null`.
- `endToEnd` / `app.test` fan-out: the composition root now builds a real store —
  keep the `MONGODB_TEST_URI`-gated pattern; without it, `databaseClient.enabled`
  is false → no-op store, existing behaviour.

---

## Deliberate deviations / interpretation choices (flag for the user)

_(Audit-driven revisions folded in 2026-09-08 — the spec now reflects these.)_

1. **`isCompletedItemId` on the backend.** No Data Dragon item data on the
   backend today. Proposed: **(a) a generated completed-item id set** bundled +
   version-pinned like `championKeys.ts` (regen script from `item.json`). It's
   pinned at one `DDRAGON_VERSION` while the crawler aggregates recent patches —
   an item reworked component↔legendary between the pin and a crawled patch is
   misclassified; accepted, regen on deploy.
2. **`STARTING_ITEMS_CUTOFF_MS = 90_000`, `MAX_FREQ_KEYS = 40` (may drop to 25 for
   M0 headroom), `KEEP_PATCHES = 2`, `SEED_TTL = 7d`, `PROCESSED_TTL = 120d`,
   `SEED_PLATFORMS = ['euw1','na1','kr']`** — this design's numbers.
3. **Tier from the seed ladder; each match rolled into every bucket ≤ that tier**
   (revised — was "bucket only its own"). Makes `EMERALD_PLUS` etc. honest.
4. **`pickRate` denominator is a per-match count** in a role-agnostic
   `champion_build_totals` doc (revised — was per-observation per-(role,bucket),
   which is ~10× understated). `meta.overall.pickRate = cell.games /
   totalsDoc.matches`.
5. **`participantId` via the timeline's `info.participants[]` puuid join**
   (revised — the `i + 1` shortcut is forbidden by `MatchTimelineDto`'s
   docstring).
6. **Soft stop keys on `result.kind === 'rate_limited'`**, not a thrown
   `RateLimitExceededError` (which the client never lets escape `send()`).
7. **The CrawlGate is an open-loop throttle.** "Live traffic always has headroom"
   is a *statistical* property given one shared `RateLimitManager` and no request
   priority — not a hard guarantee. Mitigation: conservative `CRAWL_RPS`, low
   default fraction, cycle-interval backoff after a rate-limited stop.
8. **10× redundant crawling** across cycles (a match with 3 seeded participants
   fetched 3×). `crawl_processed` keeps aggregation correct; the fetches are
   wasted. A per-cycle in-memory seen-set removes the intra-cycle waste (task
   13.2 does this); cross-cycle dedup is optional 19.1.
9. **Freq-map cap is approximate** (single sequential worker → effectively no
   race). One consequence: `cell.games ≠ Σ itemPaths.games` when a new path is
   dropped, so per-build pick rates don't sum to 1. Inherent to any capped
   design.
10. **Bot detection = `puuid === ''`** (the only signal surviving `projectMatchDto`).
11. **M0 supports transactions** (3-node replica set) — Req 5.6's fallback
    (processed-marker last, tolerate rare re-process skew) is a *simplicity*
    choice, not forced by the tier.
12. **README storage calc** must show the fat-doc math (`{ALL,ALL}` + main-role
    docs for meta champions sit near the `MAX_FREQ_KEYS` cap): ~1,500 fat docs ≈
    150–250 MB + a sparse long tail; worst case (every doc at cap) would not fit
    M0, which is why the cap + prune are load-bearing.
