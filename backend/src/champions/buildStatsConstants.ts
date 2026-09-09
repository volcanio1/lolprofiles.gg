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
 * Requirement 11.6 (reinterpreted): a modal skill order / rune page / spell pair
 * / starting-items set is emitted when its top value is both a real plurality
 * (`MODAL_MIN_SHARE` of the build's cohort) AND backed by at least
 * `MODAL_MIN_GAMES` games. The original 0.30 share gate hid almost every section
 * at real sample sizes (values are stored as exact sequences, so the top one
 * rarely clears a third of the cohort); the build page now shows the supporting
 * game count next to each section, so a lower share bar plus an absolute floor is
 * the honest trade — the reader can see how thin the evidence is. Interpretation
 * choice, backend-only.
 */
export const MODAL_MIN_SHARE = 0.1;
export const MODAL_MIN_GAMES = 5;

/**
 * `popular` is resolved slot-by-slot (most-built first item, then most-built
 * second item among games that opened with it, and so on) rather than as one
 * exact recorded path — at real sample sizes a single full path is a handful of
 * games while each slot is backed by dozens. Within a slot, the runner-up item
 * is surfaced as a "/" alternative (rendered `A / B`) when it is genuinely
 * competitive: at least `CORE_ITEM_ALT_RATIO` of the leader's games AND at least
 * `CORE_ITEM_ALT_MIN_GAMES` in absolute terms (so noise in a thin cohort does
 * not print a spurious second option). Backend-only tuning — the frontend just
 * renders whatever slots arrive.
 */
export const CORE_ITEM_ALT_RATIO = 0.8;
export const CORE_ITEM_ALT_MIN_GAMES = 3;

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
