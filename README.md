# lolprofiles.gg

A League of Legends profile tracker. Enter a Riot ID (`gameName#tagLine`) — no region or server to pick — and get a profile report: ranked standing, recent-match stats, derived "fun facts", and improvement recommendations — all built from Riot's public APIs.

The interesting constraint here isn't the stats. It's that Riot's rate limits are enforced per API key, not per user, so every outgoing request funnels through a single rate-limit manager, and a cache sits in front of the API client for every sub-request.

---

## Contents

- [Architecture](#architecture)
- [Stack](#stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [API](#api)
- [Assets](#assets)
- [Regions](#regions)
- [Caching](#caching)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Known gaps](#known-gaps)
- [Riot compliance](#riot-compliance)

---

## Architecture

Two workspaces: a React SPA and a Node/Express API. **The frontend never talks to Riot and never sees the API key** — it only calls this project's own `/api/lookup`.

```
Browser (React SPA)
   │  POST /api/lookup  { riotId, platformOverride? }
   ▼
Backend API (Express + TypeScript)
   ├─ Validator ......... Riot ID shape, before any network call
   ├─ Region Resolver ... discovers the platform from the PUUID (Account-V1
   │                      region-by-game-by-puuid) — no visitor-chosen region
   ├─ Orchestrator ...... cache-or-fetch per sub-request, assembles the report
   │     ├─ Cache Store ....... TTL'd key-value (in-memory LRU)
   │     └─ Riot API Client ... 10s timeout, 429 retry w/ Retry-After
   │            └─ Rate Limit Manager ... one instance, per routing value
   └─ Insight Engine .... pure function over assembled data (no I/O)
   ▼
Riot Games APIs — Account-V1, Summoner-V4, League-V4, Match-V5
```

Four decisions worth calling out:

- **Cache-first orchestration.** The orchestrator checks the cache before the API client for *every* sub-request (account, region resolution, league, match IDs, each match detail). This is the main lever for both latency and staying inside Riot's windows on popular profiles.
- **The platform is discovered, not selected.** Account-V1 is global — it resolves a Riot ID to a PUUID regardless of where the player actually plays — so a visitor-chosen region used to produce a wrong-region 404 if they guessed wrong. The Region Resolver calls Account-V1's region-by-game-by-puuid endpoint instead, and every downstream call (League-V4, Match-V5, and Summoner-V4) routes off that answer. There is no region selector in the UI.
- **Centralised rate limiting.** All outgoing Riot requests reserve a slot from one `RateLimitManager`, which tracks Riot's `X-App-Rate-Limit` / `X-Method-Rate-Limit` headers. If the required wait exceeds 30s it fails fast rather than sitting on the request.
- **The Insight Engine is pure.** Once data is in memory, stats/fun-facts/recommendations are a function with no I/O — which is what makes the property-based tests possible.

## Stack

| | |
|---|---|
| Frontend | React 18, React Router 6, Vite 5, TypeScript 5.5 |
| Backend | Node.js, Express 4, TypeScript 5.5 |
| Testing | Vitest, Testing Library, fast-check (property-based), supertest |
| Tooling | npm workspaces, ESLint |

## Getting started

**Prerequisites:** Node.js 20+, npm 8+ (for workspaces), and a Riot API key from [developer.riotgames.com](https://developer.riotgames.com). Development keys expire every 24 hours.

```bash
git clone https://github.com/volcanio1/lolprofiles.gg.git
cd lolprofiles.gg
npm install
```

### Backend

There is no `.env` loader in the project yet (see [Known gaps](#known-gaps)), so export the key into the environment and run the compiled output:

```bash
cd backend
cp .env.example .env          # reference only — not read automatically
export RIOT_API_KEY=RGAPI-your-key-here
npm run build
npm start                     # listens on :3001
```

Check it's alive:

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

### Frontend

```bash
cd frontend
npm run dev                   # http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:3001`, which makes browser requests **same-origin** — so no CORS configuration is needed for local development. Override the proxy target with `VITE_DEV_BACKEND_ORIGIN` if your backend runs elsewhere.

## Environment variables

### Backend

| Variable | Required | Default | Notes |
|---|---|---|---|
| `RIOT_API_KEY` | Yes | — | Server-side only. Never commit a real key. |
| `PORT` | No | `3001` | |
| `CORS_ALLOWED_ORIGINS` | No | *(unset)* | Comma-separated list of **exact** origins. |
| `DDRAGON_VERSION` | Yes | — | Exact Data Dragon release pinned for champion/item/profile-icon assets, e.g. `16.17.1`. No `"latest"` alias — a moving version would change rendered assets without a deploy, so a missing or `"latest"` value fails fast at startup. Bump it by editing this value and redeploying; see [Assets](#assets) for what depends on it. |

There is deliberately no wildcard CORS option. `/api/lookup` is unauthenticated and spends the shared Riot rate-limit budget on a cache miss, so `*` would let any page on the internet consume it. Leave `CORS_ALLOWED_ORIGINS` unset for local development and same-origin deployments.

### Frontend

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VITE_API_BASE_URL` | No | `''` (same-origin) | Only set this if the API genuinely lives on another origin — and add that origin to `CORS_ALLOWED_ORIGINS` too. |
| `VITE_DEV_BACKEND_ORIGIN` | No | `http://localhost:3001` | Dev proxy target. |

## Scripts

Run from the repo root:

```bash
npm run build:backend    npm run build:frontend
npm run test:backend     npm run test:frontend
npm run lint:backend     npm run lint:frontend
```

Or from inside a workspace: `npm run dev`, `npm run build`, `npm test`, `npm run lint`, plus `npm run typecheck` / `npm run preview` on the frontend.

## API

### `POST /api/lookup`

```jsonc
// request
{ "riotId": "Faker#KR1" }
```

No region, no platform — the backend's Region Resolver works out where `Faker#KR1` actually plays from the Riot ID alone. `platformOverride` is also accepted (e.g. `"platformOverride": "kr1"`), but it's a diagnostic escape hatch that skips the resolver entirely; the default search UI never sends it, and `region`/`platform` are rejected outright as unknown fields rather than silently ignored, since a caller still sending either is working from a stale contract.

On success the response body **is** the `ProfileReport`, unwrapped:

```jsonc
{
  "riotId": { "gameName": "Faker", "tagLine": "KR1" },
  "puuid": "...",
  "summonerLevel": 700,
  "profileIconId": 6,
  "resolvedPlatform": "kr",
  "usedPlatformOverride": false,
  "stats": {
    "rankedByQueue": { "RANKED_SOLO_5x5": { "tier": "...", "division": "I", "winRatePercent": 58 } },
    "overallAverageKda": 3.42,
    "topChampions": [{ "championName": "Azir", "gamesPlayed": 12, "winRatePercent": 67, "averageKda": 4.1 }],
    "mostPlayedRole": "MIDDLE"
  },
  "funFacts": [{ "category": "timeOfDay", "text": "..." }],
  "recommendations": [{ "category": "visionControl", "text": "...", "metricName": "...", "metricValue": 0.8 }],
  "averageMatchDurationMinutes": 28.4,
  "limitedDataNotice": false,
  "partialDataWarning": false,
  "lastUpdated": "2026-01-01T00:00:00.000Z"
}
```

`summonerLevel` and `profileIconId` are `number | null` — Summoner-V4 is a non-blocking enrichment call, so either can come back `null` on an otherwise complete, successful report rather than failing the whole lookup.

Errors are wrapped in an `{ "error": { ... } }` envelope, so presence of `error` unambiguously means failure — no field of `ProfileReport` is named `error`. Each failure mode maps to its own status and message, with `retryAfterSeconds` on rate-limit errors and `maxRetries` on retriable upstream failures. Two codes are specific to region resolution: `NO_LOL_ACCOUNT` (the Riot account exists but has no League play history) and `UNSUPPORTED_PLATFORM` (Riot named a platform this build doesn't recognize yet, echoed in the `platform` field).

Validation happens before the orchestrator is invoked, so a malformed Riot ID **never** costs a Riot API call.

### `POST /api/privacy/delete`

Takes a `puuid`, evicts its cached data and scrubs its participant rows from retained match details. Returns `{ found, deletedAt }`. A PUUID with nothing cached returns `found: false` with a 200 — not an error. See [Known gaps](#known-gaps) before exposing this publicly.

### `GET /api/static-data`

```jsonc
// response
{ "dataDragonVersion": "16.17.1" }
```

Returns the pinned `DDRAGON_VERSION`. No Riot API call, no cache entry, and no rate-limit reservation — Data Dragon is a public CDN, not a rate-limited game API. The frontend uses the version to build champion, item and profile-icon URLs itself; see [Assets](#assets).

### `GET /health`

`{ "status": "ok" }`.

## Assets

Champion icons, the profile icon, item build images, summoner spell icons, and rune/rune-tree/stat-shard icons all come straight from Data Dragon, keyed to the version this deployment has pinned in `DDRAGON_VERSION`:

- The frontend calls `GET /api/static-data` once for the pinned version, then fetches `champion.json`, `item.json`, `summoner.json`, and `runesReforged.json` **directly from Data Dragon** and holds them in `localStorage` for 24 hours.
- Every image tag points straight at `https://ddragon.leagueoflegends.com/...` — **assets are hot-linked, never proxied or rehosted** through this backend. Data Dragon calls never touch the Rate Limit Manager, since it doesn't govern Riot's CDN.
- Every icon degrades to a same-sized placeholder rather than a broken image: an unresolved id, a `0` item slot (which is a real "empty" encoding, not a missing image), or a live CDN 404 all render an `AssetPlaceholder` instead of a torn `<img>`. This holds even if `GET /api/static-data` or the Data Dragon fetch fails outright — the report still renders in full, with placeholders in place of pictures.
- To bump the game version after a patch, update `DDRAGON_VERSION` and redeploy the backend; there is no automatic "latest" fallback, by design.

**Rune imagery is the one asset class `DDRAGON_VERSION` does not pin.** Rune, rune-tree, and stat-shard icon *files* are served from Data Dragon's unversioned image path (`/cdn/img/perk-images/...`) because the versioned path (`/cdn/{version}/img/perk-images/...`) returns HTTP 403 — verified against the live CDN, not assumed. This means a Riot art update can change how a rune icon looks without a redeploy here. What stays pinned is *which* rune an identifier resolves to: that mapping comes from `runesReforged.json`, which **is** fetched from the versioned path, so a patch cannot silently change which rune the report says a player selected — only what its icon looks like. Summoner spell icons are unaffected by this exception and remain fully version-pinned, same as champion and item icons.

**Two identifier-to-asset mappings in this codebase are not published anywhere and are only partially verified against real data:**

- **Stat shard icons** have no Data Dragon metadata at all. The identifier-to-file table is hand-maintained in `frontend/src/staticData/provider.ts`, and only 7 of its 9 rows have been confirmed against real match data (5001, 5005, 5007, 5008, 5010, 5011, 5013). `5002` (Armor) and `5003` (Magic Resist) have never been observed in a real match — they may be identifiers the game no longer assigns — and their rows carry no stronger guarantee than "the icon file exists at that path."
- **ARAM Mayhem augment icons** (queue 2400) come from Community Dragon (not Data Dragon — see below), keyed by an `id` in `cherry-augments.json` that this codebase *assumes* is the same id space Match-V5 reports in `playerAugment1`-`playerAugment6`. That assumption has never been checked against a real ARAM Mayhem match: the mode was not queueable on any account checked during development. Unlike the stat shard gap, a wrong id space here would silently mislabel every augment shown, not a handful of icons — treat `augmentIconUrl`/`augmentDisplayName` as unverified until a real queue-2400 match is checked, and re-run that check the first time the mode is confirmed active.

**Augment icons are served by Community Dragon, a separate Riot CDN, not Data Dragon.** Data Dragon publishes no augment data at all (verified 403 on every path tried). Community Dragon is pinned the same way — never `"latest"` — by deriving a `{major}.{minor}` pair from `DDRAGON_VERSION` (e.g. `16.17.1` → `16.17`), since Community Dragon's own versioning accepts that shorter form. Augment images are hot-linked from Community Dragon exactly as every other asset class is hot-linked from Data Dragon.

## Regions

There is no region selector — the visitor never picks one. Account-V1's by-riot-id endpoint is issued against a single fixed **Discovery_Region** (`americas`), because that endpoint is global and answers the same regardless of which regional host receives it. The Region Resolver then calls Account-V1's region-by-game-by-puuid endpoint to find the player's actual **Resolved_Platform**, and every other call routes off that answer: League-V4 and Summoner-V4 by the platform directly, Match-V5 by the region it belongs to.

The platform → region mapping is closed; a platform Riot reports outside it becomes an `UNSUPPORTED_PLATFORM` error rather than being guessed at.

| Regional routing | Platforms |
|---|---|
| `americas` | `na1`, `br1`, `la1`, `la2` |
| `europe` | `euw1`, `eun1`, `tr1`, `ru` |
| `asia` | `kr`, `jp1` |
| `sea` | `oc1` |

A resolved platform is cached for 24 hours (the `accountRegion` cache endpoint) — a player's server essentially never changes, so this is by far the longest-lived cache entry short of match details.

## Caching

| Endpoint | TTL | Why |
|---|---|---|
| Account-V1 (by-riot-id) | 1 hour | Riot ID → PUUID changes rarely |
| Account-V1 (region-by-puuid) | 24 hours | A player's platform essentially never changes |
| Summoner-V4 | **Not cached** | Non-blocking enrichment call (1,600/min granted), fetched fresh every lookup |
| League-V4 | 10 minutes | Rank changes per game |
| Match-V5 match IDs | 10 minutes | New matches appear |
| Match-V5 match detail | Indefinite | A completed match is immutable |

Cache keys are length-prefixed per segment so concatenation is injective — `{"a:b": "c"}` and `{"a": "b:c"}` can't collide.

## Testing

```bash
npm run test:backend
npm run test:frontend
```

32 backend test files, 18 frontend. Beyond conventional unit and integration tests (including supertest-driven route tests and an end-to-end pass over fakes), the backend carries **24 property-based invariants** in 11 `*.property.test.ts` files, each running 100–400 cases via fast-check — covering region-mapping closure, the win-rate and KDA formulas, top-champion ordering, tie-breaking, 429 retry bounds, cache key injectivity, TTL staleness, deletion idempotence, the guarantee that the API key never appears in client-facing output, and (added by `match-detail-tabs`) kill-participation bounds, participant-capture fidelity down to matches with fewer than ten players, PUUID absence, and the Enemy_Laner marker's correctness under a mirror pick. Each property test also asserts it actually exercised every branch it claims to, so degenerate coverage fails loudly.

No test touches the live Riot API, real credentials, real network, or real timers.

`frontend/src/domain/parity.test.ts` is worth knowing about: the Riot ID validation rules, the platform mapping table (kept for display labels, not for a selector), and the `ErrorCode` set necessarily exist in both workspaces, and the workspaces share no code — so that test reads the backend source as text and asserts the two copies agree. It's what would catch `NO_LOL_ACCOUNT`/`UNSUPPORTED_PLATFORM` (or the removed `PLAYER_NOT_ON_PLATFORM`) drifting out of sync between the two sides.

## Project layout

```
backend/src
├─ api/            # routes, error mapping, CORS, privacy endpoint
├─ config/         # env loading and validation
├─ validator/      # Riot ID parsing
├─ region/         # platform ↔ region mapping (region-by-platform reverse lookup)
├─ regionResolver/ # discovers a player's platform from their PUUID (cached)
├─ riotApiClient/  # HTTP to Riot, timeouts, 429 retries
├─ rateLimit/      # per-routing-value window tracking
├─ cache/          # TTL store, PUUID scrubbing
├─ orchestrator/   # cache-or-fetch, Riot schema mapping, runLookup
└─ insight/        # stats, funFacts, recommendations (pure)

frontend/src
├─ pages/          # SearchPage, ProfileReportPage
├─ components/     # SearchForm, ProfileReportView, MatchRow/MatchSide (the
│                  #   mirrored match row), DetailPanel + GeneralTab/RunesTab/
│                  #   BuildPathTab (its three tabs), CdnImage (shared asset
│                  #   primitive) + ChampionIcon/ProfileIcon/SummonerSpellIcon/
│                  #   RuneIcon/RuneTreeIcon/StatShardIcon, ItemBuildRow,
│                  #   AssetPlaceholder, LoadingIndicator, ErrorNotice
├─ hooks/          # useLookup
├─ api/            # lookupClient + wire types
├─ domain/         # Riot ID validation + platform display labels (parity-tested
│                  #   against the backend), participant grouping/ordering
│                  #   shared by the General and Runes tabs
├─ staticData/     # Static Data Provider — Data Dragon version/metadata, asset URLs
└─ compliance/     # RiotDataPage template, advertising policy

specs/                        # per-feature requirements, design, tasks (this repo has no .kiro/ directory)
```

The `specs/` directory holds, per feature, a requirements document, a design document, and an implementation task list — the code comments reference requirement numbers back to these.

## Known gaps

Stated plainly rather than left to be discovered:

- **Both routes are unauthenticated.** `/api/privacy/delete` accepts any PUUID and its scrubbing is *not* recoverable from cache — since match details are cached indefinitely, a scrubbed entry is effectively permanent while it stays cached. This needs an explicit decision before any public deployment.
- **`/api/lookup` spends a shared budget.** The rate limit manager guarantees the API key stays in good standing, but it can't stop an anonymous caller consuming the budget by requesting many distinct Riot IDs. Per-IP throttling is the mitigation and isn't implemented.
- **No `.env` loading.** The backend reads `process.env` directly with no `dotenv` dependency, and `npm run dev` invokes `ts-node`, which isn't installed. Use `npm run build && npm start` with the variable exported.
- **Performance targets are unverified.** The spec sets p95 ≤2s cached / ≤15s fresh. Unit tests can't prove that; it needs staging load testing, and no claim is made here.
- **Account cache keys are case-sensitive.** `Faker#KR1` and `faker#kr1` occupy separate entries, so a hot endpoint loses hit rate. Normalising the key would change the declared cache key params.

## Riot compliance

Riot ToS obligations are enforced at the service layer rather than left to page authors to remember:

- **Attribution** — `RiotDataPage` renders the required disclaimer for the whole time it displays Riot data, and every page showing Riot data uses that template.
- **No advertising** — the policy is inverted so it fails safe. `RiotDataPage` renders no ad slot unless handed an approved agreement, and there is exactly one place in the codebase where such an agreement can be introduced (hardcoded to `undefined`). Adding advertising requires a deliberate, reviewable edit to that file.
- **Bounded retention and deletion on request** — TTLs are the single source of truth in the cache store; deletion runs through `/api/privacy/delete`.
- **Assets served unmodified from Riot's own distribution** — champion, item, profile, summoner spell and rune icons are hot-linked from Data Dragon (see [Assets](#assets)) and never rehosted, altered or re-branded.

lolprofiles.gg isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc.
