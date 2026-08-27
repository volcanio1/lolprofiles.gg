# Design Document

## Overview

Every value the General and Runes tabs display is already inside a response the backend fetches and caches indefinitely. `toIncludedMatch` in `backend/src/orchestrator/mapping.ts` receives the whole `MatchDto` — all ten participants, 156 fields each — locates the analyzed player's row, locates the lane opponent's row via `opponentOf`, and drops the other eight. This feature stops dropping them.

That framing sets the shape of the work:

- **Backend**: widen the participant slice. No new endpoint, no new Riot call, no change to the opponent-selection *predicate* (it is extracted and reused, not rewritten), one new pure function for kill participation.
- **Frontend**: extend the Static_Data_Provider with two more Data_Dragon files, then build the row and the tabs over data already in hand.
- **Build Path**: defined here, filled by `item-timeline`. It is the only tab that will ever issue a request.

Two things in this design are not "more of the same", and both are consequences of what Data_Dragon actually serves rather than choices made here.

## Verified against the live CDN and API

Every claim below was checked against `ddragon.leagueoflegends.com` at version `16.17.1` and against a live Match-V5 response, rather than assumed.

| Asset class | URL shape | Versioned? | Result |
|---|---|---|---|
| Champion icon | `/cdn/{version}/img/champion/{file}` | yes | 200 (existing) |
| Item icon | `/cdn/{version}/img/item/{file}` | yes | 200 (existing) |
| Profile icon | `/cdn/{version}/img/profileicon/{id}.png` | yes | 200 (existing) |
| **Summoner spell** | `/cdn/{version}/img/spell/{file}` | **yes** | **200** |
| **Rune icon** | `/cdn/{version}/img/perk-images/...` | — | **403** |
| **Rune icon** | `/cdn/img/perk-images/...` | **no** | **200** |
| **Rune tree icon** | `/cdn/img/perk-images/Styles/{file}` | **no** | **200** |
| **Stat shard icon** | `/cdn/img/perk-images/StatMods/{file}` | **no** | **200** |

| Metadata file | Size | CORS |
|---|---|---|
| `summoner.json` | 33 KB | `Access-Control-Allow-Origin: *` |
| `runesReforged.json` | 35 KB | `Access-Control-Allow-Origin: *` |

Adding both to the 846 KB the provider already fetches takes it to roughly 914 KB — an 8% increase to a payload already fetched once and held 24 hours.

**Match-V5 participant fields confirmed present**: `summoner1Id`, `summoner2Id`, `perks` (with `statPerks.{offense,flex,defense}` and `styles[]` carrying `style` plus `selections[].perk`), `teamId`, `teamPosition`, `champLevel`, `goldEarned`, `totalDamageDealtToChampions`, `riotIdGameName`, `riotIdTagline`, `playerAugment1` through `playerAugment6` (confirmed present on every sampled participant in every sampled queue, always `0` outside queue 2400).

**ARAM and ARAM Mayhem, verified against Riot's live queue table and a live match:**

| Claim | Verified how | Result |
|---|---|---|
| Queue 450 is standard 5v5 ARAM, queue 2400 is a distinct "ARAM: Mayhem" queue | `curl https://static.developer.riotgames.com/docs/lol/queues.json`, filtered for ARAM | Both present, both current (no deprecation note) |
| A standard ARAM match has 10 participants, `teamId` 100/200, `teamPosition` blank for all ten, full valid `perks` | Two real queue-450 match details fetched live | Confirmed on both |
| `playerAugment1`–`playerAugment6` exist even outside augment modes | Same two ARAM matches | Present, all six `0` on every participant |
| Data_Dragon serves no augment data at all | `cdn/16.17.1/data/en_US/augments.json`, `cdn/16.17.1/img/augments/1000.png`, `cdn/16.17.1/data/en_US/cherry-augments.json` | All three 403 |
| Community_Dragon serves augment metadata and imagery, and is pinnable by major-and-minor version | `raw.communitydragon.org/16.17/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json` and the corresponding icon path | Both 200, at `16.17` — the pinned `DDRAGON_VERSION`'s major and minor, not "latest" |
| That file's per-augment shape | Inspected directly | `{ id, augmentNameId, nameTRA, simpleNameTRA, augmentSmallIconPath, rarity }` — no description or tooltip field |

**No live ARAM Mayhem (2400) match could be sampled.** Forty accounts checked (the PUUID used throughout this design plus the top 39 EUW Challenger players) returned zero queue-2400 matches — the mode does not appear to be currently active as a queueable event. Everything about queue 2400's *existence* and its participants' `playerAugment` fields is verified above from queue 450 and from Riot's queue table; what is **not** verified is that `cherry-augments.json`'s `id` field is the same id space Match-V5 reports in `playerAugmentN`. That file is this codebase's best available candidate — it is the canonical, unlocalized game-data file, the pattern every other Riot game-data file in this codebase follows (an id declared in the raw file is the id the game API reports) — but it is an inference, not a cross-check, and Requirement 12's augment resolution must not be trusted in production before task 10.2 verifies it against a real Mayhem match.

A second, narrower file exists — `raw.communitydragon.org/{version}/cdragon/arena/en_us.json` — which does carry `desc`/`tooltip` text. It was checked and rejected as a description source for this feature: it is Arena's (queue 1750's) augment pool, not ARAM Mayhem's, uses its own `id` numbering distinct from `cherry-augments.json`'s, and a name-based cross-reference against the 170 ARAM-prefixed entries in `cherry-augments.json` matches only 108 of them (62 ARAM Mayhem augments have no Arena counterpart at all) — and even those 108 matches rest on an `id` offset of exactly `1000` that held in 101 of 108 sampled pairs and diverged in the other 7, which is not a documented contract. Requirement 12.8 is the result: no description in this feature.

**`summonerName` is empty** on current matches — it is deprecated. Participant names must come from `riotIdGameName` / `riotIdTagline`.

**Team kill totals**: `info.teams[].objectives.champion.kills` reports them directly (23 and 9 in the sampled match, matching the sum of the five participants' `kills` on each side). This design nonetheless derives totals by summing the displayed participants — see decision 3.

### The two exceptions this forces

**1. Rune and stat shard images cannot be version-pinned.** `visual-assets` Requirement 4.1 required every asset URL to resolve against one pinned version, and 4.2 forbids moving aliases. The versioned rune path returns 403; only the unversioned path serves the file. There is no third option. That spec has since been amended — its Requirement 4 now carries criteria 7 through 9 recording this exception, so 4.1 reads "except as criterion 7 provides" rather than absolutely.

The honest framing is narrower than "the invariant is broken", and the narrowness is what makes the exception acceptable: **the mapping is pinned even though the bytes are not.** `runesReforged.json` is fetched from the versioned path, so *which* icon path corresponds to rune 8112 is fixed by `DDRAGON_VERSION`. Only the image file served at that path floats. A Riot art update can therefore change how a rune looks without a deploy, but it cannot change which rune the System believes a player selected. Requirement 7.4 confines the exception to exactly the asset classes that force it.

**2. Stat shards have no metadata anywhere.** `runesReforged.json` contains no entry for `5008`, `5001`, or any other `perks.statPerks` value — searched and confirmed absent. Data_Dragon publishes no file that maps a stat shard identifier to an image or a name. The nine icon files exist and were each verified to return 200, but the identifier-to-file mapping must live in this codebase (Requirement 7.7). That makes it a second source of truth with no upstream to check against, which is why task 1.2 exists to spot-check it against real matches rather than trusting it on first write.

## Architecture

```
POST /api/lookup  (unchanged endpoint, widened response)
  │
  ▼
Orchestrator ── toIncludedMatch(matchDto, puuid)      [queues 400/420/430/440/480/490 only]
  │                 ├─ analyzed player row       (existing)
  │                 ├─ opponentRowOf → lane rival (predicate existing, extracted)
  │                 │     ├─ opponentOf → OpponentSummary  (existing)
  │                 │     └─ isEnemyLaner marker           ← NEW
  │                 ├─ teamKillsOf(participants)           ← NEW
  │                 └─ toMatchParticipant × 10             ← NEW
  │                       └─ calls insight/stats.killParticipationOf()
  │                          (pure, same pattern as the existing csPerMinuteOf call)
  │
  ├─ toLanelessMatch(matchDto, puuid)                  ← NEW, queues 450/2400 only
  │                 ├─ never calls opponentRowOf — isEnemyLaner is false on every row
  │                 └─ toMatchParticipant × 10 (same function, augments populated for 2400)
  │
  ▼
Insight Engine ── computeRecentMatches(matches, lanelessMatches)  ← widened, merges both sources
  │
  ▼
ProfileReport.recentMatches[].participants[]
  │
  ▼
Frontend
  ├─ MatchRow ─────────── MatchSide (left)  │  MatchSide (right, mirrored)
  │                         └─ ChampionIcon, SummonerSpellIcon×2,
  │                            RuneKeystoneIcon, RuneTreeIcon, ItemBuildRow
  │
  └─ DetailPanel (collapsed by default)
       ├─ GeneralTab   ── 10 × ScoreboardRow      (eager, no request)
       ├─ BuildPathTab ── placeholder → item-timeline (lazy, only tab that fetches)
       └─ RunesTab     ── 10 × RunePageCard       (eager, no request)

Static_Data_Provider (frontend)
  ├─ champion.json    (existing)
  ├─ item.json        (existing)
  ├─ summoner.json      ← NEW  (Data_Dragon, pinned to DDRAGON_VERSION)
  ├─ runesReforged.json ← NEW  (Data_Dragon, pinned to DDRAGON_VERSION)
  └─ cherry-augments.json ← NEW (Community_Dragon, pinned to DDRAGON_VERSION's major.minor)
```

## Components and Interfaces

### Backend: participant capture

```typescript
/** One of a match's ten participants, trimmed to what the Detail_Panel renders. */
export interface MatchParticipant {
  /**
   * Requirement 6.6/6.7. The analyzed player is marked, not identified: no
   * participant record carries a PUUID, including the analyzed player's own.
   */
  isAnalyzedPlayer: boolean;
  /**
   * Requirement 6.7/6.8. Set from the SAME participant row `opponentOf` chose,
   * never from a champion-name match — Blind Pick (queue 430) is allowlisted
   * and permits mirror picks, so champion identity is not unique within a match.
   * False on every record when no Enemy_Laner was identified.
   */
  isEnemyLaner: boolean;
  /** 100 or 200. */
  teamId: number;
  /** From riotIdGameName/riotIdTagline; summonerName is deprecated and empty. */
  riotIdGameName: string;
  riotIdTagline: string;
  /** Champion_Key, as visual-assets already uses. */
  championName: string;
  champLevel: number;
  /** '' when Riot could not assign one. */
  teamPosition: string;
  summonerSpells: readonly [number, number];
  runes: RunePage;
  /** Reuses visual-assets' ItemBuild and itemBuildOf verbatim. */
  build: ItemBuild;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  visionScore: number;
  damageToChampions: number;
  goldEarned: number;
  win: boolean;
  /** Requirement 3.4/3.6. 'N/A' exactly when the team's total kills is 0. */
  killParticipationPercent: number | 'N/A';
  /**
   * Requirement 12.1/12.2. Zero to six non-zero `playerAugmentN` values, Riot's
   * field order. Always `[]` outside queue 2400 — reading the fields is
   * unconditional; only ARAM Mayhem ever has a non-zero value to find.
   */
  augments: readonly number[];
}

export interface RunePage {
  primaryStyle: number;
  secondaryStyle: number;
  /** Four perk ids in Riot's reported slot order (Requirement 4.5). */
  primarySelections: readonly number[];
  /** Two perk ids in Riot's reported slot order. */
  secondarySelections: readonly number[];
  /** offense, flex, defense — in that order, matching Riot's statPerks keys. */
  statShards: readonly [number, number, number];
}

/** Total and never throwing, matching mapping.ts's existing contract. */
export function toMatchParticipant(
  participant: MatchParticipantDto,
  markers: { isAnalyzedPlayer: boolean; isEnemyLaner: boolean },
  teamKills: number,
): MatchParticipant;

/** Pure. Sums kills per teamId across the participants actually being displayed. */
export function teamKillsOf(participants: readonly MatchParticipantDto[]): Map<number, number>;
```

```typescript
// insight/stats.ts — pure, property-tested, beside the existing csPerMinuteOf.
/** Whole-number percentage, or 'N/A' when teamKills is 0 (Requirement 3.6). */
export function killParticipationOf(
  kills: number,
  assists: number,
  teamKills: number,
): number | 'N/A';
```

**`MatchParticipantDto` must be extended first.** The application's narrowed view of a Riot participant currently declares nineteen fields and none of the ones this feature needs. Requirement 6.3 exists because "capture the participants" would otherwise read as a mapping change when it is really a wire-type change:

```typescript
export interface MatchParticipantDto {
  // ... existing nineteen fields unchanged ...
  summoner1Id?: number;
  summoner2Id?: number;
  perks?: {
    statPerks?: { offense?: number; flex?: number; defense?: number };
    styles?: { description?: string; style?: number; selections?: { perk?: number }[] }[];
  };
  champLevel?: number;
  goldEarned?: number;
  totalDamageDealtToChampions?: number;
  riotIdGameName?: string;
  riotIdTagline?: string;
  playerAugment1?: number;
  playerAugment2?: number;
  playerAugment3?: number;
  playerAugment4?: number;
  playerAugment5?: number;
  playerAugment6?: number;
}
```

Every added field is optional, matching how `teamPosition`, `role` and the item slots are already declared — the module's contract is that a malformed or absent field becomes a neutral value rather than an exclusion, and optionality is what makes that contract expressible in the type.

**How `opponentOf`'s selection reaches the marker — and what "untouched" means here.** `opponentOf` is module-private and returns an `OpponentSummary` carrying no participant identity, so the marker cannot be read off its return value. There is no way to reuse the row it picked without either changing the function or duplicating its `find` — and duplicating it is precisely the ambiguity Requirement 6.7 forbids.

The resolution is to **move the selection, not rewrite it**. The `participants.find(...)` predicate currently inside `opponentOf` is extracted verbatim into:

```typescript
/** The opposing participant sharing `player`'s lane, or undefined. Predicate unchanged. */
function opponentRowOf(
  participants: readonly MatchParticipantDto[],
  player: MatchParticipantDto,
): MatchParticipantDto | undefined;
```

`opponentOf` is refactored to take the already-selected row rather than the full participant list: its signature changes from `(participants, player, durationSeconds)` to `(rival: MatchParticipantDto | undefined, durationSeconds)`, and its body is now only the summarizing half — building an `OpponentSummary` from whatever row it is given. Its output is bit-for-bit what it is today for the same input; `mapping.test.ts`'s existing opponent tests, which observe `toIncludedMatch`'s output and never call `opponentOf` directly, are unaffected by this internal signature change and are the evidence its behaviour did not move. `toIncludedMatch` calls `opponentRowOf` exactly once and hands the result to both consumers: `opponentOf` for the summary, and `toMatchParticipant` for the `isEnemyLaner` marker. One selection, two consumers — which is what extends `visual-assets` Requirement 3.9 (the opponent's items come from the opponent's own row) to spells and runes without restating it.

So: **the selection predicate is unchanged and must stay unchanged; `opponentOf`'s signature is refactored to accept the row `opponentRowOf` already chose, rather than finding it again.** Decision 1 below and the tasks' "`opponentOf` is not to be modified" note both mean the predicate — the selection logic, not the function's parameter list. `mapping.test.ts`'s existing opponent tests are the check that the extraction changed nothing observable.

`RecentMatchSummary` gains two fields:

```typescript
interface RecentMatchSummary {
  // ... every existing field unchanged ...
  /** All ten participants. Empty only if the match carried none. */
  participants: MatchParticipant[];
  /** Requirement 1.6/6.4. Present on IncludedMatch already; not carried here today. */
  queueType: string;
}
```

`durationSeconds` is already carried and already unrendered — Requirement 1.6 only starts displaying it. `queueType` is the one genuinely new scalar: `IncludedMatch` has it, `computeRecentMatches` drops it.

Nothing existing changes shape. `championName`, `opponent`, `build` and the rest stay exactly as they are, so the current Match_Row content keeps rendering from the same fields while the new content reads from `participants`.

### Backend: the laneless capture path (Requirement 11)

`toIncludedMatch` drops a match when `queueTypeForQueueId` returns `undefined` — that is `mapping.ts`'s decision 1, and it is not touched. Queues 450 and 2400 stay outside `QUEUE_TYPE_BY_QUEUE_ID` forever, because that map's whole purpose (decision 2) is gating role-relative computations that a laneless match would corrupt, and Requirement 11.2 keeps it that way. A second, sibling map and a second, sibling function admit exactly these two queues to the recent-matches list without going anywhere near the first:

```typescript
/** Disjoint from QUEUE_TYPE_BY_QUEUE_ID. Never read by any role-relative computation. */
export const LANELESS_QUEUE_TYPE_BY_QUEUE_ID: Readonly<Record<number, 'aram' | 'aram mayhem'>> = {
  450: 'aram',
  2400: 'aram mayhem',
};

export interface LanelessMatch {
  matchId: string;
  startTimestamp: number;
  durationSeconds: number;
  win: boolean;
  queueType: 'aram' | 'aram mayhem';
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  visionScore: number;
  build: ItemBuild;
  /** All ten. isEnemyLaner is false on every one — a Laneless_Match has no lane. */
  participants: MatchParticipant[];
}

/**
 * Parallel to toIncludedMatch. Returns undefined for any queue LANELESS_QUEUE_TYPE_BY_QUEUE_ID
 * does not list. Never calls opponentRowOf or opponentOf — there is no lane to select from.
 */
export function toLanelessMatch(matchDto: MatchDto, puuid: string): LanelessMatch | undefined;
```

`toLanelessMatch` calls `toMatchParticipant` for all ten rows exactly as `toIncludedMatch` does, with `markers.isEnemyLaner` hardcoded `false` for every one (Requirement 11.3) — `toMatchParticipant` itself needs no change to support this, since `isEnemyLaner` is already a caller-supplied marker, not something it derives. Reading `playerAugment1`–`playerAugment6` is unconditional inside `toMatchParticipant`, for every match in every queue — the field is captured the same way regardless of queue, and it is simply always empty outside queue 2400 because Riot never populates it there (verified above). No queue-specific branch exists inside participant capture; the only queue-specific branches are (a) which of the two top-level functions a match reaches, and (b) which tab the frontend shows.

The orchestrator's fetch loop (`orchestrator/index.ts`, the two blocks around `toIncludedMatch` calls) is extended: when `toIncludedMatch` returns `undefined` for a match, the loop now also tries `toLanelessMatch` before discarding it, and pushes a hit to a new `lanelessMatches: LanelessMatch[]` array kept alongside the existing `matches: IncludedMatch[]` array. Every existing consumer of `matches` — `computeStats`, `roleAggregatesOf`, `topChampionsOf`, `mostPlayedRoleOf`, every role-relative function in `insight/stats.ts` — receives exactly the same array it receives today, unchanged in content and unchanged in call signature. Only `computeRecentMatches` gains a second parameter:

```typescript
export function computeRecentMatches(
  matches: readonly IncludedMatch[],
  lanelessMatches: readonly LanelessMatch[],
): RecentMatchSummary[];
```

It merges both by `startTimestamp` descending before slicing to `RECENT_MATCH_LIMIT`, exactly the sort the function already performs — a `LanelessMatch` competes for a recent-matches slot on equal footing with an `IncludedMatch`, which is the point: Requirement 11.1 admits it to the list, not to a separate list.

**`role` needs no new sentinel.** `RecentMatchSummary.role: string` already has a documented empty-string case — `roleOf`'s decision 6 falls back to `''` when neither `teamPosition` nor Riot's `role` field is usable, and `computeFunFacts` already skips its role-preference sentence for a blank role. A `LanelessMatch` sets `role: ''` unconditionally, which is the *existing* "role could not be determined" case, not a new one — Requirement 11.5 costs no branch in any consumer that already handles a normal match with an undetermined role.

### Documented decisions

**1. `opponentOf`'s selection predicate is not touched.** It already selects the lane rival and already returns nothing when no lane could be determined; that predicate is extracted to `opponentRowOf` verbatim and reused, never rewritten or re-derived (see above). The mirrored row reads its stats from `match.opponent` exactly as today; `participants` is additive. This preserves `visual-assets` Requirement 3.9 (an opponent's build comes from the opponent's own participant row) and extends it to spells and runes without restating it.

**2. Kill participation is a pure Insight Engine function, called from the mapping layer.** `ProfileReportView`'s documented decision 1 is that numbers are formatted, never recomputed — every displayed value is already rounded before it reaches the view. Kill participation is a derived percentage, so `killParticipationOf(kills, assists, teamKills)` lives in `insight/stats.ts` alongside `csPerMinuteOf`, reusing the established `number | 'N/A'` encoding that `winRatePercent` already uses for a zero denominator (Requirement 3.6).

It is *called* from `mapping.ts`, inside `toMatchParticipant`, because that is where the participant and its team total are both in scope. That is not a boundary violation — it is the pattern `mapping.ts` already uses: it imports `csPerMinuteOf` from `insight/stats` today and calls it while building both the analyzed player's row and the opponent's. Computation lives in the Insight Engine and is property-tested there; the mapping layer supplies arguments; the view formats. Doing the arithmetic in the component would create a second rounding site no property test covers.

**3. Team totals are summed from the displayed participants, not read from `info.teams[]`.** Riot reports the total directly as `objectives.champion.kills`, and in the sampled match the two agree. They are nonetheless not interchangeable: if they ever disagreed, a kill-participation column derived from `teams[]` would not add up against the kills rendered beside it, and a visitor checking the arithmetic would find the page wrong. Summing what is displayed makes the column self-consistent by construction, and avoids capturing `info.teams[]` at all.

**4. No PUUID reaches the browser for any participant.** Requirement 6.6. `ProfileReportView.test.tsx` already asserts the analyzed player's PUUID is never rendered, and `/api/privacy/delete` exists to erase PUUIDs on request. Shipping nine bystanders' PUUIDs into every match row would extend an identifier well past the person who asked to be looked up. `isAnalyzedPlayer` is a boolean the backend sets while it still has the PUUID in scope; the browser never needs the identifier itself. Riot IDs are displayed, because those are the public in-game names the scoreboard exists to show.

**5. One shared CDN image primitive, not six copies.** `visual-assets` produced `ChampionIcon` and `ProfileIcon`, each independently implementing: resolve a URL, render `<img>` with an `onError` that swaps to `AssetPlaceholder`, render `AssetPlaceholder` immediately when the URL is null. This feature adds four more asset classes. Six hand-written copies of that logic is six places for the error-swap to be forgotten, and `visual-assets` Requirement 5.3 (never render an image whose source could not be constructed) has to hold in all of them. A single `CdnImage` primitive takes `{ url: string | null, alt: string, fallbackLabel: string, size: number }` and owns the swap; the six typed wrappers become one-liners over it. `ChampionIcon` and `ProfileIcon` are refactored onto it, with their existing tests unchanged as the proof the refactor is behaviour-preserving.

**6. "Primary and secondary rune" is read as keystone plus secondary tree.** The brief asked for "primary and secondary rune" beside the portraits. Two readings exist: the two *tree* icons, or the keystone plus the secondary tree icon. This design takes the second, which is what op.gg and dpm.lol both show, for a reason beyond convention: the primary tree is already implied by its keystone (a keystone belongs to exactly one tree), so rendering the primary tree icon spends a slot restating something the keystone beside it already says. Keystone plus secondary tree carries strictly more information in the same space. Requirement 1.2 and Requirement 3.2 are worded identically so the row and the General tab cannot drift apart. The full Rune_Page — including both tree identifiers — is on the Runes tab, so nothing is lost.

**7. The Build Path tab is defined but inert.** Requirement 5.2. An empty tab reads as a bug; a spinner that never resolves reads as a worse bug. It renders an explicit "not yet available" message, and the lazy-fetch path is specified but not built. It also shows **one** player where the neighbouring tabs show ten — Requirement 5.5 states that explicitly, because a panel whose other tabs are ten-wide makes a one-wide tab look like a bug rather than a scope decision.

**8. This provider extension is shared with `live-game`, not duplicated.** That spec's Requirement 7.2 already requires extending the Static_Data_Provider "to resolve summoner-spell identifiers and rune identifiers into display names and image URLs, which the provider does not resolve today", and its design already names four accessors for it. Neither feature is implemented. Requirement 7.8 makes them one extension with two claimants: whichever ships first satisfies the other, and the second must not reimplement it. `live-game` additionally needs a numeric-champion-id accessor (its Requirement 7.3) that this feature does not — that stays its own, since Spectator-V5 reports champions numerically while Match-V5 reports keys.

This also settles a conflict that would otherwise be silent. `live-game` Requirement 7.5 says the provider's version pinning "SHALL be inherited … and SHALL NOT restate or vary" it. Rune icons cannot be pinned at all. The exception is therefore recorded in `visual-assets` — where the invariant is actually stated — rather than in either consumer, so `live-game` inherits the amended rule rather than contradicting an unamended one.

**9. The persisted index's storage key must be bumped.** `frontend/src/staticData/cache.ts` keys the persisted index `lolprofiles.staticData.v1`, validates it by shape, and its own comment observes that "nothing enforces that coupling". A returning visitor holds a v1 entry containing champions and items only. Adding spell and rune maps without changing the key means that entry still validates, still matches the pinned version, short-circuits the CDN fetch, and serves placeholders for every spell and rune for a full 24 hours — presenting as Requirement 9.1's degradation path while nothing is actually wrong. Requirement 7.9 makes the bump part of the change rather than something to remember.

**10. The Enemy_Laner is marked, never matched.** Requirement 6.7 forbids deriving the marker from a champion identifier, and the reason is concrete rather than theoretical: Blind Pick (queue 430) is in the allowlisted queue set, and Blind Pick permits mirror matchups. In a mirror lane, matching the opponent by champion name selects a set of two, and picking either one is a coin flip that will silently attribute the wrong player's runes to the opposing side. The marker is set from the row the existing selection already chose, so the ambiguity never arises.

**11. Placeholder text alternatives name the subject here, unlike elsewhere.** `AssetPlaceholder`'s documented decision 2 labels the *absence* ("Champion icon unavailable") rather than the subject, justified because every existing call site renders the champion's name as text beside the icon. That justification does not hold for a scoreboard of bare spell and rune icons with no adjacent text. `ItemBuildRow` already resolves this the right way — `${name} unavailable` — and Requirement 8.4 generalises that precedent rather than inventing a third convention.

**12. Augments come from Community_Dragon, pinned by deriving a version from `DDRAGON_VERSION` rather than by adding a second configuration value.** Data_Dragon serves no augment data at all — verified 403 on every path tried (see the verified-facts table above). Community_Dragon is a separate CDN, but it accepts the same pinning discipline `visual-assets` Requirement 4 already requires: a specific version, never `"latest"`. Rather than introduce a second env var that could drift from `DDRAGON_VERSION`, the major-and-minor pair is derived from the one value already configured (`"16.17.1"` → `"16.17"`), verified live to resolve. This keeps a single source of truth for "which patch does this deployment render" even though two CDNs now serve it.

**13. No augment description or tooltip text in this feature.** The only data source with description text (`cdragon/arena/en_us.json`) is Arena's augment pool on a different `id` numbering, and a name-based cross-check against ARAM Mayhem's 170 augments matches only 108 of them through an unverified `+1000` id offset that held for 101 and diverged for 7 of those matches. Shipping descriptions on that foundation would silently misdescribe an unknown number of augments with no way to detect which. Requirement 12.8 ships name-only; a verified description source is left to a later feature.

**14. `LanelessMatch` is its own type, not `IncludedMatch`.** `IncludedMatch` carries fields — CS-per-minute already computed against a lane assumption, an opponent, a role — that a lane-relative reading would misuse if a laneless match were ever passed to a role-relative function by mistake. Keeping the two types structurally distinct (rather than, say, an `IncludedMatch` with an optional laneless flag) means `computeStats`, `roleAggregatesOf` and the rest simply do not compile against a `LanelessMatch[]` — the type system enforces decision-2's boundary from `mapping.ts` (a laneless match must never feed a role-relative computation) rather than relying on every future call site remembering a runtime filter.

### Frontend: Static_Data_Provider extension

Eight accessors are added, in the same total style the existing six use — a URL or `null`, a name or a documented fallback, never a throw and never a URL containing `undefined`:

```typescript
interface StaticDataProvider {
  // ... existing six unchanged ...
  summonerSpellIconUrl(id: number): string | null;
  summonerSpellDisplayName(id: number): string;
  runeIconUrl(id: number): string | null;
  runeDisplayName(id: number): string;
  runeTreeIconUrl(styleId: number): string | null;
  runeTreeDisplayName(styleId: number): string;
  statShardIconUrl(id: number): string | null;
  statShardDisplayName(id: number): string;
  /** Requirement 12.5. Community_Dragon, not Data_Dragon — see decision 12 below. */
  augmentIconUrl(id: number): string | null;
  augmentDisplayName(id: number): string;
}
```

Index building, from the two new files:

- **`summoner.json`** is keyed by spell *name* (`SummonerFlash`), with the numeric identifier in `key` **as a string** (`"4"`) and the file in `image.full`. Match-V5 reports `summoner1Id` as a *number*. The index must therefore be inverted to `Record<numericId, { name, image }>` at build time, with the string-to-number conversion done once rather than at every lookup. Arena variants (`SummonerBarrier_Jade`, id 721) appear in the file and are indexed identically — no special-casing, they are simply spells this build may never see.
- **`runesReforged.json`** is an array of five trees, each `{ id, key, name, icon, slots[].runes[] }`. Two flat maps are derived: rune id → `{ name, icon }` across every tree and slot, and tree id → `{ name, icon }`.
- **Stat shards** come from a hardcoded table, since Data_Dragon publishes none:

| id | name | file (all verified 200) | Task 1.2 status |
|---|---|---|---|
| 5001 | Health Scaling | `StatModsHealthScalingIcon.png` | **Observed** — 192 of 228 sampled participants |
| 5002 | Armor | `StatModsArmorIcon.png` | Still inferred — not observed in any of 228 sampled participants |
| 5003 | Magic Resist | `StatModsMagicResIcon.png` | Still inferred — not observed in any of 228 sampled participants |
| 5005 | Attack Speed | `StatModsAttackSpeedIcon.png` | **Observed** — 110 of 228 |
| 5007 | Ability Haste | `StatModsCDRScalingIcon.png` | **Observed** — 20 of 228 |
| 5008 | Adaptive Force | `StatModsAdaptiveForceIcon.png` | **Observed** — 268 of 228 (one participant can carry it in more than one slot) |
| 5010 | Movement Speed | `StatModsMovementSpeedIcon.png` | **Observed** — 5 of 228 |
| 5011 | Health | `StatModsHealthPlusIcon.png` | **Observed** — 31 of 228 |
| 5013 | Tenacity | `StatModsTenacityIcon.png` | **Observed** — 4 of 228 |

The **files** are verified to exist (unchanged from the original check). The **identifier-to-file mapping** is now confirmed for seven of nine ids: task 1.2 sampled 228 real participants across 22 matches (20 five-queue matches plus 2 standard ARAM matches, spanning ranked solo, ranked flex, normal, and ARAM), covering every `perks.statPerks` value present in that sample. `5002` (Armor) and `5003` (Magic Resist) were not observed even once — Riot's current defensive stat-shard row appears not to offer flat Armor/Magic Resist any more, which would make those two rows of this table legacy identifiers this codebase may never actually need, not merely unsampled ones. They remain in the table, unverified, because removing them outright would be asserting their absence as fact when the sample only failed to observe them — a different, weaker claim. `statShardIconUrl`/`statShardDisplayName` (task 1.4) can be built on the seven confirmed rows; `5002`/`5003` should not be treated as more trustworthy than "the file exists" until a match is found that actually reports one, if any still can.

One further real value showed up in the sample and belongs in this record even though it is not a stat shard: `0` appeared for one of the three `statPerks` slots on 54 of 228 participants (in the queue-1750 Arena match sampled during the broader ARAM verification, whose eighteen participants report `statPerks` sparsely or not at all — that match is out of this feature's scope per the queue allowlist, so `0` here is not a case `statShardIconUrl` needs to resolve specially; `isUsableId`'s existing `id === 0` handling for items does not apply to stat shards, and no stat-shard accessor should special-case `0` unless a future in-scope match is found reporting it).

- **`cherry-augments.json`** (Community_Dragon, not Data_Dragon) is fetched from `https://raw.communitydragon.org/{major}.{minor}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json`, where `{major}.{minor}` is derived by splitting the configured `DDRAGON_VERSION` (`"16.17.1"` → `"16.17"`) rather than requesting Community_Dragon's own `"latest"` alias. It is an array of `{ id, augmentNameId, nameTRA, augmentSmallIconPath, rarity }`; the index maps `id` → `{ name: nameTRA, iconPath: augmentSmallIconPath }`. An icon URL is built by lowercasing `augmentSmallIconPath`, stripping its leading `/lol-game-data/assets/` segment, and appending the remainder to `https://raw.communitydragon.org/{major}.{minor}/plugins/rcp-be-lol-game-data/global/default/` — verified live to return 200 for a sampled augment at version `16.17`.

### Frontend: components

```typescript
function MatchRow(props: { match: RecentMatchSummary }): JSX.Element;
function MatchSide(props: { side: 'player' | 'opponent'; /* ... */ }): JSX.Element;
function DetailPanel(props: { match: RecentMatchSummary }): JSX.Element;
function GeneralTab(props: { participants: readonly MatchParticipant[] }): JSX.Element;
function RunesTab(props: { participants: readonly MatchParticipant[] }): JSX.Element;
function AugmentsTab(props: { participants: readonly MatchParticipant[] }): JSX.Element;
function BuildPathTab(props: { matchId: string }): JSX.Element;

function CdnImage(props: { url: string | null; alt: string; fallbackLabel: string; size: number }): JSX.Element;
```

**Which third tab renders** (Requirement 12.3) is a switch on `queueType`, decided once per `DetailPanel`, not per Participant: `queueType === 'aram mayhem'` renders `AugmentsTab`, every other value — including `'aram'` — renders `RunesTab`. The tab's own label reads "Runes" or "Augments" accordingly; General and Build Path are unaffected and unlabeled differently. `AugmentsTab` reuses the same participant ordering and grouping `RunesTab` uses, reading `MatchParticipant.augments` instead of `.runes`.

**Tab semantics** (Requirement 2.6) follow the WAI-ARIA tabs pattern: a `role="tablist"` of `role="tab"` buttons, each with `aria-selected` and `aria-controls` pointing at its `role="tabpanel"`, and left/right arrow keys moving between tabs. Expansion state and selected tab are per-row `useState` in `MatchRow`, which is what makes Requirement 2.5's independence automatic rather than something to enforce.

**Participant ordering** (Requirement 3.8) sorts each team block by `teamPosition` against the fixed `Position_Order` constant `TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY`. The constant lives in one place and both tabs read it, so General and Runes cannot disagree (Requirement 4.1).

Ordering reads `teamPosition` **directly**, not through `roleOf`. `roleOf` exists to produce a single role string for the analyzed player and falls back to Riot's coarser `role` field (`SOLO`, `CARRY`, `SUPPORT`, `DUO`, `NONE`) when `teamPosition` is blank — values from which no lane ordering can be derived. Sorting on its output would mean sorting on a mixture of two vocabularies. Reading `teamPosition` directly gives exactly six cases: the five `Position_Order` values, and everything else. "Everything else" is not only the empty string — it is any value outside the five — which is why Requirement 3.8 is worded as membership in `Position_Order` rather than as "could not be determined".

## Scope: which matches reach this feature

Eight queue ids reach the recent-matches list, through two disjoint paths. `QUEUE_TYPE_BY_QUEUE_ID` in `mapping.ts` allowlists six — 400 Draft, 420 Solo, 430 Blind, 440 Flex, 480 Swiftplay, 490 Quickplay — all 5v5 Summoner's Rift games with lane assignment, and its documented decision 1 makes that allowlist fail-safe: any other queue is excluded from `toIncludedMatch` entirely. `LANELESS_QUEUE_TYPE_BY_QUEUE_ID` separately allowlists two more — 450 ARAM and 2400 ARAM Mayhem — through `toLanelessMatch`, which never touches the first map and never feeds a role-relative computation (Requirement 11.2, decision 14). **Clash, Co-op vs AI and every rotating event mode still never appear anywhere** — neither map lists them, so they are excluded from both paths exactly as before.

This means the design does need to handle a lane-less game shape, but in exactly one place: `toLanelessMatch` and the `LanelessMatch` type it produces. Nothing else changes — `computeStats`, `roleAggregatesOf`, `topChampionsOf` and every other role-relative function in `insight/stats.ts` still only ever see the six-queue `matches` array, unchanged in content, and still have no lane-less case to handle because one is never given to them.

The one consequence worth carrying forward from the original six-queue scope is the opposite of the obvious one: Blind Pick is allowlisted, and Blind Pick permits the same champion on both teams. Champion identity is therefore **not** unique within a match, which is why the Enemy_Laner is marked rather than matched (decision 10 above, Requirement 6.7). A Laneless_Match sidesteps this question entirely — it has no Enemy_Laner to mark, mirror pick or not.

## Payload budget

Adding ten participants to each of ten matches is the one real cost. Measured against the field list above, a serialized participant is roughly 520 bytes, dominated by JSON key names rather than values:

| | raw | gzipped (est.) |
|---|---|---|
| Current `ProfileReport` | ~20 KB | ~4 KB |
| + 100 participant records | ~52 KB | ~7 KB |
| **Total** | **~72 KB** | **~11 KB** |

Roughly a tripling of raw size for a payload that compresses well and is fetched once per lookup. This scales linearly with `RECENT_MATCH_LIMIT` (currently 10), which is the number to revisit first if the payload ever becomes a problem — not the participant slice.

This estimate is scoped to today's `RECENT_MATCH_LIMIT` of 10. The roadmap's later `profile-sidebar` feature widens the transported match count independently of the displayed count (its `RECENT_MATCH_TRANSPORT_LIMIT`); once that ships, this table's totals no longer hold and must be re-measured against the widened count, not recomputed by substituting the new limit into this table's linear scaling — the two changes compound and neither spec's original figure should be assumed to still apply.

## Error Handling

| Trigger | Behavior | Visitor sees |
|---|---|---|
| `summoner.json` / `runesReforged.json` fetch fails | Provider stays not-ready for those accessors; every URL resolves `null` | Full rows and tabs, `AssetPlaceholder` for each spell and rune |
| Spell / rune / tree / shard id absent from the pinned version | Accessor returns `null` | `AssetPlaceholder`, numeric id as its text alternative |
| Rune icon 404s at the CDN (unversioned path drifted) | `CdnImage`'s `onError` swaps | `AssetPlaceholder`, no layout shift |
| A participant's `perks` absent or malformed | Rune page renders as unavailable; participant still listed | Requirement 9.2 |
| Match has fewer than ten participants | Render what exists | Requirement 6.11 |
| Team's total kills is 0 | `killParticipationPercent` is `'N/A'` | Requirement 3.6 |
| No Enemy_Laner (a six-queue match with no identifiable lane opponent) | Right side of the row is the existing no-opponent notice; **General and Runes tabs are unaffected** and still show all ten | Requirements 1.7, 9.5 |
| A Laneless_Match (queue 450 or 2400) | Right side of the row is the same no-opponent notice, unconditionally; role is suppressed; General and Runes(/Augments) tabs still show all ten | Requirements 11.4, 11.5, 11.6 |
| A Participant's captured augments number fewer than six | Remaining augment slots render empty, not unavailable | Requirement 12.9 |
| An augment identifier absent from `cherry-augments.json` | `AssetPlaceholder`, naming the augment as its subject | Requirement 12.7 |
| Build Path tab selected, `item-timeline` not shipped | Explicit not-yet-available message | Requirement 5.2 |

The "No Enemy_Laner" and "Laneless_Match" rows above look similar but arise differently, and the General/Runes tabs do **not** depend on either. For a six-queue match (400/420/430/440/480/490), a missing Enemy_Laner means `opponentRowOf` found no participant on the opposing team sharing the analyzed player's role — every participant still has a real `teamPosition`, so the General and Runes tabs order and render normally. For a Laneless_Match, `isEnemyLaner` is `false` on every participant by construction (`toLanelessMatch` never calls `opponentRowOf`), and `teamPosition` is blank on all ten, which Requirement 3.8's existing membership test already resolves to "preserve Riot's reported order" rather than a crash or an empty tab. Either way the tabs render all ten; only the mirrored row's right-hand side degrades, and only the Laneless_Match case additionally suppresses the role and (for queue 2400) swaps the third tab.

## Correctness Properties

### Property 1: Kill participation is total, bounded, and team-local
For any set of participants, every `killParticipationPercent` is either `'N/A'` or a non-negative whole number; it is `'N/A'` exactly when that participant's own team's summed kills is zero; and changing any participant's kills on the *other* team never changes it.
**Validates: Requirements 3.4, 3.5, 3.6**

### Property 2: Participant capture preserves the match
For any `MatchDto`, the captured participants are the same count as the source, partitioned by `teamId` exactly as the source is, and exactly one is marked `isAnalyzedPlayer` when the analyzed player's PUUID appears among them.
**Validates: Requirements 6.1, 6.7, 6.11**

### Property 3: No participant record carries a PUUID
For any assembled `ProfileReport`, no object within any `recentMatches[].participants[]` has a `puuid` field, and no PUUID string value appears anywhere within that array — including the analyzed player's own.
**Validates: Requirements 6.6, 6.9**

### Property 4: The four new asset URL families are total
Mirrors `visual-assets` Property 2 for `summonerSpellIconUrl`, `runeIconUrl`, `runeTreeIconUrl` and `statShardIconUrl` — mirrors rather than extends, because Property 2 asserts the URL contains the pinned version, which is false by construction for three of these four families (Requirement 7.4). Only the totality half carries over: for any input including `0`, negatives, non-integers, ids absent from the metadata, and **prototype-chain keys** (`constructor`, `toString`, `__proto__`, `hasOwnProperty`), each returns a URL or `null` — never a throw, never a URL containing the literal `undefined` — both before and after the provider is ready.
**Validates: Requirements 7.2, 7.3, 7.11, 9.3**

### Property 5: The Enemy_Laner marker comes from the opponent's own row
For any match in which an Enemy_Laner was identified, exactly one participant carries `isEnemyLaner`, that participant is on the opposite team to the Analyzed_Player, and its champion, items, spells and runes are the ones on the participant record the opponent selection chose — including when both teams played the same champion in that lane. When no Enemy_Laner was identified, no participant carries the marker.
**Validates: Requirements 6.7, 6.8**

### Property 6: Rune order is preserved
For any `perks` payload, the rendered primary selections appear in the same order Riot reported them, and likewise the secondary selections — no sort, no dedupe, no reordering.
**Validates: Requirement 4.5**

### Property 7: A Laneless_Match never reaches a role-relative computation
For any set of matches passed through `toIncludedMatch` and `toLanelessMatch`, no match classified by `LANELESS_QUEUE_TYPE_BY_QUEUE_ID` appears in the `matches` array `computeStats`, `roleAggregatesOf`, `topChampionsOf` or `mostPlayedRoleOf` receive, and every `MatchParticipant` produced by `toLanelessMatch` has `isEnemyLaner` equal to `false`. For any participant in any queue, `augments` contains only the non-zero values among that participant's six `playerAugment` fields, in Riot's reported order, and is empty for every queue other than 2400.
**Validates: Requirements 11.2, 11.3, 12.1, 12.2**

## Testing Strategy

Property tests use `fast-check`, minimum 100 runs, tagged `// Feature: match-detail-tabs, Property {n}: {property text}`. Property 4 in particular must include the prototype-chain keys explicitly: `visual-assets` task 2.2 records that a hand-written sweep missed exactly that case and produced a URL ending in the literal `undefined`.

**Unit tests**: kill participation at a zero denominator and at 100%; `toMatchParticipant` against a malformed participant (absent `perks`, non-numeric spells, missing `riotIdGameName`); the summoner-spell index inversion (string `key` → numeric lookup); stat shard resolution for all nine ids; participant ordering with a blank `teamPosition`; `toLanelessMatch` against queue 450 and queue 2400 fixtures, and its return of `undefined` for every other queue; a queue-2400 participant with zero, some, and six non-zero `playerAugment` values.

**Component tests**: panels collapsed on first render; tab switching is per-row independent; General and Runes list ten participants in identical order; the analyzed player's row is distinguishable; Build Path shows its message; no `<img>` renders when the provider is not ready; a queue-450 match renders the Runes tab and a queue-2400 match renders the Augments tab in its place; a Laneless_Match's row shows no opposing side and no role text.

**Live verification** (already done, recorded above): CDN paths and status codes for all four original new asset classes plus Community_Dragon's augment metadata and icon path, metadata file sizes and CORS, the Match-V5 field names, both ARAM queue ids against Riot's queue table, and the stat shard identifier mapping for seven of nine ids against 228 real participants (task 1.2). What remains unverified: two stat shard rows (5002 Armor, 5003 Magic Resist) never observed in that sample, possibly no longer offered by the game at all; and — more consequentially — whether `cherry-augments.json`'s `id` field is the same id space Match-V5 reports in `playerAugmentN` (task 10.2), since no live queue-2400 match could be sampled during design.

## Interaction with `item-timeline`

That spec is written and not yet implemented. This feature changes where its output goes, and **its documents have already been amended to match** — `item-timeline`'s Requirements 3.8-3.10, its `BuildPathView` design section, its sequence flow, its task 8.2 and its Notes were all updated when this spec was written. Nothing below is outstanding work; it is the record of what that amendment established:

1. **The Build Path has a home.** `item-timeline` previously specified retrieval, replay, and reconciliation without naming a UI surface. It now renders in this feature's Build Path tab, replacing the placeholder.
2. **Lazy retrieval already agrees.** `item-timeline` Requirement 1.1 forbids fetching a timeline during Profile_Report assembly; this feature's Requirement 5.4 fetches only on tab selection, which satisfies it. No conflict to resolve — the two were independently written to the same constraint.
3. **The tab must own loading and failure states** that `item-timeline` Requirement 1.5 describes (a timeline that is unavailable is reported as unavailable, not as an error).
4. **`item-timeline`'s component classification is already available.** `isCompletedItem` exists on the Static_Data_Provider from `visual-assets`, so the Build Path can distinguish components from completed items without new metadata.

## Riot Compliance

Requirement 10. Nothing here is new machinery — the Detail_Panel renders inside `ProfileReportView`, which already renders inside `RiotDataPage`, so attribution and the no-advertising default apply by inheritance rather than by re-implementation. The two obligations this feature adds are that the four new asset classes are served unmodified from Riot's distribution (they are hot-linked from Data_Dragon exactly as champion and item images already are), and that no advertising slot is introduced inside a Match_Row or Detail_Panel — the existing agreement-gated mechanism in `compliance/advertisingPolicy.ts` remains the only place one can appear.

## Open Questions

1. **The augment identifier mapping is unverified, and this is the most consequential open item in the design.** `cherry-augments.json`'s `id` field is this codebase's only candidate for what Match-V5's `playerAugmentN` fields report, and it was never cross-checked against a live ARAM Mayhem match, because none could be sampled (the mode was not queueable by any of the 40 accounts checked during design). Unlike the stat shard table below — where the risk is a handful of wrong icons — a wrong id space here means every augment name and icon in the tab is wrong, silently, with no error to surface it. Task 10.2 must obtain and check a real queue-2400 match before `augmentIconUrl`/`augmentDisplayName` ship as trustworthy, exactly as task 1.2 already does for stat shards, but this one blocks Requirement 12 in full, not one asset class within it.
2. **Stat shard identifier mapping** — resolved for seven of nine ids by task 1.2 against 228 real participants. `5002` (Armor) and `5003` (Magic Resist) remain unobserved and unverified; they may be legacy identifiers the current game no longer assigns. Left in the table rather than removed, since non-observation does not establish absence.
3. **Unversioned rune icons are a standing risk, not a solved problem.** A Riot art update changes rune imagery without a deploy. This is unavoidable (the versioned path 403s) and low-consequence (an icon changes appearance; nothing is misreported), but it is the one place `DDRAGON_VERSION` does not fully control what the site renders. Requirement 7.5/7.6 require it be recorded in `visual-assets` where the invariant is stated, and task 8.2 puts it in the README's Assets section.
4. **Resolved, recorded here so it is not re-opened:** the Static_Data_Provider extension is shared with `live-game` (Requirement 7.8), the Enemy_Laner is marked rather than champion-matched (Requirement 6.7), the persisted index's storage key must be bumped (Requirement 7.9), and augment description text is deliberately out of scope rather than an oversight (Requirement 12.8, decision 13). Each was a live defect, or a live temptation, in an earlier draft of this design.
