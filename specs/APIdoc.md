# External API Reference

Every third-party API this codebase talks to: what we send, what we read back, and — separately — what neighboring endpoints in the same API families exist but this codebase does **not** call.

Two categories, treated very differently by the code:

1. **Riot Games API** — key-authenticated, rate-limited, routed through the shared `RateLimitManager`. Every call goes through `backend/src/riotApiClient/index.ts` (`RiotApiClient`), except the one endpoint deliberately kept off it (`ClashTournamentSource`, see below).
2. **Data Dragon / Community Dragon** — unauthenticated static-asset CDNs. No API key, no rate-limit reservation, called directly by the **frontend**, never proxied through the backend.

This file lists the wire shape as **this codebase actually reads it** (a trimmed subset of Riot's full response — see each DTO's source file), not Riot's full published schema. Where a number (rate limit, TTL) comes from this project's own design docs rather than something independently re-verified live against Riot, it's marked as such.

---

## Contents

- [Riot Games API — in use](#riot-games-api--in-use)
- [Riot Games API — known but unused](#riot-games-api--known-but-unused)
- [Data Dragon / Community Dragon — in use](#data-dragon--community-dragon--in-use)
- [Example payloads](#example-payloads)
- [Auth, routing, and rate limiting](#auth-routing-and-rate-limiting)

---

## Riot Games API — in use

All hosts are `https://{routingValue}.api.riotgames.com`. `{routingValue}` is either a **regional** routing value (`americas`/`europe`/`asia`/`sea` — Account-V1, Match-V5) or a **platform** routing value (`na1`/`euw1`/`kr`/... — everything else). See [Auth, routing, and rate limiting](#auth-routing-and-rate-limiting) for the full platform↔region table. Every call carries the `X-Riot-Token` header and goes through the same 10s timeout / rate-limit reservation / bounded-429-retry policy — implemented once in `HttpRiotApiClient.send()` (`backend/src/riotApiClient/index.ts`), reused for every method below except the one row marked ⚠️.

| # | API · Endpoint | Method / URL | Routing | We send | We read back | Called by | Cache TTL |
|---|---|---|---|---|---|---|---|
| 1 | **Account-V1** get-by-riot-id | `GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}` | Regional (fixed **Discovery_Region** = `americas`, never visitor-chosen — this endpoint is global) | `gameName`, `tagLine` (URL-encoded) | `{ puuid, gameName, tagLine }` | Every lookup — profile, live-game, clash-scouting (resolves a Riot ID to a PUUID) | 1 hour |
| 2 | **Account-V1** region-by-game-by-puuid | `GET /riot/account/v1/region/by-game/{game}/by-puuid/{puuid}` | Regional (any regional host answers the same — issued against the Discovery_Region) | `game='lol'`, `puuid` | `{ puuid, game, region }` — `region` is a lowercase **platform** value (e.g. `"euw1"`), confusingly named by Riot | Region Resolver (`backend/src/regionResolver`) — discovers which platform a player's account lives on; there is no visitor-facing region selector | 24 hours |
| 3 | **Account-V1** accounts-by-puuid | `GET /riot/account/v1/accounts/by-puuid/{puuid}` | Regional | `puuid` | `{ puuid, gameName, tagLine }` | live-game (per-participant Riot ID), clash-scouting (per-roster-member Riot ID) | 1 hour |
| 4 | **Summoner-V4** by-puuid | `GET /lol/summoner/v4/summoners/by-puuid/{puuid}` | Platform | `puuid` | `{ puuid, id?, summonerLevel, profileIconId }` — `id` is the encrypted summoner id, kept for completeness but not otherwise used | Main lookup only, as a **non-blocking enrichment call** (`enrich<T>()` — a failure degrades `summonerLevel`/`profileIconId` to `null`, never fails the report) | **Not cached** — fetched fresh every lookup |
| 5 | **League-V4** entries by-puuid | `GET /lol/league/v4/entries/by-puuid/{puuid}` | Platform | `puuid` | `LeagueEntryDto[]` — each `{ queueType, tier, rank, leaguePoints, wins, losses }`. An empty array is a valid "unranked" result, not a failure | Main lookup, live-game (per participant), clash-scouting (per roster member) | 10 minutes |
| 6 | **Match-V5** match-ids by-puuid | `GET /lol/match/v5/matches/by-puuid/{puuid}/ids?count={n}` | Regional | `puuid`, `count` (capped at `MATCH_HISTORY_COUNT`=100 for the main lookup, 10 for clash-scouting's Recent_Form) | `string[]` of match ids, newest first | Main lookup, clash-scouting (bounded Recent_Form window) | 10 minutes |
| 7 | **Match-V5** match by id | `GET /lol/match/v5/matches/{matchId}` | Regional | `matchId` | `MatchDto` — `metadata.{matchId, participants[]}` + `info.{queueId, gameMode?, gameStartTimestamp, gameDuration, participants[]}`. Each participant is trimmed to ~40 of Riot's ~150 fields (kills/deaths/assists, items, runes, summoner spells, `championId`/`championName`, `teamPosition`, augments, objective/multi-kill counters — see `PARTICIPANT_KEYS` in `riotApiClient/matchProjection.ts`). Riot's raw body is 50–120 KB; the trimmed shape is ~5 KB | Main lookup (recent matches, stats, build path's participant lookup), clash-scouting Recent_Form | **Indefinite** (completed matches are immutable) — in-memory + a `match_details` Mongo collection when a database is configured, so it survives restarts |
| 8 | **Match-V5** timeline | `GET /lol/match/v5/matches/{matchId}/timeline` | Regional | `matchId` | `MatchTimelineDto` — `metadata.participants[]` (the authoritative participantId↔puuid map) + `info.frames[].events[]` (shop events only; the 0.3–1 MB per-frame gold/XP/position data is **not** modeled) | `item-timeline` feature (Build Path tab), fetched only when that tab is opened | **Never cached** — parsed once into a ~2 KB `timelineSlice`, then discarded; the slice itself is cached indefinitely |
| 9 | **Spectator-V5** active-games by-puuid | `GET /lol/spectator/v5/active-games/by-summoner/{puuid}` (despite the URL segment, keyed by puuid) | Platform | `puuid` | `CurrentGameInfo` — `{ gameId, platformId, gameStartTime, gameLength, gameMode, gameType, mapId, gameQueueConfigId, bannedChampions[], participants[] }`; each participant is `{ puuid, teamId, championId, spell1Id, spell2Id, bot, perks? }`. A 404 means "not in a game" (a state, not an error) | Live Game feature (`GET /api/live-game`) | 30 seconds. A 404 is **never cached** (would delay noticing a game starting) |
| 10 | **Champion-Mastery-V4** by-puuid-by-champion | `GET /lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/by-champion/{championId}` | Platform | `puuid`, `championId` | `{ championId, championLevel, championPoints }`. A 404 means "never played this champion" (also not an error) | Live Game (per-participant mastery on their locked champion) | 1 hour |
| 11 | **Champion-Mastery-V4** top-by-puuid | `GET /lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/top?count={n}` | Platform | `puuid`, `count` (5 — this project's own choice, not Riot-mandated) | `ChampionMasteryDto[]`, highest mastery first | clash-scouting (each roster member's Champion_Pool) | 1 hour — a separate cache entry (`championMasteryTop`) from row 10 (`championMastery`), since the query shape differs (top-N vs. one specific champion) |
| 12 | **Clash-V1** players-by-puuid | `GET /lol/clash/v1/players/by-puuid/{puuid}` | Platform | `puuid` | `ClashPlayerDto[]` — each `{ puuid, teamId, position, role }`. An empty array means "not registered for an active Clash tournament" (a state, not an error) | clash-scouting | 5 minutes |
| 13 | **Clash-V1** teams | `GET /lol/clash/v1/teams/{teamId}` | Platform | `teamId` | `ClashTeamDto` — `{ id, tournamentId, name, iconId, tier, captain, abbreviation, players[] }`, `players[]` is `{ puuid, position, role }` × 5. A 404 means the registration outlived the team (treated as "not registered", not an error) | clash-scouting | 5 minutes |
| 14 | **Clash-V1** tournaments-by-team | `GET /lol/clash/v1/tournaments/by-team/{teamId}` | Platform | `teamId` | `ClashTournamentDto[]` | Defined on `RiotApiClient` (`getClashTournamentsByTeam`) but **not yet called by any orchestrator** — the Scouting Orchestrator currently reads the tournament schedule from the background-refreshed cache instead (row 15) and never resolves a specific team↔tournament association through this call. Client method exists for a future scouting-detail feature | n/a |
| 15 ⚠️ | **Clash-V1** tournaments (all active) | `GET /lol/clash/v1/tournaments` | Platform | — | `ClashTournamentDto[]` — each `{ id, themeId, nameKey, nameKeySecondary, schedule[] }` | **Only** the background Tournament Refresher (`backend/src/clashScouting/tournamentSourceHttp.ts`), on a 5-minute timer, one call per supported platform. Deliberately **not** on `RiotApiClient` at all — kept on a separate `ClashTournamentSource` interface so a request-path call is a compile error, not a code-review finding | 1 hour, written only by the refresher |

**Row 15 is the one endpoint with a materially different rate grant.** Per this project's own design docs (`specs/clash-scouting/design.md`), it's granted **10 requests/minute** — roughly three orders of magnitude below every other row above (which sit in the thousands-per-10-seconds range). That's tight enough that the shared `RateLimitManager`'s 30-second pre-flight ceiling can't safely absorb a burst against it, which is why it's the one call kept off a visitor request path entirely.

---

## Riot Games API — known but unused

Endpoints that exist in the API families above (or in related families this codebase never touches at all), listed so a future session doesn't have to rediscover what's available. None of these have been implemented, so no request/response shape here has been verified against this codebase — only against public knowledge of the API.

**Within families we already call:**
- **Summoner-V4** by-name (deprecated by Riot), by-account-id, by-summoner-id — this codebase only ever resolves a summoner from a `puuid` (row 4), never from the encrypted summoner id `SummonerDto.id` carries.
- **League-V4** by-summoner-id, challenger/grandmaster/master league listings, entries-by-league-id — this codebase only reads one player's own entries (row 5), never a full ladder or leaderboard.
- **Champion-Mastery-V4** all-masteries-by-puuid (every champion, not just top-N) and the mastery-score endpoint (a single aggregate number) — this codebase only reads the top-N slice (row 11) and one specific champion (row 10).
- **Match-V5** — every field of the raw match/timeline response this codebase's DTOs don't model (see row 7/8 notes) is technically "available" in the sense that the API returns it; the trimming is a deliberate choice (`matchProjection.ts`), not a missing capability.
- **Clash-V1** players-by-summoner (deprecated, superseded by players-by-puuid, row 12).

**Families never touched at all:**
- **Champion-V3** (free-champion-rotation) — would tell a visitor which champions are free-to-play this week; no feature currently surfaces that.
- **Challenges-V1** — the newer Challenges/Season-progress system; not modeled anywhere in this codebase's stats.
- **LOL-Status-V4** — Riot service-status/incident feed for a given shard; could power a "Riot is having issues right now" banner, but nothing here consumes it.
- **Tournament-V5 / Tournament-Stub-V5** — the *esports tournament-provider* API (organizing custom tournaments programmatically), unrelated to and easily confused with **Clash-V1** above (in-client amateur tournaments) — not used, not needed for anything this site does.
- **LOR (Legends of Runeterra) / VAL (Valorant) / TFT APIs** — entirely different games under the same developer portal; out of scope for a League of Legends profile tracker.

---

## Data Dragon / Community Dragon — in use

Static game-data CDNs: **no API key, no rate limit, no `RateLimitManager` reservation.** Called directly by the frontend (`frontend/src/staticData/`), never proxied through the backend — the backend's only role is telling the frontend which pinned version to use (`GET /api/static-data`, documented in the main `README.md`).

| Source | URL pattern | We read | Used for |
|---|---|---|---|
| Data Dragon | `https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/champion.json` | Every champion's name, id↔key mapping, icon filename | Champion icons/names everywhere a champion appears |
| Data Dragon | `https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/item.json` | Every item's name, icon filename | Item build rows, item-timeline |
| Data Dragon | `https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/summoner.json` | Summoner spell name/id/icon/cooldown | Summoner spell icons |
| Data Dragon | `https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/runesReforged.json` | Rune tree → rune → icon-path mapping, and stat-shard identifiers embedded in it | Rune/rune-tree icons |
| Data Dragon | `https://ddragon.leagueoflegends.com/cdn/{version}/img/{champion\|item\|spell}/{file}` | Raw image bytes | Every champion/item/summoner-spell icon `<img>` |
| Data Dragon | `https://ddragon.leagueoflegends.com/cdn/{version}/img/profileicon/{id}.png` | Raw image bytes | Summoner profile icon |
| Data Dragon | `https://ddragon.leagueoflegends.com/cdn/img/perk-images/...` (⚠️ **unversioned** — the versioned path 403s, confirmed live) | Raw image bytes | Rune / rune-tree / stat-shard icon *files* only — the id→rune mapping itself still comes from the versioned `runesReforged.json` above |
| Community Dragon | `https://raw.communitydragon.org/{major.minor}/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-{tier}.png` | Raw image bytes | Ranked-tier crest (`RankIcon`) |
| Community Dragon | `https://raw.communitydragon.org/{major.minor}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json` | Arena/ARAM-Mayhem augment id → name/icon-path mapping | Augment icons on ARAM Mayhem (queue 2400) matches. ⚠️ **Unverified**: this codebase assumes the `id` space here is the same one Match-V5 reports in `playerAugment1`-`6`; that assumption has never been checked against a real queue-2400 match (see `README.md`'s Assets section) |

Data Dragon has **no** endpoint for Clash team icons or augment data at all (the latter confirmed 403 on every path tried) — that's why the Clash team picker (`frontend/src/components/ClashTeamPicker.tsx`) is text-only today, and why augment icons come from Community Dragon instead.

---

## Example payloads

**Illustrative, not captured from a live call.** Field names, nesting and types match what this codebase's DTOs actually model (see each row above and its source file); the values themselves are made up. Every object is shown **already trimmed to what this codebase reads** — Riot's real responses carry many more fields (Match-V5's raw participant object alone is ~150 fields; here it's ~40 — see `riotApiClient/matchProjection.ts`).

### 1 · Account-V1 get-by-riot-id

```json
{
  "puuid": "zGh5Yc1x9F3q8h2K...w0N7pL4rT6s",
  "gameName": "Faker",
  "tagLine": "KR1"
}
```

### 2 · Account-V1 region-by-game-by-puuid

```json
{
  "puuid": "zGh5Yc1x9F3q8h2K...w0N7pL4rT6s",
  "game": "lol",
  "region": "kr"
}
```

### 4 · Summoner-V4 by-puuid

```json
{
  "puuid": "zGh5Yc1x9F3q8h2K...w0N7pL4rT6s",
  "id": "8a3f1c...encrypted-summoner-id",
  "summonerLevel": 496,
  "profileIconId": 29
}
```

### 5 · League-V4 entries by-puuid

```json
[
  {
    "queueType": "RANKED_SOLO_5x5",
    "tier": "DIAMOND",
    "rank": "II",
    "leaguePoints": 67,
    "wins": 142,
    "losses": 118
  },
  {
    "queueType": "RANKED_FLEX_SR",
    "tier": "PLATINUM",
    "rank": "I",
    "leaguePoints": 12,
    "wins": 9,
    "losses": 11
  }
]
```

An unranked player returns `[]`, not an absent field or a null entry — that's the distinction the code relies on to render "Unranked" instead of treating the call as failed.

### 6 · Match-V5 match-ids by-puuid

```json
["NA1_5012345678", "NA1_5012344321", "NA1_5012340001"]
```

### 7 · Match-V5 match by id (trimmed to this codebase's `MatchDto`)

```json
{
  "metadata": {
    "matchId": "NA1_5012345678",
    "participants": ["puuid-1", "puuid-2", "...", "puuid-10"]
  },
  "info": {
    "queueId": 420,
    "gameMode": "CLASSIC",
    "gameStartTimestamp": 1700000000000,
    "gameDuration": 1847,
    "participants": [
      {
        "puuid": "puuid-1",
        "championName": "Ahri",
        "championId": 103,
        "teamPosition": "MIDDLE",
        "teamId": 100,
        "win": true,
        "kills": 8,
        "deaths": 2,
        "assists": 11,
        "visionScore": 24,
        "totalMinionsKilled": 187,
        "neutralMinionsKilled": 12,
        "item0": 3157,
        "item1": 3020,
        "item2": 4645,
        "item3": 3135,
        "item4": 3089,
        "item5": 3165,
        "item6": 3364,
        "summoner1Id": 4,
        "summoner2Id": 14,
        "perks": {
          "statPerks": { "offense": 5008, "flex": 5008, "defense": 5001 },
          "styles": [
            { "description": "primaryStyle", "style": 8200, "selections": [{ "perk": 8214 }, { "perk": 8226 }] }
          ]
        },
        "champLevel": 18,
        "goldEarned": 14203,
        "totalDamageDealtToChampions": 28110,
        "turretKills": 2,
        "dragonKills": 1,
        "baronKills": 0,
        "pentaKills": 0,
        "riotIdGameName": "Faker",
        "riotIdTagline": "KR1"
      }
      // ... 9 more participants
    ]
  }
}
```

### 9 · Spectator-V5 active-games by-puuid

```json
{
  "gameId": 987654321,
  "platformId": "NA1",
  "gameStartTime": 1700000000000,
  "gameLength": 612,
  "gameMode": "CLASSIC",
  "gameType": "MATCHED_GAME",
  "mapId": 11,
  "gameQueueConfigId": 420,
  "bannedChampions": [
    { "championId": 266, "teamId": 100, "pickTurn": 1 },
    { "championId": -1, "teamId": 200, "pickTurn": 2 }
  ],
  "participants": [
    {
      "puuid": "puuid-1",
      "teamId": 100,
      "championId": 103,
      "spell1Id": 4,
      "spell2Id": 14,
      "bot": false,
      "perks": { "perkIds": [8214, 8226, 8210, 8237], "perkStyle": 8200, "perkSubStyle": 8100 }
    }
    // ... 9 more
  ]
}
```

A `404` here means "not currently in a game" — a state this codebase treats as a normal outcome, not an error response to parse.

### 10 · Champion-Mastery-V4 by-puuid-by-champion

```json
{ "championId": 103, "championLevel": 7, "championPoints": 187342 }
```

### 11 · Champion-Mastery-V4 top-by-puuid

```json
[
  { "championId": 103, "championLevel": 7, "championPoints": 187342 },
  { "championId": 84, "championLevel": 6, "championPoints": 94021 },
  { "championId": 61, "championLevel": 5, "championPoints": 41120 }
]
```

### 12 · Clash-V1 players-by-puuid

```json
[
  { "puuid": "puuid-1", "teamId": "01ab2c3d4e5f", "position": "MIDDLE", "role": "CAPTAIN" }
]
```

`[]` means the player has no active Clash registration.

### 13 · Clash-V1 teams

```json
{
  "id": "01ab2c3d4e5f",
  "tournamentId": 500,
  "name": "Midnight Dragons",
  "iconId": 4,
  "tier": 2,
  "captain": "puuid-1",
  "abbreviation": "MDR",
  "players": [
    { "puuid": "puuid-1", "position": "MIDDLE", "role": "CAPTAIN" },
    { "puuid": "puuid-2", "position": "TOP", "role": "MEMBER" },
    { "puuid": "puuid-3", "position": "JUNGLE", "role": "MEMBER" },
    { "puuid": "puuid-4", "position": "BOTTOM", "role": "MEMBER" },
    { "puuid": "puuid-5", "position": "UTILITY", "role": "MEMBER" }
  ]
}
```

### 15 · Clash-V1 tournaments (all active — background refresher only)

```json
[
  {
    "id": 500,
    "themeId": 9,
    "nameKey": "cyber_dragons",
    "nameKeySecondary": "cyber_dragons_secondary",
    "schedule": [
      { "id": 501, "registrationTime": 1700000000000, "startTime": 1700086400000, "cancelled": false }
    ]
  }
]
```

### Assembled `GET /api/clash/scout` report (this codebase's own output, not Riot's)

For comparison — the shape after roster enrichment and the Scouting Insight Engine run over rows 12/13 plus the per-member joins from rows 3/5/11/6/7:

```json
{
  "kind": "report",
  "report": {
    "team": { "id": "01ab2c3d4e5f", "name": "Midnight Dragons", "abbreviation": "MDR", "tier": 2, "iconId": 4, "captainPuuid": "puuid-1" },
    "tournament": { "id": 500, "nameKey": "cyber_dragons", "nameKeySecondary": "cyber_dragons_secondary" },
    "roster": [
      {
        "puuid": "puuid-1",
        "declaredPosition": "MIDDLE",
        "isCaptain": true,
        "riotId": { "gameName": "Faker", "tagLine": "KR1" },
        "rankedEntries": [{ "tier": "DIAMOND", "division": "II", "winRatePercent": 55, "leaguePoints": 67 }],
        "championPool": [{ "championId": 103, "masteryPoints": 187342, "masteryLevel": 7 }],
        "recentForm": [{ "matchId": "NA1_5012345678", "championId": 103, "role": "MIDDLE", "win": true, "participantPuuids": ["puuid-1", "..."] }],
        "observedRole": "MIDDLE"
      }
      // ... 4 more roster cards
    ],
    "insights": {
      "banRecommendations": [{ "championId": 103, "puuid": "puuid-1", "masteryPoints": 187342, "recentGames": 4, "recentWins": 3 }],
      "positionMismatches": [],
      "stackCohesion": 0
    }
  }
}
```

### Data Dragon `champion.json` (one entry of many)

```json
{
  "data": {
    "Ahri": {
      "name": "Ahri",
      "key": "103",
      "image": { "full": "Ahri.png" }
    }
  }
}
```

### Community Dragon `cherry-augments.json` (one entry of many)

```json
[
  { "id": 25, "name": "Cannon Fodder", "iconLarge": "assets/ux/cherry/augments/icons/cannon_fodder_large.png" }
]
```

---

## Auth, routing, and rate limiting

- **Auth**: one API key (`RIOT_API_KEY` env var), attached as the `X-Riot-Token` header by `HttpRiotApiClient` / `createHttpClashTournamentSource`. Never logged, never returned to any caller, never reaches the frontend.
- **Regional routing** (Account-V1, Match-V5) vs. **platform routing** (everything else) — see the per-row table above. The platform↔region mapping is closed (`backend/src/region/index.ts`):

  | Regional routing | Platforms |
  |---|---|
  | `americas` | `na1`, `br1`, `la1`, `la2` |
  | `europe` | `euw1`, `eun1`, `tr1`, `ru` |
  | `asia` | `kr`, `jp1` |
  | `sea` | `oc1` |

  There is no visitor-facing region selector — every platform is discovered from the player's PUUID via the Region Resolver (row 2 above), never guessed or chosen.
- **Rate limiting**: one shared `RateLimitManager` instance for the whole process (Riot enforces limits per API key, not per user or per request), tracking Riot's `X-App-Rate-Limit`/`X-Method-Rate-Limit` response headers per routing value + method. A pre-flight reservation that would require waiting more than 30 seconds fails fast (`rate_limited`) rather than queuing.
- **Personal/dev API keys** (the kind used for local development, distinct from a production key) are throttled far below the per-endpoint numbers in the table above — around 100 requests / 2 minutes app-wide, expire after 24 hours, and are why `MATCH_HISTORY_COUNT` is capped locally to avoid burning through the budget on one cold profile lookup.
- **429 retry**: at most 2 retries per call (3 requests total), honoring Riot's `Retry-After` header when present, a flat 5-second wait otherwise.
