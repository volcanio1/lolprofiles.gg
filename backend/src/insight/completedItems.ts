/**
 * champion-build-stats-pipeline: the Summoner's Rift completed-item id set at a
 * pinned Data Dragon version (task 4). Used by the crawler's extractor to reduce
 * a full purchase history to the core build.
 *
 * GENERATED FILE. Regenerate with:
 *
 *     node backend/scripts/generateCompletedItems.mjs
 *
 * Pinned at one version while the crawler aggregates recent patches; an item
 * reworked component<->legendary between the pin and a crawled patch is
 * misclassified. Accepted — regenerate on deploy. See the script for the rule.
 */

export const COMPLETED_ITEMS_DDRAGON_VERSION = '16.17.1';

/** Every SR completed-item id at `COMPLETED_ITEMS_DDRAGON_VERSION`, sorted. */
export const COMPLETED_ITEM_IDS: ReadonlySet<number> = new Set<number>([
  2065, 2501, 2502, 2503, 2504, 2510, 2512, 2517, 2520, 2522, 2523, 2524, 2525, 3003,
  3004, 3026, 3031, 3032, 3033, 3036, 3041, 3046, 3050, 3053, 3065, 3068, 3071, 3072,
  3073, 3074, 3075, 3078, 3083, 3084, 3085, 3087, 3089, 3091, 3094, 3095, 3100, 3102,
  3107, 3109, 3110, 3115, 3116, 3118, 3119, 3124, 3135, 3137, 3139, 3142, 3143, 3146,
  3152, 3153, 3156, 3157, 3161, 3165, 3168, 3170, 3171, 3172, 3173, 3174, 3175, 3179,
  3181, 3190, 3222, 3302, 3504, 3508, 3742, 3748, 3814, 4005, 4401, 4628, 4629, 4633,
  4645, 4646, 6333, 6609, 6610, 6616, 6617, 6620, 6621, 6631, 6653, 6655, 6657, 6662,
  6664, 6665, 6672, 6673, 6675, 6676, 6692, 6694, 6695, 6696, 6697, 6698, 6699, 8010,
  8020,
]);

/** The current tier-3 boot ids (a subset of `COMPLETED_ITEM_IDS`). */
export const BOOT_ITEM_IDS: ReadonlySet<number> = new Set<number>([
  3168, 3170, 3171, 3173, 3174, 3175,
]);

/** Whether `itemId` fills a core build slot (a legendary item or a finished boot). */
export function isCompletedItemId(itemId: number): boolean {
  return COMPLETED_ITEM_IDS.has(itemId);
}
