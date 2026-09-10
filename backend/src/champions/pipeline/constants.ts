/**
 * champion-build-stats-pipeline: tuning constants (tasks 7, 9, 10, 12, 13).
 *
 * DRIVER-IMPORT-FREE — no `mongodb` import — matching `backend/src/db/collections.ts`.
 * MongoDB index creation lives in `db/client.ts`; this file is only names + numbers.
 *
 * None of these are env-configurable (Req 7.5) — the six operational knobs live
 * in `config/index.ts`. Changing one of these is a code change with a test.
 */

// --- MongoDB collection names --------------------------------------------

export const CHAMPION_BUILD_AGGREGATES_COLLECTION = 'champion_build_aggregates';
export const CHAMPION_BUILD_TOTALS_COLLECTION = 'champion_build_totals';
export const CRAWL_SEEDS_COLLECTION = 'crawl_seeds';
export const CRAWL_PROCESSED_COLLECTION = 'crawl_processed';
export const CRAWL_STATE_COLLECTION = 'crawl_state';

// --- retention / storage bounds ---------------------------------------

/** `crawl_processed` TTL — longer than any match stays fetchable in a 20-deep list. */
export const PROCESSED_TTL_SECONDS = 120 * 24 * 60 * 60;
/** Keep aggregate/totals docs for the newest N patches; older are pruned opportunistically. */
export const KEEP_PATCHES = 2;
/** Cap per frequency sub-map (item paths, and each nested skill/rune/spell/start map). */
export const MAX_FREQ_KEYS = 40;

// --- seeding -----------------------------------------------------------

/** Re-walk the ladders only when the freshest seed is older than this. */
export const SEED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Platforms whose Solo-Queue ladders make up `region='world'` in v1. */
export const SEED_PLATFORMS = ['euw1', 'na1', 'kr'] as const;
/** Cap on ladder entries persisted in one refresh, across all platforms + tiers. */
export const MAX_SEED_ENTRIES_PER_REFRESH = 1500;

// --- extraction ------------------------------------------------------

/** A buy at or before this game time (ms) counts as a starting-base purchase. */
export const STARTING_ITEMS_CUTOFF_MS = 90_000;
/**
 * Never counted as starting items: the free trinket every player opens with, and
 * the control ward (a vision buy, not a build choice). Health / Refillable /
 * Corrupting potions ARE kept — starting a Doran's + potions, a Corrupting
 * Potion, or a Refillable is a real build decision the page should show, the way
 * the in-game shop and other build sites present it.
 */
export const STARTING_EXCLUDED_ITEM_IDS: ReadonlySet<number> = new Set([
  3340, 3363, 3364, // trinkets (warding / farsight / oracle)
  2055, // control ward
]);

/** Queue id this pipeline crawls — Ranked Solo/Duo, Summoner's Rift. */
export const RANKED_SOLO_QUEUE_ID = 420;

// --- rank buckets ---------------------------------------------------

export type RankBucket = 'ALL' | 'EMERALD_PLUS' | 'DIAMOND_PLUS' | 'MASTER_PLUS';

/**
 * A seed player's raw League-V4 tier -> the buckets each of their matches is
 * folded into, so the `_PLUS` labels are honest (an Emerald game does not
 * appear in `DIAMOND_PLUS`, a Diamond game appears in both).
 */
export function bucketsForTier(tier: string): RankBucket[] {
  const t = tier.toUpperCase();
  if (t === 'EMERALD') return ['EMERALD_PLUS', 'ALL'];
  if (t === 'DIAMOND') return ['EMERALD_PLUS', 'DIAMOND_PLUS', 'ALL'];
  if (t === 'MASTER' || t === 'GRANDMASTER' || t === 'CHALLENGER') {
    return ['EMERALD_PLUS', 'DIAMOND_PLUS', 'MASTER_PLUS', 'ALL'];
  }
  return ['ALL'];
}
