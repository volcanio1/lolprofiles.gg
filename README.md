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
- [Deployment](#deployment)
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

Two workspaces: a React SPA and a Node/Express API. **The frontend never talks to Riot and never sees the API key** — it only calls this project's own `/api/*` endpoints.

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
Riot Games APIs — Account-V1, Summoner-V4, League-V4, Match-V5, Spectator-V5, Champion-Mastery-V4
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

The backend loads `backend/.env` on startup (via `dotenv`). Copy the example, fill it in, and run the compiled output (`npm run dev` is currently broken — see [Known gaps](#known-gaps)):

```bash
cd backend
cp .env.example .env          # then edit: set RIOT_API_KEY and DDRAGON_VERSION
npm run build
npm start                     # listens on :3001
```

`.env` is gitignored. Environment variables set in the shell still take precedence over the file.

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
| `FRONTEND_DIST` | No | *(unset)* | Path to the built frontend (`../frontend/dist`). When set, the API process also serves the SPA **with a history fallback**, so a hard refresh of `/profile` returns `index.html` instead of a 404. Leave unset when a CDN or reverse proxy serves the frontend — configure the fallback there instead (see [Deployment](#deployment)). |
| `MONGODB_URI` | No | *(unset)* | MongoDB connection string for the [persistent store](#database). **Unset disables it entirely** — the site runs exactly as it did before the store existed. A set-but-unreachable value logs one line at startup (credentials stripped) and also runs disabled; it never crashes the process. Only used for rank-history and player-autocomplete data — never for caching. |

The backend reads `.env` on startup (via `dotenv`), so a local `backend/.env` works; it is gitignored — never commit real secrets.

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

## Deployment

The frontend is a **history-mode SPA**: `/profile`, `/test`, and the catch-all 404 route exist only in the browser router, not as files on disk. Every host that serves `frontend/dist` must send `index.html` for any path that isn't a real built file — otherwise a hard refresh or a shared deep link 404s before the app ever loads. Client-side navigation still works without this because React Router intercepts it; a refresh doesn't, because the request reaches the server.

Pick whichever matches how you serve the build:

| How the build is served | What to configure |
|---|---|
| **The API process** (single origin) | Set `FRONTEND_DIST=../frontend/dist`. It serves hashed assets with a one-year immutable cache, `index.html` as `no-cache`, and falls back to `index.html` for any non-`/api`, non-`/health` GET. Nothing else to do. |
| **Netlify / Cloudflare Pages** | `frontend/public/_redirects` (`/*  /index.html  200`) is copied into `dist` on build — already in the repo. |
| **Vercel** | `frontend/vercel.json` rewrites everything except `/api/*` to `/index.html` — already in the repo. |
| **nginx** | `location / { try_files $uri /index.html; }` — and proxy `/api` to the backend before that block. |
| **Caddy** | `try_files {path} /index.html` in the site block, with a `handle /api/*` reverse-proxy ahead of it. |

A genuinely unknown URL (a typo, a dead link) still lands on the in-app 404 page — it just arrives with a `200` and the app renders the "No match" screen client-side, which is the normal SPA tradeoff.

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

### `GET /api/match/:matchId/build-path`

```
GET /api/match/EUW1_7231636281/build-path?gameName=Faker&tagLine=KR1
```

Reconstructs one player's **build path** for one match — the ordered sequence of item purchases, with the game time each happened at — from Match-V5's timeline endpoint. `gameName`/`tagLine` are validated through the same Riot ID Validator the lookup route uses; the region is derived from the match id's platform prefix, so no Region Resolver call is made.

`200` for both outcomes — a match with no timeline is normal, not an error:

```jsonc
// build path found
{ "kind": "build_path",
  "buildPath": [
    { "itemId": 1055, "timestamp": 11000 },
    { "itemId": 1036, "timestamp": 65000, "soldAt": 540000 },
    { "itemId": 3078, "timestamp": 480000 }
  ],
  "skillOrder": [1, 2, 1, 3, 1, 4],   // ability leveled at each level-up: 1=Q 2=W 3=E 4=R
  "reconciled": true }

// no timeline for this match, or the player isn't in it
{ "kind": "unavailable", "reason": "no_timeline" }   // or "participant_absent"
```

`timestamp` is when the item was bought (ms from match start); `soldAt` (present only if the item was sold) is when it was sold. The frontend merges buys and sales into one timeline — a sold item shows a buy node at its buy time and a separate "sold" marker at the sell time. `skillOrder` is the ability chart, from the timeline's `SKILL_LEVEL_UP` events. The frontend draws the path as a wrapping left-to-right flow chart (trinket appended) with a skill-order grid above it.

`reconciled` is `false` only when the replay genuinely can't be squared with the match's reported final build (a reconstruction bug) — the path is still returned, with a caveat in the UI, and the diff logged server-side. Boots, trinkets and Seeker's Armguard are excluded from the check, because the game transforms them in place with no purchase event the timeline records; see `specs/item-timeline/design.md`. Reconciliation reads the match detail from cache and fetches it once on a miss.

**Scope is one-sided by design.** A build path is retrieved and shown **for the analyzed player only**. The lane opponent continues to show the final-inventory build already in the match row — no timeline data is extracted for them. This is a product decision, not a technical limit; the extraction is written per-participant so adding the opponent later is a parameter change.

**Retention.** The 0.3–1 MB (and up) raw timeline is **never cached** — there is no cache entry type for it. It is parsed, reduced to a ~2 KB `timelineSlice` (that one player's build path + the reconciled flag, keyed `{ matchId, puuid }`), and discarded. The slice is retained **indefinitely**, by the same immutability argument as match details. The number of timelines being parsed at once is bounded (default 4) so a burst of requests can't run dozens of multi-megabyte `JSON.parse` calls concurrently — the rate limiter doesn't govern that, since the granted limit is 2,000 calls / 10s.

The frontend fetches this **only when the Build Path tab of an expanded match is selected** — never during report assembly, never on row expansion.

### `GET /api/live-game`

```
GET /api/live-game?gameName=Faker&tagLine=KR1
```

Reports the game a player is **in right now**. `gameName`/`tagLine` are validated through the same Riot ID Validator as the lookup route; the platform is discovered from the PUUID (Region Resolver), so no region is supplied. Spectator-V5's active-games endpoint gives ten PUUIDs and champion ids and nothing else — every name, rank and mastery figure is joined onto that skeleton per participant from Account-V1, League-V4 and Champion-Mastery-V4.

`200` for both outcomes — **not being in a game is a state, not an error**:

```jsonc
// in a game
{ "kind": "in_game",
  "lobby": {
    "gameId": 987654, "platformId": "NA1",
    "matchId": "NA1_987654",          // the id the finished game will be published under
    "queueId": 420, "mapId": 11,
    "gameStartTime": 1700000000000,   // epoch ms, or null for champion select (Pre-Game)
    "bannedChampionIds": [200, 51],
    "participants": [
      { "puuid": "...", "teamId": 100, "championId": 266,
        "spell1Id": 4, "spell2Id": 7, "perkIds": [8005, 9111],
        "isBot": false,
        "riotId": { "gameName": "...", "tagLine": "NA1" },  // null if enrichment failed / bot
        "rankedEntries": [ { "queueType": "RANKED_SOLO_5x5", "tier": "GOLD", "division": "II",
                             "leaguePoints": 40, "wins": 12, "losses": 8 } ],
        // rankedEntries is [] for a successful "unranked", null if the League-V4 call failed
        "championMasteryPoints": 60000, "championMasteryLevel": 7 }
      // ... 9 more, in Spectator-V5's order
    ],
    "insights": {
      "offChampion": ["puuid-a"],   // < 10,000 mastery on the locked champion, and some record exists
      "oneTricks":   ["puuid-b"],   // >= 200,000 mastery on the locked champion
      "rankSpread":  { "highest": "DIAMOND", "lowest": "SILVER" }  // null when < 2 participants are ranked in the game's queue
    }
  }
}

// not currently in a game
{ "kind": "not_in_game" }
```

**A failed enrichment call degrades one field, never the card or the lobby** — a card always renders, with the failed field absent. Bot participants get a card with every enrichment field absent and no call issued. The frontend polls this endpoint no more often than **every 30 seconds** while the lobby is on screen, ticks the game clock locally between polls, and switches to a game-ended state when a lobby it was showing returns `not_in_game`.

### `GET /api/players/suggest`

```
GET /api/players/suggest?q=fak&limit=8
```

As-you-type autocomplete for the search box. Returns players whose `gameName` (case-insensitive) starts with `q`, drawn **only** from this site's own `looked_up_players` history — Riot has no name-search endpoint, so a name nobody has looked up here does not appear (a cold-start limitation, not a bug). `limit` is clamped to `1..8` and defaults to `8`.

```jsonc
// response — a bare array, most-recently-looked-up first
[
  { "gameName": "Faker",    "tagLine": "KR1", "profileIconId": 6, "region": "kr" },
  { "gameName": "fakerino", "tagLine": "EUW", "profileIconId": null, "region": "euw1" }
]
```

`puuid` and `lastLookedUpAt` are never included. **Always `200`** — a `q` that is absent, shorter than 2 characters, or contains a `#` returns `[]` (a field mid-typing is a normal state, not a client error), and so does a disabled or failing [persistent store](#database). No Riot API call, no rate-limit reservation, no shared budget — one indexed prefix scan. When `MONGODB_URI` is unset the endpoint always returns `[]` and the dropdown simply never appears.

### `GET /api/players/report`

```
GET /api/players/report?gameName=Faker&tagLine=KR1
```

Serves the most recent stored `ProfileReport` for a player so that **picking them from the autocomplete dropdown renders instantly**, without a live lookup. It resolves the Riot ID to a PUUID from `looked_up_players` (case-insensitive, exact — no Riot call) and reads that PUUID's `profile_reports` snapshot.

```jsonc
// a fresh snapshot (< 15 days old)
{ "source": "cache", "report": { /* the full ProfileReport */ }, "fetchedAt": "2026-08-27T09:12:04.000Z" }

// nothing usable stored — the client then runs a normal live lookup
{ "source": "miss" }
```

**Always `200`.** `miss` covers every non-hit: an unknown Riot ID, no snapshot, a snapshot ≥ 15 days old, a blank parameter, a disabled store, and a store read failure. No Riot API call, no rate-limit reservation.

Only a **dropdown selection** consults this endpoint — a Riot ID typed by hand always runs a live lookup. The `?src=suggest` marker the search page adds to the report URL triggers the cache-first path and is stripped after the first render, so a shared or reloaded link always goes live. The report view carries a "Refresh" button (disabled for 5 minutes after the data was fetched) that re-runs the live lookup and overwrites the snapshot.

### `POST /api/privacy/delete`

Takes a `puuid`, evicts its cached data, scrubs its participant rows from retained match details, and (when the [persistent store](#database) is enabled) deletes its `rank_snapshots`, `looked_up_players` and `profile_reports` rows. Returns `{ found, deletedAt }` — `found` is `true` if *any* store removed something; row counts are deliberately not exposed. A PUUID with nothing stored returns `found: false` with a 200 — not an error. A persistent-store outage does not fail the request (the cache half still runs). See [Known gaps](#known-gaps) before exposing this publicly.

### `GET /api/static-data`

```jsonc
// response
{ "dataDragonVersion": "16.17.1" }
```

Returns the pinned `DDRAGON_VERSION`. No Riot API call, no cache entry, and no rate-limit reservation — Data Dragon is a public CDN, not a rate-limited game API. The frontend uses the version to build champion, item and profile-icon URLs itself; see [Assets](#assets).

### `GET /health`

`{ "status": "ok" }`.

## Assets

Champion icons, the profile icon, item build images (final builds and build-path timelines alike), summoner spell icons, and rune/rune-tree/stat-shard icons all come straight from Data Dragon, keyed to the version this deployment has pinned in `DDRAGON_VERSION`:

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
| Match-V5 match detail | Indefinite (in memory) + `match_details` collection when a database is configured, so it **survives restarts** — see [Database](#database) | A completed match is immutable. The raw 50–120 KB response is trimmed to the ~40 fields the code reads (~5 KB) before it's cached or stored |
| Match-V5 timeline slice | Indefinite | One player's reconstructed build path (~2 KB); the match is immutable. Safe only because it's kilobytes — the raw 0.3–1 MB timeline it's derived from has **no** cache entry type and is discarded after parsing |
| Spectator-V5 active game | **30 seconds** | The live game changes by the second; the TTL matches the poll floor so a poll is never answered entirely from cache. A `not_found` ("not in a game") is **never cached** — caching it would delay noticing a game starting by up to a full TTL |
| Champion-Mastery-V4 (by-champion) | 1 hour | Mastery moves a few thousand points per game — invisible at the 10k / 200k insight thresholds over an hour. Account-V1 (by-puuid) and League-V4 enrichment reuse the `account` / `league` entries above; the live feature does **not** shorten them to the 30s active-game cadence |

Cache keys are length-prefixed per segment so concatenation is injective — `{"a:b": "c"}` and `{"a": "b:c"}` can't collide.

## Database

The cache above is in-memory and disposable. Several features need data that *survives a restart and grows*, so there is one optional persistent store: **MongoDB** (Atlas M0 free tier in production), enabled by setting `MONGODB_URI`. **With it unset, none of this runs and the site is unchanged** — every store method is a no-op.

| Collection | Written | Holds | Read by |
|---|---|---|---|
| `rank_snapshots` | On each successful lookup of a ranked player, **at most once per player per queue per UTC day** (a unique index enforces it) | `{ puuid, queueType, tier, division, leaguePoints, observedAt }` for Ranked Solo/Duo | `specs/profile-sidebar/`'s rank-over-time graph |
| `looked_up_players` | On each successful lookup (upsert, keyed by PUUID) | `{ puuid, gameName, tagLine, tagLineLower, gameNameLower, region, profileIconId, lastLookedUpAt }` | [`GET /api/players/suggest`](#get-apiplayerssuggest) — the Riot-ID autocomplete; and `GET /api/players/report` to resolve a name → PUUID |
| `profile_reports` | On each successful lookup (upsert, keyed by PUUID) | `{ _id: puuid, report: <full ProfileReport>, fetchedAt }` | [`GET /api/players/report`](#get-apiplayersreport) — instant render when a dropdown suggestion is picked |
| `match_details` | On each lookup that fetched one or more matches from Riot (one bulk upsert, keyed by `matchId`) | `{ _id: matchId, match: <trimmed MatchDto>, region, storedAt }` — the ~40 fields the code reads, ~5 KB (not Riot's 50–120 KB raw response) | The lookup pipeline (before the Match-V5 detail fan-out) and the stale-cache fallback — **one stored match serves every player who was in it** |

All these writes are **fire-and-forget** — issued as unawaited side effects of a lookup, never on its critical path. A slow, unreachable, or erroring database degrades to "the graph is a little younger, one name is missing from autocomplete, a dropdown pick does a normal live lookup, and a match is re-fetched", never to a slow or failed lookup. `POST /api/privacy/delete` clears all four collections for a PUUID alongside the cache (a `match_details` document the PUUID appears in is evicted whole, not redacted).

`profile_reports` carries a **15-day TTL index** on `fetchedAt`, so abandoned snapshots are reclaimed automatically; the report endpoint also rejects anything ≥ 15 days old regardless of TTL-sweep timing. A stored `ProfileReport` is a few tens of KB, well inside Mongo's 16 MB document cap.

`match_details` carries a **150-day TTL index** on `storedAt` — a *storage bound only*: a completed match is immutable, so an expired-and-re-fetched document is byte-identical and the read path applies no age check. This is the one collection whose growth is worth watching: at ~6 KB effective per document, ~350 MB of the 512 MB M0 budget holds roughly 58,000 matches. The `match_details` read is on the request's critical path (it's consulted before deciding to call Riot) but is internally bounded — a slow, unreachable, or hung store resolves to "nothing stored" and the lookup falls through to Riot exactly as it would without a database. The payoff: **a deploy or restart no longer re-costs every match on the next lookup of every player**, and a Refresh of a returning player only fetches the matches that are actually new.

**Redis is deliberately absent.** The roadmap once paired "a DB and Redis"; nothing actually needs a shared cache or shared rate-limit state while the backend runs as a single instance. The in-memory cache serves all caching. Revisit only when going multi-instance.

### One-time Atlas M0 setup

1. [cloud.mongodb.com](https://cloud.mongodb.com) → new project → **Build a Database** → **M0 (Free)** → region near the app host.
2. **Database Access** → add a user with a generated password and the **Read and write to any database** role.
3. **Network Access** → **Allow access from anywhere** (`0.0.0.0/0`). The app host (Render's lower tiers) has no static egress IP; SCRAM auth + TLS are the protection.
4. **Connect → Drivers → Node.js** → copy the `mongodb+srv://…` string, insert the password, append the db name: `…mongodb.net/lolprofiles?retryWrites=true&w=majority`.
5. Set it as `MONGODB_URI` (Render env var in production; `backend/.env` locally). The app selects the `lolprofiles` database and creates its indexes on first connect.

## Testing

```bash
npm run test:backend
npm run test:frontend
```

50+ backend test files, 40+ frontend. Beyond conventional unit and integration tests (including supertest-driven route tests and an end-to-end pass over fakes), the backend carries **24 property-based invariants** in 11 `*.property.test.ts` files, each running 100–400 cases via fast-check — covering region-mapping closure, the win-rate and KDA formulas, top-champion ordering, tie-breaking, 429 retry bounds, cache key injectivity, TTL staleness, deletion idempotence, the guarantee that the API key never appears in client-facing output, and (added by `match-detail-tabs`) kill-participation bounds, participant-capture fidelity down to matches with fewer than ten players, PUUID absence, and the Enemy_Laner marker's correctness under a mirror pick. Each property test also asserts it actually exercised every branch it claims to, so degenerate coverage fails loudly.

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

- **The write routes are unauthenticated.** `/api/privacy/delete` accepts any PUUID; a scrubbed match detail is not recoverable from cache while it stays cached. This needs an explicit decision before any public deployment. `/api/players/suggest` (autocomplete) shares the unauthenticated posture but is far cheaper — one indexed query, no Riot call, no shared budget — and it can only echo back names that were already looked up on this site.
- **`/api/lookup` spends a shared budget.** The rate limit manager guarantees the API key stays in good standing, but it can't stop an anonymous caller consuming the budget by requesting many distinct Riot IDs. Per-IP throttling is the mitigation and isn't implemented. With a database configured, the volume is much lower — match details persist in `match_details` across restarts, so a deploy no longer cold-caches every match, and a Refresh only fetches new games — but the endpoint is still unmetered per caller.
- **`npm run dev` is broken.** It invokes `ts-node`, which isn't installed. Use `npm run build && npm start`. (`.env` *is* loaded now — `dotenv` is a dependency and `index.ts` imports it.)
- **The database has no backups and its deletion isn't durable.** The Atlas M0 collections (`rank_snapshots`, `looked_up_players`, `profile_reports`, `match_details`) have no automated backups (acceptable — all of it is derived data, re-fetchable from Riot, whose loss degrades gracefully). Privacy deletion clears a PUUID's data across all of them, but a later lookup of the same player lawfully re-creates it. The Atlas network allow-list is `0.0.0.0/0` because the app host has no static egress IP.
- **Performance targets are unverified.** The spec sets p95 ≤2s cached / ≤15s fresh. Unit tests can't prove that; it needs staging load testing, and no claim is made here.
- **Account cache keys are case-sensitive.** `Faker#KR1` and `faker#kr1` occupy separate entries, so a hot endpoint loses hit rate. Normalising the key would change the declared cache key params.

## Riot compliance

Riot ToS obligations are enforced at the service layer rather than left to page authors to remember:

- **Attribution** — `RiotDataPage` renders the required disclaimer for the whole time it displays Riot data, and every page showing Riot data uses that template.
- **No advertising** — the policy is inverted so it fails safe. `RiotDataPage` renders no ad slot unless handed an approved agreement, and there is exactly one place in the codebase where such an agreement can be introduced (hardcoded to `undefined`). Adding advertising requires a deliberate, reviewable edit to that file.
- **Bounded retention and deletion on request** — TTLs are the single source of truth in the cache store; `/api/privacy/delete` evicts the cache and clears the [persistent store](#database) rows for a PUUID.
- **Assets served unmodified from Riot's own distribution** — champion, item, profile, summoner spell and rune icons are hot-linked from Data Dragon (see [Assets](#assets)) and never rehosted, altered or re-branded.

lolprofiles.gg isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc.
