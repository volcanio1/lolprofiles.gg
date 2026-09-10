/**
 * champion-build-stats — constants the champion build page mirrors from the
 * backend (specs/champion-build-stats/ task 7.2).
 *
 * PURE MODULE. No I/O, no React.
 *
 * `MIN_SAMPLE`, `CORE_ITEM_COUNT` and the Role / Rank_Bucket vocabularies are
 * AUTHORITATIVE on the backend (`backend/src/champions/buildStatsConstants.ts`)
 * and cross-checked by `parity.test.ts`, the same drift guard
 * `domain/suggestions.ts` uses.
 *
 * `DISPLAY_FLOOR` is frontend-only (interpretation choice — Requirement 7.1/7.4):
 * a belt-and-braces lower bound on `meta.overall.totalGames` below which the page
 * shows Not_Enough_Data even if the endpoint returned a `popular` build. It has
 * NO backend counterpart (the backend's own gate is `BACKEND_DISPLAY_FLOOR`,
 * surfaced as `popular: null`) and is deliberately excluded from the parity
 * check.
 */

/** Glossary "Min_Sample": the fewest games a build needs to be the highest-win-rate build. */
export const MIN_SAMPLE = 500;

/** Glossary "Core_Item_Count": completed items + boots that define a build's item path (a full six-slot build). */
export const CORE_ITEM_COUNT = 6;

/** Frontend-only. See module doc — not parity-checked. */
export const DISPLAY_FLOOR = 100;

export type Role = 'ALL' | 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY';

/** Display order for the Role control (Requirement 6.6). */
export const ROLE_VALUES: readonly Role[] = ['ALL', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

export type RankBucket = 'ALL' | 'EMERALD_PLUS' | 'DIAMOND_PLUS' | 'MASTER_PLUS';

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

/** Requirement 6.6: the site's role vocabulary, not the raw `teamPosition` strings. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  ALL: 'All roles',
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'Bottom',
  UTILITY: 'Support',
};

export const RANK_BUCKET_LABELS: Readonly<Record<RankBucket, string>> = {
  ALL: 'All ranks',
  EMERALD_PLUS: 'Emerald+',
  DIAMOND_PLUS: 'Diamond+',
  MASTER_PLUS: 'Master+',
};

/** A region code from `meta.availableRegions` -> a display label (`world` -> `World`). */
export function regionLabel(region: string): string {
  return region === 'world' ? 'World' : region.toUpperCase();
}
