/**
 * Role performance (profile-sidebar Requirement 8).
 *
 * Per-role games played and win rate over an included-match set. A sibling of
 * `topChampionsOf` / `mostPlayedRoleOf` in `stats.ts` — same `IncludedMatch[]`
 * input, same pure/total contract, no clock, no I/O.
 *
 *  - 8.2: a match's role is read straight from `match.role`, which the
 *    orchestrator's mapping step already set with the same `roleOf` logic
 *    (`teamPosition` falling back to `role`) every other role-relative
 *    computation uses. This module does no classification of its own.
 *  - 8.3: a match whose role is blank (the `roleOf` fallback) is excluded rather
 *    than bucketed under an empty-string role.
 */

import { compareStrings, roundHalfUp, type IncludedMatch } from './stats';

export interface RolePerformanceEntry {
  role: string;
  gamesPlayed: number;
  /**
   * Whole percent. A role bucket is always non-empty by construction, so unlike
   * `winRatePercentOf` this never needs an `'N/A'` branch.
   */
  winRatePercent: number;
}

/**
 * Total order: games played DESC, then win rate DESC, then role name ASC by code
 * unit. Role names are unique across entries, so the third key makes it total.
 * Mirrors `compareChampionSummaries`.
 */
export function compareRolePerformance(a: RolePerformanceEntry, b: RolePerformanceEntry): number {
  if (a.gamesPlayed !== b.gamesPlayed) {
    return b.gamesPlayed - a.gamesPlayed;
  }
  if (a.winRatePercent !== b.winRatePercent) {
    return b.winRatePercent - a.winRatePercent;
  }
  return compareStrings(a.role, b.role);
}

/**
 * Requirement 8.1. One entry per role the player has a determinable role for,
 * ordered by `compareRolePerformance`. An empty input, or one where every match
 * has a blank role, yields `[]` — the caller (Requirement 8.5) renders the
 * "not enough data" message for that.
 */
export function computeRolePerformance(matches: readonly IncludedMatch[]): RolePerformanceEntry[] {
  const byRole = new Map<string, { games: number; wins: number }>();

  for (const match of matches) {
    if (match.role === '') {
      continue; // Requirement 8.3
    }
    const bucket = byRole.get(match.role) ?? { games: 0, wins: 0 };
    bucket.games += 1;
    bucket.wins += match.win ? 1 : 0;
    byRole.set(match.role, bucket);
  }

  const entries: RolePerformanceEntry[] = [];
  for (const [role, { games, wins }] of byRole) {
    entries.push({
      role,
      gamesPlayed: games,
      winRatePercent: roundHalfUp((100 * wins) / games),
    });
  }

  entries.sort(compareRolePerformance);
  return entries;
}
