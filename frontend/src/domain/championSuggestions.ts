/**
 * champion-build-stats — champion rows for the search dropdown, and the URL a
 * champion page lives at (specs/champion-build-stats/ Requirements 1, 3).
 *
 * PURE MODULE. No I/O, no React, no network — `matchChampions` is a bounded scan
 * of the already-loaded champion catalog (Requirement 1.4 / 9.3).
 *
 * The catalog is `useStaticData().championCatalog()` — the `Champion_Key` → entry
 * map, or `null` before the static-data index is ready. (Design.md sketched this
 * as `matchChampions(query, index)`; the real `StaticDataProvider` deliberately
 * hides the raw `StaticDataIndex`, so this takes the champions sub-map instead.)
 */

import type { ChampionEntry } from '../staticData';
import { MIN_QUERY_LENGTH } from './suggestions';
import {
  DEFAULT_RANK,
  DEFAULT_REGION,
  DEFAULT_ROLE,
  type RankBucket,
  type Role,
} from './buildStatsConstants';

/** Requirement 1.3 — the most champion rows shown. */
export const MAX_CHAMPION_SUGGESTIONS = 5;

export interface ChampionSuggestion {
  /** Data Dragon `Champion_Key`, e.g. `MonkeyKing` — URL-path-safe. */
  key: string;
  /** Display name, e.g. `Wukong`. */
  name: string;
}

/** `Champion_Key` → entry — what `useStaticData().championCatalog()` returns. */
export type ChampionCatalog = Readonly<Record<string, ChampionEntry>>;

/**
 * Champion rows for a search-field value (Requirement 1):
 *
 *  - `null` catalog, or a value containing `#`, or (trimmed) shorter than
 *    `MIN_QUERY_LENGTH` → no rows (Requirements 1.1, 1.4, 1.5, 9.1);
 *  - otherwise an anchored, case-insensitive PREFIX match on each entry's
 *    display `name` — not a substring, fuzzy, or `Champion_Key` match
 *    (Requirement 1.2);
 *  - alphabetical by display name, capped at `limit` (Requirement 1.3).
 */
export function matchChampions(
  query: string,
  catalog: ChampionCatalog | null,
  limit: number = MAX_CHAMPION_SUGGESTIONS,
): ChampionSuggestion[] {
  if (catalog === null || query.includes('#')) {
    return [];
  }
  const prefix = query.trim().toLowerCase();
  if (prefix.length < MIN_QUERY_LENGTH) {
    return [];
  }
  return Object.entries(catalog)
    .filter(([, entry]) => entry.name.toLowerCase().startsWith(prefix))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
    .map(([key, entry]) => ({ key, name: entry.name }));
}

export interface ChampionPageFilters {
  role?: Role;
  rank?: RankBucket;
  region?: string;
}

/**
 * The champion page URL (Requirement 3.1/3.3). Only non-default filter values go
 * in the query string, so a bare `/champion/Jinx` is the canonical form.
 */
export function championPathFor(key: string, filters: ChampionPageFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.role !== undefined && filters.role !== DEFAULT_ROLE) {
    params.set('role', filters.role);
  }
  if (filters.rank !== undefined && filters.rank !== DEFAULT_RANK) {
    params.set('rank', filters.rank);
  }
  if (filters.region !== undefined && filters.region !== DEFAULT_REGION) {
    params.set('region', filters.region);
  }
  const query = params.toString();
  return `/champion/${encodeURIComponent(key)}${query ? `?${query}` : ''}`;
}
