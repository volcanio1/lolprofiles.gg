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

import type { RunePage } from '../insight/stats';
import {
  BACKEND_DISPLAY_FLOOR,
  CORE_ITEM_COUNT,
  DEFAULT_RANK,
  DEFAULT_ROLE,
  MIN_SAMPLE,
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

export interface ChampionBuild {
  /** Games played on THIS build (Requirement 5.3.2) — non-negative integer. */
  matchCount: number;
  /** In `[0, 1]` (Requirement 11.3). */
  winRate: number;
  /** In `[0, 1]` — this build's share of the champion's games at these filters. */
  pickRate: number;
  /** Item ids in purchase order, length ≤ `CORE_ITEM_COUNT` (Requirement 11.2). */
  coreItems: readonly number[];
  startingItems: readonly number[] | null;
  /** Modal value within this build's cohort, or `null` below the modal threshold. */
  skillOrder: ChampionSkillOrder | null;
  /** Same shape the match Runes tab consumes; `null` below the modal threshold. */
  runes: RunePage | null;
  summonerSpells: readonly [number, number] | null;
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

// TODO(champion-build-stats-pipeline): MongoChampionStatsStore — reads the
// crawled aggregate documents; its document shape is that spec's to fix.
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

/** The modal cohort value, or `null` when the top value holds less than
 * `MODAL_MIN_SHARE` of the cohort (Requirement 11.6). */
function modalOf<T>(entries: readonly CohortEntry<T>[], cohortGames: number): T | null {
  if (entries.length === 0 || cohortGames <= 0) return null;
  const top = entries.reduce((best, entry) => (entry.games > best.games ? entry : best));
  return top.games / cohortGames >= MODAL_MIN_SHARE ? top.value : null;
}

function toBuild(path: ItemPathAggregate, championGames: number): ChampionBuild {
  return {
    matchCount: path.games,
    winRate: clamp01(path.games > 0 ? path.wins / path.games : 0),
    pickRate: clamp01(championGames > 0 ? path.games / championGames : 0),
    coreItems: path.coreItems.slice(0, CORE_ITEM_COUNT),
    startingItems: modalOf(path.startingItems, path.games),
    skillOrder: modalOf(path.skillOrders, path.games),
    runes: modalOf(path.runePages, path.games),
    summonerSpells: modalOf(path.spellPairs, path.games),
  };
}

/**
 * Pick `popular` (most games) and `highestWinRate` (best win rate among paths
 * with ≥ `MIN_SAMPLE` games) from one aggregate cell. Both `null` when the cell
 * is below `BACKEND_DISPLAY_FLOOR` total games (Requirement 11.5) or has no
 * paths.
 */
export function resolveBuilds(cell: ChampionAggregate | null): {
  popular: ChampionBuild | null;
  highestWinRate: ChampionBuild | null;
} {
  if (cell === null || cell.games < BACKEND_DISPLAY_FLOOR || cell.itemPaths.length === 0) {
    return { popular: null, highestWinRate: null };
  }

  const byGames = [...cell.itemPaths].sort(
    (a, b) => b.games - a.games || joinKey(a.coreItems).localeCompare(joinKey(b.coreItems)),
  );
  const popular = toBuild(byGames[0], cell.games);

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

  return { popular, highestWinRate: toBuild(best, cell.games) };
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
