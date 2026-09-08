/**
 * champion-build-stats — shared numeric + vocabulary constants for the
 * `GET /api/champions/:championKey/build-stats` endpoint
 * (specs/champion-build-stats/ task 1.1).
 *
 * PURE MODULE. No I/O, no environment access, no logging.
 *
 * `MIN_SAMPLE`, `CORE_ITEM_COUNT` and the Role / Rank_Bucket vocabularies are
 * mirrored by `frontend/src/domain/buildStatsConstants.ts` and cross-checked by
 * `frontend/src/domain/parity.test.ts`, exactly as `MIN_QUERY_LENGTH` /
 * `MAX_SUGGESTIONS` are (Requirement 13.1).
 *
 * `BACKEND_DISPLAY_FLOOR` and `MODAL_MIN_SHARE` are this spec's own
 * interpretation choices (design.md Open Questions), NOT values the requirements
 * or Riot fix. They decide only which builds / sub-sections the endpoint is
 * willing to surface, and are deliberately NOT part of the frontend parity check
 * — the frontend keeps its own, separately-tuned `DISPLAY_FLOOR`.
 */

/**
 * Glossary "Min_Sample": the fewest games a build needs to be eligible as the
 * highest-win-rate build (Requirement 11.4).
 */
export const MIN_SAMPLE = 500;

/**
 * Glossary "Core_Item_Count": how many completed items + boots define a build's
 * item path (Requirement 11.2 — "length ≤ Core_Item_Count").
 */
export const CORE_ITEM_COUNT = 3;

/**
 * Requirement 11.5: `popular` is `null` when the champion / filter combination
 * has fewer than this many recorded games. Interpretation choice.
 */
export const BACKEND_DISPLAY_FLOOR = 100;

/**
 * design.md "Store": the smallest share of an item-path cohort a skill order /
 * rune page / spell pair must hold to be emitted rather than `null`
 * (Requirement 11.6). Interpretation choice.
 */
export const MODAL_MIN_SHARE = 0.3;

export type Role = 'ALL' | 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY';

/** Riot `teamPosition` values plus `ALL`. Order is display order (Requirement 6.6). */
export const ROLE_VALUES: readonly Role[] = ['ALL', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

export type RankBucket = 'ALL' | 'EMERALD_PLUS' | 'DIAMOND_PLUS' | 'MASTER_PLUS';

/**
 * v1 rank buckets. design.md "Pipeline" calls this a v1 *recommendation*; adopted
 * here as the shipped set (flagged for confirmation in tasks.md, choice 4).
 */
export const RANK_BUCKET_VALUES: readonly RankBucket[] = [
  'ALL',
  'EMERALD_PLUS',
  'DIAMOND_PLUS',
  'MASTER_PLUS',
];

export const DEFAULT_ROLE: Role = 'ALL';
export const DEFAULT_RANK: RankBucket = 'ALL';
/** Requirement 6.5.3 — region default; v1 advertises only this one. */
export const DEFAULT_REGION = 'world';

/**
 * Requirement 10.4: an unknown filter value is clamped to that filter's default,
 * never answered with a 400. `role` / `rank` clamp against a closed vocabulary
 * here; `region` is further validated by the handler against the store's
 * advertised `meta.availableRegions` (v1: `['world']`).
 */
export function clampRole(value: string | undefined): Role {
  return (ROLE_VALUES as readonly string[]).includes(value ?? '') ? (value as Role) : DEFAULT_ROLE;
}

export function clampRank(value: string | undefined): RankBucket {
  return (RANK_BUCKET_VALUES as readonly string[]).includes(value ?? '')
    ? (value as RankBucket)
    : DEFAULT_RANK;
}

export function clampRegion(value: string | undefined, available: readonly string[] = [DEFAULT_REGION]): string {
  return value !== undefined && available.includes(value) ? value : DEFAULT_REGION;
}
