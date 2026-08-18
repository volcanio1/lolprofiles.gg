# lolprofiles.gg

A League of Legends profile tracker. Enter a Riot ID (`gameName#tagLine`), pick a region, and get a profile report: ranked standing, recent-match stats, derived "fun facts", and improvement recommendations — all built from Riot's public APIs.

The interesting constraint here isn't the stats. It's that Riot's rate limits are enforced per API key, not per user, so every outgoing request funnels through a single rate-limit manager, and a cache sits in front of the API client for every sub-request.

---

## Contents

- [Architecture](#architecture)
- [Stack](#stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [API](#api)
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
   │  POST /api/lookup  { riotId, region, platform }
   ▼
Backend API (Express + TypeScript)
   ├─ Validator ......... Riot ID shape, before any network call
   ├─ Region Router ..... regional ↔ platform routing mapping
   ├─ Orchestrator ...... cache-or-fetch per sub-request, assembles the report
   │     ├─ Cache Store ....... TTL'd key-value (in-memory LRU)
   │     └─ Riot API Client ... 10s timeout, 429 retry w/ Retry-After
   │            └─ Rate Limit Manager ... one instance, per routing value
   └─ Insight Engine .... pure function over assembled data (no I/O)
   ▼
Riot Games APIs — Account-V1, Summoner-V4, League-V4, Match-V5
```

Three decisions worth calling out:

- **Cache-first orchestration.** The orchestrator checks the cache before the API client for *every* sub-request (account, summoner, league, match IDs, each match detail). This is the main lever for both latency and staying inside Riot's windows on popular profiles.
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
{ "riotId": "Faker#KR1", "region": "asia", "platform": "kr" }
```

`region` defaults to `americas` if omitted or blank. `platform` is optional; if it doesn't belong to the selected region it's silently replaced with that region's first platform, and if it isn't in the mapping at all the request is rejected outright.

On success the response body **is** the `ProfileReport`, unwrapped:

```jsonc
{
  "riotId": { "gameName": "Faker", "tagLine": "KR1" },
  "puuid": "...",
  "summonerLevel": 700,
  "profileIconId": 6,
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

Errors are wrapped in an `{ "error": { ... } }` envelope, so presence of `error` unambiguously means failure — no field of `ProfileReport` is named `error`. Each failure mode maps to its own status and message, with `retryAfterSeconds` on rate-limit errors and `maxRetries` on retriable upstream failures.

Validation happens before the orchestrator is invoked, so a malformed Riot ID or an unsupported region **never** costs a Riot API call.

### `POST /api/privacy/delete`

Takes a `puuid`, evicts its cached data and scrubs its participant rows from retained match details. Returns `{ found, deletedAt }`. A PUUID with nothing cached returns `found: false` with a 200 — not an error. See [Known gaps](#known-gaps) before exposing this publicly.

### `GET /health`

`{ "status": "ok" }`.

## Regions

The regional → platform mapping is closed; anything outside it is rejected.

| Regional routing | Platforms |
|---|---|
| `americas` | `na1`, `br1`, `la1`, `la2` |
| `europe` | `euw1`, `eun1`, `tr1`, `ru` |
| `asia` | `kr`, `jp1` |
| `sea` | `oc1` |

Regional values route Account-V1 and Match-V5; platform values route Summoner-V4 and League-V4.

## Caching

| Endpoint | TTL | Why |
|---|---|---|
| Account-V1 | 1 hour | Riot ID → PUUID changes rarely |
| Summoner-V4 | 1 hour | Level and icon move slowly |
| League-V4 | 10 minutes | Rank changes per game |
| Match-V5 match IDs | 10 minutes | New matches appear |
| Match-V5 match detail | Indefinite | A completed match is immutable |

Cache keys are length-prefixed per segment so concatenation is injective — `{"a:b": "c"}` and `{"a": "b:c"}` can't collide.

## Testing

```bash
npm run test:backend
npm run test:frontend
```

Roughly 39 test files. Beyond conventional unit and integration tests (including supertest-driven route tests and an end-to-end pass over fakes), the backend carries **20 property-based invariants** in 10 `*.property.test.ts` files, each running 100–400 cases via fast-check — covering region-mapping closure, the win-rate and KDA formulas, top-champion ordering, tie-breaking, 429 retry bounds, cache key injectivity, TTL staleness, deletion idempotence, and the guarantee that the API key never appears in client-facing output. Each property test also asserts it actually exercised every branch it claims to, so degenerate coverage fails loudly.

No test touches the live Riot API, real credentials, real network, or real timers.

`frontend/src/domain/parity.test.ts` is worth knowing about: the Riot ID rules and region mapping necessarily exist in both workspaces (the frontend needs them for inline validation and the region selector, and the workspaces share no code), so that test reads the backend source as text and asserts the two copies agree.

## Project layout

```
backend/src
├─ api/            # routes, error mapping, CORS, privacy endpoint
├─ config/         # env loading and validation
├─ validator/      # Riot ID parsing
├─ region/         # regional ↔ platform routing
├─ riotApiClient/  # HTTP to Riot, timeouts, 429 retries
├─ rateLimit/      # per-routing-value window tracking
├─ cache/          # TTL store, PUUID scrubbing
├─ orchestrator/   # cache-or-fetch, Riot schema mapping, runLookup
└─ insight/        # stats, funFacts, recommendations (pure)

frontend/src
├─ pages/          # SearchPage, ProfileReportPage
├─ components/     # SearchForm, ProfileReportView, LoadingIndicator, ErrorNotice
├─ hooks/          # useLookup
├─ api/            # lookupClient + wire types
├─ domain/         # Riot ID + region (mirrors backend, parity-tested)
└─ compliance/     # RiotDataPage template, advertising policy

.kiro/specs/lolprofiles-gg/   # requirements, design, tasks, implementation log
```

The `.kiro/specs` directory holds the full requirements document, design document, and an implementation log recording decisions and open items — the code comments reference requirement numbers back to it.

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

lolprofiles.gg isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc.
