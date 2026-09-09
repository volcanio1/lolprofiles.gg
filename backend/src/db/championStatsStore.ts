/**
 * Champion Stats Store.
 *
 * The persistence layer behind `GET /api/champions/:championKey/build-stats`
 * (specs/champion-build-stats/ Requirements 10-12). It answers one question —
 * "for this champion at these filters, what are the popular and highest-win-rate
 * builds, and the champion's overall numbers" — from pre-aggregated documents.
 * No Riot API call, no lookup orchestration, no rate-limit reservation
 * (Requirement 10.2).
 *
 * Architecturally this is the same storage layer as `rankHistoryStore` /
 * `lookedUpPlayerStore` / `matchStore` (an extension of `specs/database/`): an
 * interface + an in-memory fake + a no-op, with a Mongo implementation to follow.
 *
 * SCOPE (task 2.3): this file defines the interface, an in-memory fake that does
 * the real pick/gate/modal resolution from raw aggregates, and the disabled
 * no-op. `MongoChampionStatsStore` — which reads the crawled aggregate documents
 * and whose document shape belongs to `champion-build-stats-pipeline` — is
 * deliberately NOT here yet. Until it lands the composition root wires the no-op,
 * so the endpoint returns the empty-state response and the page shows
 * Not_Enough_Data everywhere (Requirement 14.1).
 *
 * Pure-ish module, matching the other stores: no network, no environment access,
 * no logging. The in-memory fake resolves immediately but keeps the
 * Promise-returning signature so the Mongo impl drops in without a caller change.
 *
 * `null` vs a result with `popular: null`:
 *  - `getBuildStats` resolves `null` when the store is disabled or has never seen
 *    the champion → the endpoint answers 200 with empty `meta` option lists
 *    (Requirement 12.3), so the page shows Not_Enough_Data and no working filters.
 *  - it resolves a result with `popular: null` when the store knows the champion
 *    but has too little data for the requested filters → the endpoint answers 200
 *    with populated `meta` lists (the filters still work) and Not_Enough_Data copy.
 */

import type { Db } from 'mongodb';
import type { RunePage } from '../insight/stats';
import {
  CHAMPION_BUILD_AGGREGATES_COLLECTION,
  CHAMPION_BUILD_TOTALS_COLLECTION,
} from '../champions/pipeline/constants';
import {
  parseItemPath,
  parseRunePage,
  parseSkillOrder,
  parseSpellPair,
  parseStartingItems,
} from '../champions/pipeline/serialize';
import {
  BACKEND_DISPLAY_FLOOR,
  CORE_ITEM_ALT_MIN_GAMES,
  CORE_ITEM_ALT_RATIO,
  CORE_ITEM_COUNT,
  DEFAULT_RANK,
  DEFAULT_ROLE,
  MIN_SAMPLE,
  MODAL_MIN_GAMES,
  MODAL_MIN_SHARE,
  RANK_BUCKET_VALUES,
  ROLE_VALUES,
  type RankBucket,
  type Role,
} from '../champions/buildStatsConstants';

// ---------------------------------------------------------------------------
// Wire-facing result types (mirrored by frontend/src/api/types.ts, task 10.1)
// ---------------------------------------------------------------------------

export interface ChampionBuildFilters {
  role: Role;
  rank: RankBucket;
  region: string;
}

export interface ChampionSkillOrder {
  /** Ability max order, e.g. `['Q', 'W', 'E']` (Requirement 11.2). */
  maxOrder: readonly ('Q' | 'W' | 'E')[];
  /** One ability (1-4 = Q/W/E/R) per level, in level order. */
  perLevel: readonly (1 | 2 | 3 | 4)[];
}

/**
 * One core-item slot in purchase order: the most-built item for that position,
 * followed by up to one near-equally-built alternative. Index 0 is always the
 * leader; a length-2 slot renders as `A / B`.
 */
export type ChampionCoreItemSlot = readonly number[];

/**
 * A modal sub-section (skill order / runes / spells / starting items) plus how
 * many games in the build's cohort actually used it — the "N games" the build
 * page shows next to each section, mirroring the reference layout. `null` when
 * the top value holds less than `MODAL_MIN_SHARE` of the cohort.
 */
export interface ChampionBuildSection<T> {
  value: T;
  games: number;
}

export interface ChampionBuild {
  /** Games played on THIS build (Requirement 5.3.2) — non-negative integer. */
  matchCount: number;
  /** In `[0, 1]` (Requirement 11.3). */
  winRate: number;
  /** In `[0, 1]` — this build's share of the champion's games at these filters. */
  pickRate: number;
  /**
   * Core item path, one slot per purchase position, length ≤ `CORE_ITEM_COUNT`
   * (Requirement 11.2). For `popular` each slot is resolved independently (most
   * built at that position, anchored on the previous slots' leaders) and may
   * carry a second competitive option; for `highestWinRate` each slot holds the
   * single item from that exact winning path.
   */
  coreItems: readonly ChampionCoreItemSlot[];
  startingItems: ChampionBuildSection<readonly number[]> | null;
  /** Modal value + its cohort game count, or `null` below the modal threshold. */
  skillOrder: ChampionBuildSection<ChampionSkillOrder> | null;
  /** Same shape the match Runes tab consumes; `null` below the modal threshold. */
  runes: ChampionBuildSection<RunePage> | null;
  summonerSpells: ChampionBuildSection<readonly [number, number]> | null;
}

export interface ChampionStatsOverall {
  winRate: number;
  pickRate: number;
  totalGames: number;
}

export interface ChampionStatsMeta {
  patch: string;
  /** Epoch ms; judging "how long ago" is the frontend's job (Requirement 8.1). */
  lastUpdatedAt: number;
  availableRoles: readonly Role[];
  defaultRole: Role;
  availableRanks: readonly RankBucket[];
  defaultRank: RankBucket;
  availableRegions: readonly string[];
  overall: ChampionStatsOverall;
}

export interface ChampionStatsResult {
  meta: ChampionStatsMeta;
  popular: ChampionBuild | null;
  highestWinRate: ChampionBuild | null;
}

// `MongoChampionStatsStore` (further down) reads the crawled aggregate documents;
// `champion-build-stats-pipeline` owns their shape and the crawler that fills them.
export interface ChampionStatsStore {
  /**
   * The build stats for `championKey` at `filters` (already clamped to known
   * values by the caller — Requirement 10.4). `null` when the store is disabled
   * or has never aggregated this champion.
   */
  getBuildStats(
    championKey: string,
    filters: ChampionBuildFilters,
  ): Promise<ChampionStatsResult | null>;
}

// ---------------------------------------------------------------------------
// Raw aggregate shape (the in-memory fake's storage; the crawler pipeline will
// define the Mongo document shape — this is the minimum the resolver needs)
// ---------------------------------------------------------------------------

/** A single value seen within an item-path cohort, with how many games used it. */
export interface CohortEntry<T> {
  value: T;
  games: number;
}

/** One completed-item path and everything aggregated within its cohort. */
export interface ItemPathAggregate {
  /** Completed items + boots, purchase order, length ≤ `CORE_ITEM_COUNT`. */
  coreItems: readonly number[];
  games: number;
  wins: number;
  skillOrders: readonly CohortEntry<ChampionSkillOrder>[];
  runePages: readonly CohortEntry<RunePage>[];
  spellPairs: readonly CohortEntry<readonly [number, number]>[];
  startingItems: readonly CohortEntry<readonly number[]>[];
}

/** One aggregated `(championKey, role, rank, region, patch)` cell. */
export interface ChampionAggregate {
  championKey: string;
  role: Role;
  rank: RankBucket;
  region: string;
  patch: string;
  /** Epoch ms this cell was last folded into. */
  lastUpdatedAt: number;
  games: number;
  wins: number;
  /** Champion pick rate at this role/rank/region, in `[0, 1]` (pipeline-computed). */
  pickRate: number;
  itemPaths: readonly ItemPathAggregate[];
}

// ---------------------------------------------------------------------------
// Resolution (pure) — shared by the in-memory fake and reusable in tests
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** The modal cohort value + its game count, or `null` when the top value is not
 * a real plurality (`MODAL_MIN_SHARE` of the cohort) or is backed by fewer than
 * `MODAL_MIN_GAMES` games (Requirement 11.6). */
function modalOf<T>(
  entries: readonly CohortEntry<T>[],
  cohortGames: number,
): ChampionBuildSection<T> | null {
  if (entries.length === 0 || cohortGames <= 0) return null;
  const top = entries.reduce((best, entry) => (entry.games > best.games ? entry : best));
  if (top.games < MODAL_MIN_GAMES || top.games / cohortGames < MODAL_MIN_SHARE) return null;
  return { value: top.value, games: top.games };
}

/**
 * Merge per-path cohort tallies (skill orders / rune pages / spell pairs /
 * starting items) across several item paths into one list, summing the games for
 * equal values. Deep-equal values collapse; `modalOf` then runs over the union.
 */
function mergeCohorts<T>(lists: readonly (readonly CohortEntry<T>[])[]): CohortEntry<T>[] {
  const byKey = new Map<string, CohortEntry<T>>();
  for (const list of lists) {
    for (const entry of list) {
      const key = JSON.stringify(entry.value);
      const existing = byKey.get(key);
      byKey.set(
        key,
        existing === undefined
          ? { value: entry.value, games: entry.games }
          : { value: existing.value, games: existing.games + entry.games },
      );
    }
  }
  return [...byKey.values()];
}

/**
 * Resolve the core item path slot-by-slot: the most-built first item across the
 * whole cohort, then the most-built second item among paths that opened with
 * that leader, and so on (Requirement 11.2, reinterpreted — a single exact
 * recorded path is only a handful of games at real sample sizes; each slot here
 * is backed by the full cohort). A slot carries its runner-up as a second option
 * when that item is genuinely competitive (`CORE_ITEM_ALT_RATIO` of the leader's
 * games and at least `CORE_ITEM_ALT_MIN_GAMES`).
 */
function anchoredCoreSlots(paths: readonly ItemPathAggregate[]): number[][] {
  const slots: number[][] = [];
  const leaders: number[] = [];
  for (let position = 0; position < CORE_ITEM_COUNT; position += 1) {
    const cohort = paths.filter(
      (path) =>
        path.coreItems.length > position &&
        leaders.every((id, index) => path.coreItems[index] === id),
    );
    if (cohort.length === 0) break;

    const games = new Map<number, number>();
    for (const path of cohort) {
      const id = path.coreItems[position];
      games.set(id, (games.get(id) ?? 0) + path.games);
    }
    const ranked = [...games.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const [leaderId, leaderGames] = ranked[0];
    const slot = [leaderId];
    const runnerUp = ranked[1];
    if (
      runnerUp !== undefined &&
      runnerUp[1] >= CORE_ITEM_ALT_MIN_GAMES &&
      runnerUp[1] / leaderGames >= CORE_ITEM_ALT_RATIO
    ) {
      slot.push(runnerUp[0]);
    }
    slots.push(slot);
    leaders.push(leaderId);
  }
  return slots;
}

/**
 * The `popular` build: anchored core slots, with the headline figures and the
 * modal skill order / runes / spells / starting items taken over the *first-item
 * cohort* — every path that opened with slot 0's item(s). Deeper slots vary too
 * much to define a meaningful "games on this build"; the opening commitment does
 * not, and it is still a large, representative sample.
 */
function toAnchoredBuild(
  paths: readonly ItemPathAggregate[],
  championGames: number,
): ChampionBuild | null {
  const slots = anchoredCoreSlots(paths);
  if (slots.length === 0) return null;

  const openers = slots[0];
  const cohort = paths.filter((path) => openers.includes(path.coreItems[0]));
  const games = cohort.reduce((sum, path) => sum + path.games, 0);
  const wins = cohort.reduce((sum, path) => sum + path.wins, 0);

  return {
    matchCount: games,
    winRate: clamp01(games > 0 ? wins / games : 0),
    pickRate: clamp01(championGames > 0 ? games / championGames : 0),
    coreItems: slots,
    startingItems: modalOf(mergeCohorts(cohort.map((p) => p.startingItems)), games),
    skillOrder: modalOf(mergeCohorts(cohort.map((p) => p.skillOrders)), games),
    runes: modalOf(mergeCohorts(cohort.map((p) => p.runePages)), games),
    summonerSpells: modalOf(mergeCohorts(cohort.map((p) => p.spellPairs)), games),
  };
}

/** The `highestWinRate` build: one exact recorded path, its own cohort modals.
 * Each core slot holds exactly that path's item at that position. */
function toPathBuild(path: ItemPathAggregate, championGames: number): ChampionBuild {
  return {
    matchCount: path.games,
    winRate: clamp01(path.games > 0 ? path.wins / path.games : 0),
    pickRate: clamp01(championGames > 0 ? path.games / championGames : 0),
    coreItems: path.coreItems.slice(0, CORE_ITEM_COUNT).map((id) => [id]),
    startingItems: modalOf(path.startingItems, path.games),
    skillOrder: modalOf(path.skillOrders, path.games),
    runes: modalOf(path.runePages, path.games),
    summonerSpells: modalOf(path.spellPairs, path.games),
  };
}

/**
 * Pick `popular` (anchored slot-by-slot core build) and `highestWinRate` (best
 * win rate among exact paths with ≥ `MIN_SAMPLE` games). Both `null` when the
 * cell is below `BACKEND_DISPLAY_FLOOR` total games (Requirement 11.5) or has no
 * paths.
 */
export function resolveBuilds(cell: ChampionAggregate | null): {
  popular: ChampionBuild | null;
  highestWinRate: ChampionBuild | null;
} {
  if (cell === null || cell.games < BACKEND_DISPLAY_FLOOR || cell.itemPaths.length === 0) {
    return { popular: null, highestWinRate: null };
  }

  const popular = toAnchoredBuild(cell.itemPaths, cell.games);

  const eligible = cell.itemPaths.filter((path) => path.games >= MIN_SAMPLE);
  if (eligible.length === 0) {
    return { popular, highestWinRate: null };
  }
  const best = eligible
    .slice()
    .sort(
      (a, b) =>
        b.wins / b.games - a.wins / a.games ||
        b.games - a.games ||
        joinKey(a.coreItems).localeCompare(joinKey(b.coreItems)),
    )[0];

  return { popular, highestWinRate: toPathBuild(best, cell.games) };
}

function joinKey(items: readonly number[]): string {
  return items.join('-');
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * In-memory `ChampionStatsStore` for tests and single-instance runs without a
 * database. Holds raw `ChampionAggregate` cells and does the real
 * pick/gate/modal resolution, so endpoint and resolution behaviour can be
 * exercised without Mongo or the crawler.
 */
export class InMemoryChampionStatsStore implements ChampionStatsStore {
  private readonly cells: ChampionAggregate[] = [];

  constructor(cells: readonly ChampionAggregate[] = []) {
    this.cells.push(...cells);
  }

  /** Add or replace an aggregate cell (upsert on the full filter key + patch). */
  put(cell: ChampionAggregate): void {
    const index = this.cells.findIndex(
      (c) =>
        c.championKey === cell.championKey &&
        c.role === cell.role &&
        c.rank === cell.rank &&
        c.region === cell.region &&
        c.patch === cell.patch,
    );
    if (index === -1) this.cells.push(cell);
    else this.cells[index] = cell;
  }

  async getBuildStats(
    championKey: string,
    filters: ChampionBuildFilters,
  ): Promise<ChampionStatsResult | null> {
    const forChampion = this.cells.filter((c) => c.championKey === championKey);
    if (forChampion.length === 0) return null;

    const match =
      forChampion.find(
        (c) => c.role === filters.role && c.rank === filters.rank && c.region === filters.region,
      ) ?? null;

    const { popular, highestWinRate } = resolveBuilds(match);

    return {
      meta: {
        patch: pickPatch(forChampion),
        lastUpdatedAt: Math.max(...forChampion.map((c) => c.lastUpdatedAt)),
        availableRoles: sortByReference(unique(forChampion.map((c) => c.role)), ROLE_VALUES),
        defaultRole: mostPlayedRole(forChampion),
        availableRanks: sortByReference(unique(forChampion.map((c) => c.rank)), RANK_BUCKET_VALUES),
        defaultRank: DEFAULT_RANK,
        availableRegions: unique(forChampion.map((c) => c.region)).sort(),
        overall: {
          winRate: clamp01(match && match.games > 0 ? match.wins / match.games : 0),
          pickRate: clamp01(match?.pickRate ?? 0),
          totalGames: match?.games ?? 0,
        },
      },
      popular,
      highestWinRate,
    };
  }

  get size(): number {
    return this.cells.length;
  }
}

export function createInMemoryChampionStatsStore(
  cells: readonly ChampionAggregate[] = [],
): InMemoryChampionStatsStore {
  return new InMemoryChampionStatsStore(cells);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sortByReference<T>(values: readonly T[], reference: readonly T[]): T[] {
  return [...values].sort((a, b) => reference.indexOf(a) - reference.indexOf(b));
}

function mostPlayedRole(cells: readonly ChampionAggregate[]): Role {
  const ranked = cells
    .filter((c) => c.role !== 'ALL')
    .sort((a, b) => b.games - a.games);
  return ranked[0]?.role ?? DEFAULT_ROLE;
}

function pickPatch(cells: readonly ChampionAggregate[]): string {
  return (
    cells.slice().sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)[0]?.patch ?? ''
  );
}

// ---------------------------------------------------------------------------
// MongoDB implementation (champion-build-stats-pipeline)
// ---------------------------------------------------------------------------

interface StoredItemPath {
  games?: number;
  wins?: number;
  skills?: Record<string, number>;
  runes?: Record<string, number>;
  spells?: Record<string, number>;
  starts?: Record<string, number>;
}

interface StoredAggregateDoc {
  _id: string;
  championKey: string;
  role: string;
  rankBucket: string;
  region: string;
  patch: string;
  games?: number;
  wins?: number;
  lastUpdatedAt?: Date;
  itemPaths?: Record<string, StoredItemPath>;
}

interface StoredTotalsDoc {
  _id: string;
  matches?: number;
}

/** `["16.9", "16.17"]` -> `"16.17"` — numeric major.minor, not string order. */
function latestPatchOf(patches: readonly string[]): string | undefined {
  return [...new Set(patches)].sort((a, b) => {
    const [am = 0, an = 0] = a.split('.').map(Number);
    const [bm = 0, bn = 0] = b.split('.').map(Number);
    return bm - am || bn - an;
  })[0];
}

function toCohort<T>(
  map: Record<string, number> | undefined,
  parse: (key: string) => T,
): CohortEntry<T>[] {
  return Object.entries(map ?? {}).map(([key, games]) => ({ value: parse(key), games }));
}

function toChampionAggregate(doc: StoredAggregateDoc): ChampionAggregate {
  return {
    championKey: doc.championKey,
    role: doc.role as Role,
    rank: doc.rankBucket as RankBucket,
    region: doc.region,
    patch: doc.patch,
    lastUpdatedAt: doc.lastUpdatedAt instanceof Date ? doc.lastUpdatedAt.getTime() : 0,
    games: doc.games ?? 0,
    wins: doc.wins ?? 0,
    pickRate: 0, // synthetic — `resolveBuilds` never reads it (overall.pickRate is computed from totals)
    itemPaths: Object.entries(doc.itemPaths ?? {}).map(([key, path]) => ({
      coreItems: parseItemPath(key),
      games: path.games ?? 0,
      wins: path.wins ?? 0,
      skillOrders: toCohort(path.skills, (k) => parseSkillOrder(k) as ChampionSkillOrder),
      runePages: toCohort(path.runes, parseRunePage),
      spellPairs: toCohort(path.spells, parseSpellPair),
      startingItems: toCohort(path.starts, parseStartingItems),
    })),
  };
}

// M0 fetching the fat aggregate docs (a role's ~40-path itemPaths map, ×N roles)
// runs 300-600 ms from a warm connection and longer on a Render dyno sharing the
// pool with the crawler's writes. 500 ms timed every real request out to `null`
// (the page showed Not_Enough_Data for fully-populated champions); 3 s clears the
// observed worst case with headroom. The endpoint is edge-cacheable and not
// latency-critical, so a slow read is worth waiting for.
const READ_TIMEOUT_MS = 3_000;

/**
 * Reads the crawler's aggregate documents and reuses the pure `resolveBuilds` —
 * this class is only I/O around the shared core. Bounded to a few indexed reads
 * with a hard `READ_TIMEOUT_MS`; a slow or failing Mongo resolves to `null`, and
 * the endpoint already degrades `null` to a 200 empty-state.
 */
export class MongoChampionStatsStore implements ChampionStatsStore {
  private readonly aggregates;
  private readonly totals;

  constructor(db: Db) {
    this.aggregates = db.collection<StoredAggregateDoc>(CHAMPION_BUILD_AGGREGATES_COLLECTION);
    this.totals = db.collection<StoredTotalsDoc>(CHAMPION_BUILD_TOTALS_COLLECTION);
  }

  async getBuildStats(
    championKey: string,
    filters: ChampionBuildFilters,
  ): Promise<ChampionStatsResult | null> {
    const run = async (): Promise<ChampionStatsResult | null> => {
      const patchRows = await this.aggregates
        .find({ championKey }, { projection: { patch: 1 } })
        .toArray();
      if (patchRows.length === 0) {
        return null;
      }
      const latestPatch = latestPatchOf(patchRows.map((row) => row.patch));
      if (latestPatch === undefined) {
        return null;
      }

      const [cellDocs, totalsDoc] = await Promise.all([
        this.aggregates.find({ championKey, patch: latestPatch }).toArray(),
        this.totals.findOne({ _id: `${filters.rank}|world|${latestPatch}` }),
      ]);
      const cells = cellDocs.map(toChampionAggregate);
      const cell =
        cells.find(
          (c) => c.role === filters.role && c.rank === filters.rank && c.region === 'world',
        ) ?? null;

      const { popular, highestWinRate } = resolveBuilds(cell);
      const totalMatches = totalsDoc?.matches ?? 0;

      const withGames = cells.filter((c) => c.games > 0);

      return {
        meta: {
          patch: latestPatch,
          lastUpdatedAt: Math.max(0, ...cells.map((c) => c.lastUpdatedAt)),
          availableRoles: sortByReference(unique(withGames.map((c) => c.role)), ROLE_VALUES),
          defaultRole: mostPlayedRole(cells),
          availableRanks: sortByReference(unique(withGames.map((c) => c.rank)), RANK_BUCKET_VALUES),
          defaultRank: DEFAULT_RANK,
          availableRegions: ['world'],
          overall: {
            winRate: clamp01(cell && cell.games > 0 ? cell.wins / cell.games : 0),
            pickRate: clamp01(cell && totalMatches > 0 ? cell.games / totalMatches : 0),
            totalGames: cell?.games ?? 0,
          },
        },
        popular,
        highestWinRate,
      };
    };

    try {
      return await Promise.race([
        run(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), READ_TIMEOUT_MS).unref?.();
        }),
      ]);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Disabled no-op
// ---------------------------------------------------------------------------

/**
 * The store when the aggregate source is unavailable — no `MONGODB_URI`, or the
 * crawler pipeline not yet built. `getBuildStats` is always `null`, so the
 * endpoint returns the empty-state response and the page shows Not_Enough_Data
 * everywhere (Requirements 12.3, 14.1). This is the impl the composition root
 * wires today.
 */
export function createNoopChampionStatsStore(): ChampionStatsStore {
  return {
    async getBuildStats() {
      return null;
    },
  };
}
