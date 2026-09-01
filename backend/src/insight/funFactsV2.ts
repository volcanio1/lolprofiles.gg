/**
 * Insight Engine — Fun Facts v2 (`computeFunFactsV2`).
 *
 * `player-insights` spec. Replaces the removed `funFacts.ts` (time-of-day,
 * champion loyalty, role preference, streak) with narrower, more specific
 * facts: Nemesis, longest game, favorite item(s), most-used ping, average
 * KDA, average gold diff at 10.
 *
 * PURE MODULE, same discipline as every other file in `backend/src/insight/`:
 * no network, cache, database, `process.env`, HTTP, logging, or wall-clock
 * read. Every value is derived from the `IncludedMatch[]`/`LanelessMatch[]`/
 * `EarlyGameAggregate[]` the caller supplies.
 *
 * Implements:
 *  - Requirement 2: Nemesis — the enemy champion with the lowest win rate
 *    against the analyzed player, minimum `NEMESIS_MIN_GAMES` games.
 *  - Requirement 3: longest game by duration, tie-broken to the most recent.
 *  - Requirement 4: favorite item(s) — the most-built non-boot, non-empty
 *    final-inventory items, by frequency.
 *  - Requirement 5: most-used ping — the highest-total ping field across the
 *    window, from the fourteen fields `player-insights` task 2 added.
 *  - Average KDA — (kills + assists) / deaths across the same merged window
 *    every other category here reads, reusing `stats.ts#averageKdaOf`.
 *  - Average gold diff at 10 — reuses whatever `earlyGame` data Performance
 *    Feedback's Phase 2 already computed (see `averageGoldDiffAt10Of`),
 *    rather than fetching or computing anything new.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. `FunFactV2` GAINS AN OPTIONAL `favoriteItems` FIELD, BEYOND design.md's
 *    SKETCHED `{category, text}` SHAPE. The backend Insight_Engine has no
 *    Static_Data_Provider dependency (design.md's Data Models section is
 *    explicit about this), so it cannot itself turn an item id into a name or
 *    icon — but Requirement 4.6 requires the FRONTEND to do exactly that. A
 *    frontend that only receives a prose `text` string has no item ids to
 *    resolve at all. `favoriteItems` — the same `FavoriteItem[]` shape
 *    `favoriteItemsOf` already returns — is populated only on the
 *    `favoriteItems` category and is the structured data the frontend
 *    actually renders icons from; `text` remains a readable fallback for
 *    accessibility, screen readers, and anything that only reads prose.
 *
 * 2. NEMESIS WIN RATE COMPARISON USES INTEGER CROSS-MULTIPLICATION, NOT THE
 *    ROUNDED DISPLAY PERCENT. Two champions can round to the same whole-percent
 *    win rate while differing in the exact fraction (e.g. 33% from 1/3 vs. 33%
 *    from 33/100), so comparing on `roundHalfUp`'s output could pick the wrong
 *    champion or reach the tie-break rule on a false tie. `a.wins * b.games`
 *    vs `b.wins * a.games` compares the exact fractions with no floating-point
 *    error, for any positive game count — the same style `compareBanCandidates`
 *    (clash-scouting) already uses for a total order over generated values.
 *    The rounded percent is computed once, at the end, purely for display.
 *
 * 3. AN OPPONENT WITH A BLANK CHAMPION NAME IS EXCLUDED FROM NEMESIS. A blank
 *    name cannot appear in the eventual sentence ("Your nemesis: "), the same
 *    reasoning `funFacts.ts`'s removed `isBlankName` guard already established
 *    for role/champion names.
 *
 * 4. LONGEST GAME's TIE-BREAK IS ORDER-INDEPENDENT. `longestGameOf` folds over
 *    the match list keeping the best-so-far by `(durationSeconds, startTimestamp)`
 *    descending — replacing only on a strictly later timestamp at equal
 *    duration — so the result does not depend on the input array's order, the
 *    same purity guarantee every other Insight_Engine derivation gives.
 *
 * 5. THE BOOT EXCLUSION LIST WILL DRIFT, AND THAT IS STATED HERE RATHER THAN
 *    HIDDEN. `BOOT_ITEM_IDS` covers the boot line's ids as of this writing.
 *    Riot adds/renames boot tiers across seasons (Season 14 introduced
 *    upgraded boot enchants this list does NOT attempt to cover, since their
 *    exact ids were not independently verified while writing this module) —
 *    the same class of honesty this codebase already applies to the stat-shard
 *    and ARAM-Mayhem-augment tables in `README.md`'s Assets section. A missed
 *    new boot id degrades gracefully: it just shows up as an oddly-common
 *    "favorite item" rather than breaking anything.
 *
 * 6. MOST-USED PING READS ONLY THE ANALYZED PLAYER'S OWN ROW.
 *    `MatchParticipant.onMyWayPings`/etc. exist on all ten rows of a
 *    Full_Lobby (added generically in `player-insights` task 2, matching how
 *    `killParticipationPercent` already works), but this fact is about the
 *    analyzed player specifically, so only the row with `isAnalyzedPlayer`
 *    is read; a match whose `participants` is absent (an older cached match,
 *    or one with no Full_Lobby) contributes nothing to the tally rather than
 *    failing.
 *
 * 7. FUN FACTS ALSO READ Laneless_Match DATA (ARAM / ARAM Mayhem) — "all the
 *    data we have", not only Summoner's Rift. `computeFunFactsV2` takes an
 *    optional second `lanelessMatches` parameter and adapts each one to the
 *    `IncludedMatch` shape via `lanelessAsIncludedMatch` (`role: ''`,
 *    `opponent: undefined`) before folding it in with `matches`. This costs
 *    nothing extra to make correct: `nemesisOf` already skips any match with
 *    no `opponent`, so a Laneless_Match — which structurally has no lane and
 *    therefore no Lane_Opponent — is automatically excluded from Nemesis by
 *    the same rule that already excludes a Summoner's Rift match with no
 *    identifiable opponent, without adding a queueType check anywhere.
 *    `longestGameOf`/`favoriteItemsOf`/`mostUsedPingOf` need no such
 *    exclusion — duration, item builds and pings are meaningful in every
 *    queue — so they read the full merged set.
 */

import type { EarlyGameAggregate } from './performanceFeedback';
import { averageKdaOf, round2, roundHalfUp, type IncludedMatch, type LanelessMatch } from './stats';

/** Decision 7: a Laneless_Match has no lane, so `role`/`opponent` are always neutral/absent. */
function lanelessAsIncludedMatch(match: LanelessMatch): IncludedMatch {
  return {
    matchId: match.matchId,
    queueType: match.queueType,
    startTimestamp: match.startTimestamp,
    durationSeconds: match.durationSeconds,
    championName: match.championName,
    role: '',
    win: match.win,
    kills: match.kills,
    deaths: match.deaths,
    assists: match.assists,
    visionScore: match.visionScore,
    cs: match.cs,
    build: match.build,
    participants: match.participants,
  };
}

// ---------------------------------------------------------------------------
// Requirement 2 — Nemesis
// ---------------------------------------------------------------------------

/** Requirement 2.2: minimum games against a champion before it can be named Nemesis. */
export const NEMESIS_MIN_GAMES = 3;

export interface NemesisResult {
  championName: string;
  wins: number;
  losses: number;
  gamesPlayed: number;
  /** Whole percent, `roundHalfUp` — display only; the selection itself compares exact fractions (decision 2). */
  winRatePercent: number;
}

interface ChampionRecord {
  championName: string;
  wins: number;
  losses: number;
}

/**
 * Requirement 2.3's total order over eligible champions: lowest win rate
 * first, tie broken by higher game count, tie broken by name ascending.
 * Negative when `a` is the WORSE nemesis matchup for the player (i.e. `a`
 * should sort before `b`).
 */
function compareNemesisCandidates(a: ChampionRecord, b: ChampionRecord): number {
  const gamesA = a.wins + a.losses;
  const gamesB = b.wins + b.losses;
  const crossA = a.wins * gamesB;
  const crossB = b.wins * gamesA;
  if (crossA !== crossB) {
    return crossA - crossB; // lower win rate (smaller cross product) first
  }
  if (gamesA !== gamesB) {
    return gamesB - gamesA; // higher game count first
  }
  return a.championName < b.championName ? -1 : a.championName > b.championName ? 1 : 0;
}

/** Requirement 2. `undefined` when no champion meets `NEMESIS_MIN_GAMES` (2.4). */
export function nemesisOf(matches: readonly IncludedMatch[]): NemesisResult | undefined {
  const records = new Map<string, ChampionRecord>();
  for (const match of matches) {
    if (match.opponent === undefined) {
      continue;
    }
    const championName = match.opponent.championName;
    if (typeof championName !== 'string' || championName.trim().length === 0) {
      continue; // decision 3
    }
    const record = records.get(championName) ?? { championName, wins: 0, losses: 0 };
    if (match.win) {
      record.wins += 1;
    } else {
      record.losses += 1;
    }
    records.set(championName, record);
  }

  const eligible = [...records.values()].filter((record) => record.wins + record.losses >= NEMESIS_MIN_GAMES);
  if (eligible.length === 0) {
    return undefined;
  }
  eligible.sort(compareNemesisCandidates);
  const worst = eligible[0];
  const gamesPlayed = worst.wins + worst.losses;
  return {
    championName: worst.championName,
    wins: worst.wins,
    losses: worst.losses,
    gamesPlayed,
    winRatePercent: roundHalfUp((100 * worst.wins) / gamesPlayed),
  };
}

// ---------------------------------------------------------------------------
// Requirement 3 — longest game
// ---------------------------------------------------------------------------

/** Requirement 3. `undefined` for an empty match window (3.3). */
export function longestGameOf(matches: readonly IncludedMatch[]): IncludedMatch | undefined {
  let longest: IncludedMatch | undefined;
  for (const match of matches) {
    if (
      longest === undefined ||
      match.durationSeconds > longest.durationSeconds ||
      (match.durationSeconds === longest.durationSeconds && match.startTimestamp > longest.startTimestamp)
    ) {
      longest = match; // decision 4: order-independent fold
    }
  }
  return longest;
}

/** `2712` -> `"45m 12s"`. Pure integer arithmetic, no `Date`. */
function formatDurationSeconds(durationSeconds: number): string {
  const total = Math.max(0, Math.round(durationSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Requirement 4 — favorite item(s)
// ---------------------------------------------------------------------------

/** Requirement 4.4: how many top items are reported. */
export const FAVORITE_ITEM_COUNT = 3;

/**
 * Decision 5: the classic boot line's item ids, stable across many seasons.
 * Excluded from the favorite-items tally (Requirement 4.2) because boots are
 * bought in nearly every game and are not a distinguishing habit. Does NOT
 * cover Season 14+ boot-upgrade enchants — see decision 5.
 */
export const BOOT_ITEM_IDS: ReadonlySet<number> = new Set([
  1001, // Boots
  3006, // Berserker's Greaves
  3009, // Boots of Swiftness (legacy id)
  3020, // Sorcerer's Shoes
  3047, // Plated Steelcaps
  3111, // Mercury's Treads
  3117, // Boots of Swiftness
  3158, // Ionian Boots of Lucidity
]);

export interface FavoriteItem {
  itemId: number;
  count: number;
}

/**
 * Requirement 4: item ids tallied across every match's final `build.items`,
 * boots and empty slots excluded, top `FAVORITE_ITEM_COUNT` by frequency, tie
 * broken by item id ascending (4.4 — there is no item name to break ties by;
 * see decision 1).
 */
export function favoriteItemsOf(matches: readonly IncludedMatch[]): FavoriteItem[] {
  const counts = new Map<number, number>();
  for (const match of matches) {
    if (match.build === undefined) {
      continue;
    }
    for (const itemId of match.build.items) {
      if (itemId === 0 || BOOT_ITEM_IDS.has(itemId)) {
        continue;
      }
      counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([itemId, count]) => ({ itemId, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.itemId - b.itemId))
    .slice(0, FAVORITE_ITEM_COUNT);
}

// ---------------------------------------------------------------------------
// Requirement 5 — most-used ping
// ---------------------------------------------------------------------------

/** Decision 6 / Requirement 5.2's fixed tie-break order — Riot's own field order in the Match-V5 schema. */
export const PING_FIELD_ORDER = [
  'allInPings',
  'assistMePings',
  'basicPings',
  'commandPings',
  'dangerPings',
  'enemyMissingPings',
  'enemyVisionPings',
  'getBackPings',
  'holdPings',
  'needVisionPings',
  'onMyWayPings',
  'pushPings',
  'retreatPings',
  'visionClearedPings',
] as const;
export type PingField = (typeof PING_FIELD_ORDER)[number];

export interface PingTally {
  field: PingField;
  count: number;
}

/** Human-readable labels for the frontend (Requirement 5.4), kept beside the field order they label. */
export const PING_FIELD_LABELS: Readonly<Record<PingField, string>> = {
  allInPings: 'All In',
  assistMePings: 'Assist Me',
  basicPings: 'Ping',
  commandPings: 'On Your Mark',
  dangerPings: 'Danger',
  enemyMissingPings: 'Missing',
  enemyVisionPings: 'Enemy Vision',
  getBackPings: 'Get Back',
  holdPings: 'Hold',
  needVisionPings: 'Vision Needed',
  onMyWayPings: 'On My Way',
  pushPings: 'Push',
  retreatPings: 'Retreat',
  visionClearedPings: 'Vision Cleared',
};

/** Requirement 5. `undefined` when every ping total is zero (5.3). */
export function mostUsedPingOf(matches: readonly IncludedMatch[]): PingTally | undefined {
  const totals: Record<PingField, number> = {
    allInPings: 0,
    assistMePings: 0,
    basicPings: 0,
    commandPings: 0,
    dangerPings: 0,
    enemyMissingPings: 0,
    enemyVisionPings: 0,
    getBackPings: 0,
    holdPings: 0,
    needVisionPings: 0,
    onMyWayPings: 0,
    pushPings: 0,
    retreatPings: 0,
    visionClearedPings: 0,
  };

  for (const match of matches) {
    const self = match.participants?.find((participant) => participant.isAnalyzedPlayer);
    if (self === undefined) {
      continue; // decision 6: no Full_Lobby / no analyzed-player row for this match
    }
    for (const field of PING_FIELD_ORDER) {
      totals[field] += self[field];
    }
  }

  let best: PingField | undefined;
  let bestCount = 0;
  for (const field of PING_FIELD_ORDER) {
    if (totals[field] > bestCount) {
      bestCount = totals[field];
      best = field;
    }
  }
  return best === undefined ? undefined : { field: best, count: bestCount };
}

// ---------------------------------------------------------------------------
// Average KDA
// ---------------------------------------------------------------------------

/** `undefined` for an empty match window — there is nothing to average. */
export function averageKdaFactOf(matches: readonly IncludedMatch[]): number | undefined {
  return matches.length === 0 ? undefined : averageKdaOf(matches);
}

// ---------------------------------------------------------------------------
// Average gold diff at 10
// ---------------------------------------------------------------------------

/**
 * Averages `EarlyGameAggregate.goldDiffAt10` over every entry that has one —
 * `earlyGame` is whatever `player-insights` Phase 2 already computed for
 * Performance Feedback (bounded to `EARLY_GAME_MATCH_LIMIT` most-recent
 * Ranked_Matches, `orchestrator/index.ts#computeEarlyGameAggregates`), reused
 * here rather than fetched again — this fact never triggers a new Riot call.
 * `undefined` when no entry has a non-`null` `goldDiffAt10` (no Lane_Opponent
 * identified in any of them, or none computed at all).
 */
export function averageGoldDiffAt10Of(earlyGame: readonly EarlyGameAggregate[]): number | undefined {
  const values = earlyGame
    .map((entry) => entry.goldDiffAt10)
    .filter((value): value is number => value !== null);
  if (values.length === 0) {
    return undefined;
  }
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface FunFactV2 {
  category: 'nemesis' | 'longestGame' | 'favoriteItems' | 'mostUsedPing' | 'averageKda' | 'averageGoldDiffAt10';
  text: string;
  /** Only present for `favoriteItems` (decision 1) — lets the frontend resolve icons/names. */
  favoriteItems?: readonly FavoriteItem[];
}

/**
 * Requirements 2-5. Pure: the result depends only on `matches`/`lanelessMatches`/
 * `earlyGame`. Produces one statement per eligible category, in the fixed
 * order nemesis, longestGame, favoriteItems, mostUsedPing, averageKda,
 * averageGoldDiffAt10 — no padding, no substitution, matching the removed
 * `computeFunFacts`'s "one per eligible category" shape. `lanelessMatches`/
 * `earlyGame` both default to `[]` so every existing call site/test is
 * unaffected; decision 7 explains why folding `lanelessMatches` in needs no
 * per-category queueType filtering. `averageGoldDiffAt10` reuses whatever
 * `earlyGame` Performance Feedback already computed (see `averageGoldDiffAt10Of`)
 * rather than fetching anything new, so it inherits that computation's own
 * Ranked-only, bounded-to-`EARLY_GAME_MATCH_LIMIT` scope — narrower than every
 * other Fun Fact here, which is the nature of the data it draws from, not a
 * new restriction this function introduces.
 */
export function computeFunFactsV2(
  matches: readonly IncludedMatch[],
  lanelessMatches: readonly LanelessMatch[] = [],
  earlyGame: readonly EarlyGameAggregate[] = [],
): FunFactV2[] {
  const facts: FunFactV2[] = [];
  const allMatches: readonly IncludedMatch[] = [...matches, ...lanelessMatches.map(lanelessAsIncludedMatch)];

  const nemesis = nemesisOf(allMatches);
  if (nemesis !== undefined) {
    facts.push({
      category: 'nemesis',
      text:
        `Your nemesis: ${nemesis.championName}. You're ${nemesis.wins}-${nemesis.losses} ` +
        `(${nemesis.winRatePercent}%) against it over ${nemesis.gamesPlayed} matches.`,
    });
  }

  const longest = longestGameOf(allMatches);
  if (longest !== undefined) {
    facts.push({
      category: 'longestGame',
      text:
        `Longest game: ${formatDurationSeconds(longest.durationSeconds)} on ${longest.championName}, ` +
        `a ${longest.win ? 'win' : 'loss'}.`,
    });
  }

  const items = favoriteItemsOf(allMatches);
  if (items.length > 0) {
    facts.push({
      category: 'favoriteItems',
      // No static-data access here (this module is pure/I/O-free), so the
      // prose can only name the category, not the items themselves. The
      // frontend renders `favoriteItems` (item ids + counts) as the actual
      // list, resolving each id to its real name via the Static_Data_Provider.
      text: `Your most-built item${items.length > 1 ? 's' : ''} across your recent games:`,
      favoriteItems: items,
    });
  }

  const ping = mostUsedPingOf(allMatches);
  if (ping !== undefined) {
    facts.push({
      category: 'mostUsedPing',
      text: `Most-used ping: ${PING_FIELD_LABELS[ping.field]}, used ${ping.count} times.`,
    });
  }

  const kda = averageKdaFactOf(allMatches);
  if (kda !== undefined) {
    facts.push({
      category: 'averageKda',
      text: `Average KDA: ${kda.toFixed(2)} across ${allMatches.length} game${allMatches.length === 1 ? '' : 's'}.`,
    });
  }

  const goldDiff = averageGoldDiffAt10Of(earlyGame);
  if (goldDiff !== undefined) {
    facts.push({
      category: 'averageGoldDiffAt10',
      text:
        `Average gold diff @ 10: ${goldDiff > 0 ? '+' : ''}${goldDiff} gold vs. your lane opponent, ` +
        `across your recent ranked games.`,
    });
  }

  return facts;
}
